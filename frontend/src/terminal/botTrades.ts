// Bot trade records (worker/src/bot_trades.ts): the Trades filters (?bot=, ?signal=), the Performance bot filter and
// the bot trade proof page. Read-only; every figure is the ledger's own.

import type { TradeRow } from "./types";
import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Fleet } from "./bots";

export interface BotTradeRow {
  trade_id: string; /** legacy ledger only: trades.id (its proof page and chart) */ legacy_id?: number; bot_id: string; ledger: "bot" | "legacy"; symbol: string; side: string; status: string; qty: number;
  entry_price: number; exit_price: number | null; opened_at: string; closed_at: string | null;
  gross_usd: number | null; fees_usd: number | null; net_usd: number | null; swept_usd: number | null; stop: number | null; tp: number | null; proof_url: string;
  story?: import("./tradeStory").TradeStory | null;
}
export interface BotOrderRow { order_id: string; bot_id: string; action: string; symbol: string; requested_qty: number | null; status: string; code: string; message: string | null; trade_id: string | null; received_at: string }
export interface SignalRow { id: number; alert_id: string; received_at: string; symbol: string; action: string; status: string; response_code: string | null; rejection_reason: string | null; bot_id: string | null }
/** How much of the history a response holds: `total` trades exist for the filter; `returned` are in this page. */
export interface BotTradesPage { limit: number; returned: number; total: number | null; truncated: boolean }
export interface BotTrades { available: boolean; filter?: { bot: string | null; signal: string | null }; trades: BotTradeRow[]; orders: BotOrderRow[]; signals: SignalRow[]; page?: BotTradesPage }

export const BOT_ID_RE = /^ALPHA-\d{2}$/;
export const SIGNAL_RE = /^[A-Za-z0-9:_.-]{1,160}$/;

/** Reads ?bot= and ?signal= safely: anything malformed is ignored (never sent). */
export function tradeFilter(params: URLSearchParams): { bot: string | null; signal: string | null } {
  const bot = params.get("bot"), signal = params.get("signal");
  return { bot: bot && BOT_ID_RE.test(bot) ? bot : null, signal: signal && SIGNAL_RE.test(signal) ? signal : null };
}

/** Current Worker payload lookups bind two ids per closed trade; stay inside D1's 100-variable budget. */
export const RECENT_TRADE_LIMIT = 50;
const numberOrNull = (v: unknown): number | null => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

export function legacyHistoryRows(rows: (TradeRow & { story?: import("./tradeStory").TradeStory | null })[], f: { bot?: string | null; signal?: string | null }): BotTradeRow[] {
  return rows.flatMap(t => {
    if (t.source !== "ALPHA_PAPER" || !String(t.open_alert_id ?? "").startsWith("ENG-SOLUSD-5-")) return [];
    if (f.bot && f.bot !== "ALPHA-02") return [];
    if (f.signal && f.signal !== t.open_alert_id && f.signal !== t.close_alert_id && f.signal !== String(t.id)) return [];
    const qty = numberOrNull(t.entry_qty), entry = numberOrNull(t.entry_avg_price);
    if (qty === null || entry === null) return [];
    return [{ legacy_id: t.id, trade_id: t.open_alert_id ?? String(t.id), bot_id: "ALPHA-02", ledger: "legacy" as const, symbol: t.symbol,
      side: t.direction.toUpperCase(), status: t.status, qty, entry_price: entry, exit_price: numberOrNull(t.exit_avg_price),
      opened_at: t.opened_at, closed_at: t.closed_at, gross_usd: numberOrNull(t.gross_pnl ?? t.realized_pnl),
      fees_usd: numberOrNull(t.fees_usd), net_usd: t.status === "CLOSED" ? numberOrNull(t.realized_pnl) : null,
      swept_usd: null, stop: null, tp: null, proof_url: `/trades/${t.id}`, story: t.story ?? null }];
  });
}

export async function fetchBotTrades(f: { bot?: string | null; signal?: string | null; limit?: number }): Promise<BotTrades> {
  const q = new URLSearchParams();
  if (f.bot) q.set("bot", f.bot);
  if (f.signal) q.set("signal", f.signal);
  const limit = Math.min(RECENT_TRADE_LIMIT, Math.max(1, f.limit ?? RECENT_TRADE_LIMIT));
  q.set("limit", String(limit));
  // Known backend issue: its legacy bot query selects obsolete column names and returns no rows.
  // Use the existing authoritative legacy route; never reconstruct trades from engine simulation.
  const [env, legacy] = await Promise.all([
    api.get<{ ok: boolean; data?: BotTrades; code?: string; message?: string }>(`/api/dashboard/bot-trades?${q}`),
    !f.bot || f.bot === "ALPHA-02" ? api.get<{ ok: boolean; data: (TradeRow & { story?: import("./tradeStory").TradeStory | null })[] }>(`/api/dashboard/trades?limit=${limit}`) : Promise.resolve(null),
  ]);
  if (!env?.ok || !env.data) throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected bot trades response");
  if (legacy && (!legacy.ok || !Array.isArray(legacy.data))) throw new ApiError(502, "BAD_RESPONSE", "Legacy history unavailable");
  const combined = [...env.data.trades, ...legacyHistoryRows(legacy?.data ?? [], f)];
  const trades = [...new Map(combined.map(t => [`${t.ledger}:${t.trade_id}`, t])).values()].sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  return { ...env.data, trades };
}

// ---------------------------------------------------------------------------------------------------------------------
// ONE shared, cached source for /api/dashboard/bot-trades per filter (Trades all-bot view, Trades filters, Performance).
//   * one request in flight per filter; responses applied in REQUEST order (an older one never overwrites a newer one);
//   * the last good snapshot is kept when a refresh fails, marked stale with its real age;
//   * refreshes when the shared fleet snapshot shows the ledger changed (a fill, a close, a new open position), so a
//     trade that settles while the owner stays on the page appears without leaving it; plus a slow visible-only poll
//     as a fallback (rejections do not change the fleet summary). No per-component poller.
// 50: the Worker's story lookup binds two ids per trade in one IN (...) list, and D1 allows 100 bound parameters, so
// pages over 50 fail with "too many SQL variables" (reported to the backend owner). Lifetime figures never depend on
// this page size; the list says "Showing the latest N of M".
export const BOT_TRADES_LIMIT = 50;
export const BOT_TRADES_POLL_MS = 60_000;
export interface BotTradesSnapshot { data: BotTrades | null; error: string | null; fetchedAt: number | null; stale: boolean }
type Filter = { bot: string | null; signal: string | null };
export const filterKey = (f: Filter) => `${f.bot ?? ""}|${f.signal ?? ""}`;

/** What, in the fleet snapshot, changes whenever a bot's trade history changes. */
export function ledgerSignature(fleet: Fleet | null): string {
  if (!fleet?.available) return "";
  return fleet.bots.map((b) => `${b.bot_id}:${b.paper.trades}:${b.paper.net_usd.toFixed(6)}:${b.open_positions.map((p) => p.trade_id).join(",")}:${b.engine?.strategy_state?.pending_order ? `${b.engine.strategy_state.pending_order.side}@${b.engine.strategy_state.pending_order.limit}` : ""}`).join(";");
}

export function createBotTradesStore(fetcher: (f: Filter & { limit: number }) => Promise<BotTrades> = (f) => fetchBotTrades(f), clock: () => number = Date.now) {
  const entries = new Map<string, { snap: BotTradesSnapshot; seq: number; applied: number; inflight: Promise<void> | null; subs: Set<(s: BotTradesSnapshot) => void>; filter: Filter }>();
  const empty: BotTradesSnapshot = { data: null, error: null, fetchedAt: null, stale: false };
  const entry = (f: Filter) => {
    const k = filterKey(f);
    let e = entries.get(k);
    if (!e) { e = { snap: empty, seq: 0, applied: 0, inflight: null, subs: new Set(), filter: { bot: f.bot, signal: f.signal } }; entries.set(k, e); }
    return e;
  };
  function refresh(f: Filter, force = false): Promise<void> {
    const e = entry(f);
    if (e.inflight && !force) return e.inflight;
    const mine = ++e.seq;
    const p = fetcher({ ...e.filter, limit: BOT_TRADES_LIMIT }).then(
      (data) => { if (mine > e.applied) { e.applied = mine; e.snap = { data, error: null, fetchedAt: clock(), stale: false }; e.subs.forEach((fn) => fn(e.snap)); } },
      (err) => { if (mine > e.applied) { e.applied = mine; e.snap = { ...e.snap, error: String((err as Error)?.message ?? err), stale: e.snap.data !== null }; e.subs.forEach((fn) => fn(e.snap)); } },
    ).finally(() => { if (e.inflight === p) e.inflight = null; });
    e.inflight = p;
    return p;
  }
  return {
    get: (f: Filter) => entry(f).snap,
    refresh,
    /** Refetch every filter someone is looking at (after the ledger changed). */
    refreshActive: () => Promise.all([...entries.values()].filter((e) => e.subs.size).map((e) => refresh(e.filter, true))).then(() => undefined),
    subscribe(f: Filter, fn: (s: BotTradesSnapshot) => void) { const e = entry(f); e.subs.add(fn); return () => { e.subs.delete(fn); }; },
    subscribers: () => [...entries.values()].reduce((n, e) => n + e.subs.size, 0),
  };
}

const tradesStore = createBotTradesStore();
let tradesTimer: ReturnType<typeof setInterval> | null = null;
let lastSig: string | null = null;
const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";
const wake = () => { if (isVisible()) void tradesStore.refreshActive(); };
function startTrades() {
  if (tradesTimer || typeof window === "undefined") return;
  tradesTimer = setInterval(() => { if (isVisible()) void tradesStore.refreshActive(); }, BOT_TRADES_POLL_MS);
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);
}
function stopTrades() {
  if (!tradesTimer) return;
  clearInterval(tradesTimer); tradesTimer = null;
  window.removeEventListener("online", wake);
  document.removeEventListener("visibilitychange", wake);
}
/** Called with every fleet snapshot: when a bot's trades changed, every visible trade list refetches once. */
export function noteFleetForTrades(fleet: Fleet | null) {
  const sig = ledgerSignature(fleet);
  if (!sig) return;
  if (lastSig !== null && sig !== lastSig) void tradesStore.refreshActive();
  lastSig = sig;
}
/** After an owner action that changes trades or wallets. */
export const invalidateBotTrades = () => tradesStore.refreshActive();

/** The shared, auto-refreshing bot trade records for a filter. Keeps showing the last good data while refreshing. */
export function useBotTrades(filter: Filter, fleet?: Fleet | null): BotTradesSnapshot & { refresh: () => void } {
  const key = filterKey(filter);
  const [s, setS] = useState<BotTradesSnapshot & { key: string }>({ ...tradesStore.get(filter), key });
  useEffect(() => {
    setS({ ...tradesStore.get(filter), key });
    const off = tradesStore.subscribe(filter, snap => setS({ ...snap, key }));
    startTrades();
    const cur = tradesStore.get(filter);
    if (!cur.fetchedAt || Date.now() - cur.fetchedAt > BOT_TRADES_POLL_MS / 2) void tradesStore.refresh(filter);
    return () => { off(); if (tradesStore.subscribers() === 0) stopTrades(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const sig = ledgerSignature(fleet ?? null);
  useEffect(() => { if (fleet !== undefined) noteFleetForTrades(fleet); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...(s.key === key ? s : tradesStore.get(filter)), refresh: () => void tradesStore.refresh(filter, true) };
}

export interface ProofCheck { name: string; ok: boolean; detail: string }
export interface BotTradeProof {
  bot: { bot_id: string; name: string; symbol: string; timeframe_min: number; profile: string | null; inputs_hash: string | null; wallet: string } | null;
  position: Record<string, unknown> & { trade_id: string; bot_id: string; side: string; status: string; qty: number; entry_price: number; exit_price: number | null; opened_at: string; closed_at: string | null;
    stop: number | null; tp: number | null; entry_fee_usd: number | null; exit_fee_usd: number | null; collateral_usd: number | null; gross_usd: number | null; net_usd: number | null; swept_usd: number | null; shortfall_usd: number | null; fee_model: string };
  orders: { order_id: string; action: string; requested_qty: number | null; status: string; code: string; message: string | null; received_at: string;
    engine_payload: { stop: number | null; tp: number | null; risk_usd: number | null; timestamp: string | null; profile: string | null; config_hash: string | null; qty: number | null } | null }[];
  fills: { fill_id: string; kind: string; side: string; qty: number; price: number; notional_usd: number; fee_usd: number; fee_rate_pct: number; fee_model: string; price_source: string; price_at: string; filled_at: string }[];
  wallet_entries: { entry_key: string; kind: string; wallet: string; available_change_usd: number; reserved_change_usd: number; note: string | null; created_at: string }[];
  events: { kind: string; occurred_at: string; url: string | null }[];
  checks: ProofCheck[];
  all_checks_ok: boolean;
  story?: import("./tradeStory").TradeStory | null;
  labels: { mode: string; fee_model: string; short_model: string | null };
}

export async function fetchBotTradeProof(id: string): Promise<BotTradeProof | null> {
  try {
    const env = await api.get<{ ok: boolean; data?: BotTradeProof; code?: string }>(`/api/dashboard/bot-trade?id=${encodeURIComponent(id)}`);
    return env?.ok && env.data ? env.data : null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

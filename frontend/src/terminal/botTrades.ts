// Bot trade records (worker/src/bot_trades.ts): the Trades filters (?bot=, ?signal=), the Performance bot filter and
// the bot trade proof page. Read-only; every figure is the ledger's own.

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

export async function fetchBotTrades(f: { bot?: string | null; signal?: string | null; limit?: number }): Promise<BotTrades> {
  const q = new URLSearchParams();
  if (f.bot) q.set("bot", f.bot);
  if (f.signal) q.set("signal", f.signal);
  q.set("limit", String(f.limit ?? 100));
  const env = await api.get<{ ok: boolean; data?: BotTrades; code?: string; message?: string }>(`/api/dashboard/bot-trades?${q}`);
  if (!env?.ok || !env.data) throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected bot trades response");
  return env.data;
}

// ---------------------------------------------------------------------------------------------------------------------
// ONE shared, cached source for /api/dashboard/bot-trades per filter (Trades all-bot view, Trades filters, Performance).
//   * one request in flight per filter; responses applied in REQUEST order (an older one never overwrites a newer one);
//   * the last good snapshot is kept when a refresh fails, marked stale with its real age;
//   * refreshes when the shared fleet snapshot shows the ledger changed (a fill, a close, a new open position), so a
//     trade that settles while the owner stays on the page appears without leaving it; plus a slow visible-only poll
//     as a fallback (rejections do not change the fleet summary). No per-component poller.
export const BOT_TRADES_LIMIT = 200;
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
  const [s, setS] = useState<BotTradesSnapshot>(tradesStore.get(filter));
  useEffect(() => {
    setS(tradesStore.get(filter));
    const off = tradesStore.subscribe(filter, setS);
    startTrades();
    const cur = tradesStore.get(filter);
    if (!cur.fetchedAt || Date.now() - cur.fetchedAt > BOT_TRADES_POLL_MS / 2) void tradesStore.refresh(filter);
    return () => { off(); if (tradesStore.subscribers() === 0) stopTrades(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const sig = ledgerSignature(fleet ?? null);
  useEffect(() => { if (fleet !== undefined) noteFleetForTrades(fleet); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...s, refresh: () => void tradesStore.refresh(filter, true) };
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

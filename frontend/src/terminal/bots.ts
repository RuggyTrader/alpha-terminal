// The bot fleet (docs/MULTI-BOT-ARCHITECTURE.md): data from GET /api/dashboard/bots (worker/src/bots.ts) and the
// owner's authenticated actions (worker/src/bot_ledger.ts). Every figure comes from the Worker: the bot's OWN wallet and
// ledger rows, and the bot's own latest engine report. Hypothetical Strategy Mirror results are a separate field and are
// never added to PAPER figures. Nothing is estimated here; missing data stays missing.

import { level } from "./fmt";
import { api, ApiError } from "../api/client";

export interface StrategyState {
  direction: "LONG" | "SHORT" | null;
  leg_start: number | null;
  leg_end: number | null;
  setup_bars: number | null;
  max_age_bars: number | null;
  pending_order: { side: "LONG" | "SHORT"; qty: number; limit: number | null; stop: number | null; tp: number | null;
    score?: number | null; confluence?: string[]; placed_at?: string | null; ote_705?: number | null } | null;
  current_stop: number | null;
  break_even_done: boolean;
  trailing: boolean;
}

export interface BotEngineReport {
  bot_id?: string | null;
  timeframe?: string | null;
  status_text?: string | null;
  last_candle_time?: string | null;
  last_candle_close?: number | null;
  last_poll_at?: string | null;
  received_at?: string | null;
  position?: { side: string; qty: number; entry: number | null; stop: number | null; tp2?: number | null } | null;
  strategy_state?: StrategyState | null;
  ledger_check?: { status?: string; issues?: string[] } | null;
  sizing?: { mode?: string; risk_usd?: number | null; capital_usd?: number | null; last?: { status?: string; code?: string | null; qty?: number | null; risk_actual_usd?: number | null; notional_usd?: number | null; capped?: boolean; explanation?: string | null } | null } | null;
  last_error?: { at?: string; message?: string } | null;
}

export interface OpenPosition {
  trade_id: string; symbol: string; side: "LONG" | "SHORT"; qty: number; entry_price: number; stop: number | null; tp: number | null;
  collateral_usd: number; entry_fee_usd?: number; opened_at: string; mark_price: number | null; mark_at: string | null; risk_usd?: number | null;
}

export interface Bot {
  bot_id: string;
  name: string;
  group: string;
  symbol: string;
  timeframe: string;
  profile: string | null;
  inputs_hash: string | null;
  status: "ACTIVE" | "PROPOSED" | "DISABLED";
  ledger_api: "bot" | "legacy";
  entries_paused: boolean;
  wallet: string;
  risk_usd: number;
  risk_setting: { version: number; risk_usd: number; status: "PENDING" | "APPLIED" | "SUPERSEDED"; requested_at: string; applied_at: string | null } | null;
  balances: { available_usd: number; reserved_usd: number; shortfall_usd: number };
  funding: { allocated_usd: number; transferred_in_usd: number; withdrawn_usd: number; profit_swept_to_main_usd: number };
  open_positions: OpenPosition[];
  paper: {
    trades: number; long_trades: number; short_trades: number; wins: number; losses: number; break_even: number;
    gross_usd: number; fees_usd: number; net_usd: number; win_rate: number | null; profit_factor: number | null; expectancy_usd: number | null; max_drawdown_usd: number;
  };
  mirror: { account_id: string; trades: number; gross: number; net_modelled: number; last_candle_time: string | null; hypothetical: true }[];
  engine: BotEngineReport | null;
}

export interface Fleet {
  available: boolean;
  generated_at?: string;
  main?: { available_usd: number; profit_received_usd: number };
  groups: { group_id: string; name: string; symbol: string }[];
  bots: Bot[];
}

export async function fetchBots(): Promise<Fleet> {
  const env = await api.get<{ ok: boolean; data?: Fleet; code?: string; message?: string }>("/api/dashboard/bots");
  if (!env?.ok || !env.data || !Array.isArray(env.data.bots)) throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected bots response");
  return env.data;
}

// ---- owner actions (authenticated session + the passphrase typed again; each with a fresh request id) ----
export interface ActionResult { ok: boolean; code?: string; message?: string; duplicate?: boolean; [k: string]: unknown }
export const previewAllocation = (group: string, amount: number) =>
  api.get<{ ok: boolean; data?: { group: string; amount_usd: number; main_available_usd: number; affordable: boolean; split: { bot_id: string; amount_usd: number; wallet?: string }[] }; code?: string }>(
    `/api/dashboard/allocation-preview?group=${encodeURIComponent(group)}&amount=${encodeURIComponent(String(amount))}`);
export const allocate = (group: string, amountUsd: number, requestId: string, passphrase: string) =>
  api.post<ActionResult>("/api/paper/allocate", { group, amount_usd: amountUsd, request_id: requestId, passphrase });
export const setBotRisk = (botId: string, riskUsd: number, requestId: string, passphrase: string) =>
  api.post<ActionResult>("/api/paper/bot-risk", { bot_id: botId, risk_usd: riskUsd, request_id: requestId, passphrase });
/** Stage S1 (owner approval): move the legacy bot to the bot ledger (LONG + simulated SHORT). Only while it is flat. */
export const switchToBotLedger = (botId: string, requestId: string, passphrase: string) =>
  api.post<ActionResult>("/api/paper/bot-ledger", { bot_id: botId, ledger: "bot", request_id: requestId, passphrase });
/** Stage D (owner approval): activate a PROPOSED bot with its registered profile (LONG + SHORT by default). */
export const activateBot = (botId: string, requestId: string, passphrase: string) =>
  api.post<ActionResult>("/api/paper/bot-activate", { bot_id: botId, request_id: requestId, passphrase });
/** One owner approval for the whole fleet: activate every PROPOSED bot and top every bot's wallet up to target_usd from
 *  MAIN, in one transaction (a bot already at the target receives nothing). */
export const fleetSetup = (targetUsd: number, requestId: string, passphrase: string) =>
  api.post<ActionResult>("/api/paper/fleet-setup", { target_usd: targetUsd, request_id: requestId, passphrase });
export const setEntriesPaused = (botId: string, paused: boolean, requestId: string, passphrase: string) =>
  api.post<ActionResult>("/api/paper/bot-entries", { bot_id: botId, paused, request_id: requestId, passphrase });

export type BotState = "DISABLED" | "PROPOSED" | "PAUSED" | "ONLINE" | "STALE" | "OFFLINE" | "NO_REPORT";

/**
 * A bot's state from real telemetry only: its registry status, its paused flag and the age of ITS OWN latest engine
 * report (ONLINE within two of its candles + 2 min, STALE within 30 min, otherwise OFFLINE; no report = NO_REPORT).
 */
export function botState(b: Pick<Bot, "status" | "timeframe" | "entries_paused" | "engine">, nowMs: number): BotState {
  if (b.status === "DISABLED") return "DISABLED";
  if (b.status === "PROPOSED") return "PROPOSED";
  const at = Date.parse(String(b.engine?.received_at ?? ""));
  if (!Number.isFinite(at)) return "NO_REPORT";
  const tf = Number(String(b.timeframe).replace(/\D/g, "")) || 5;
  const age = Math.max(0, (nowMs - at) / 1000);
  const live = age <= tf * 120 + 120 ? "ONLINE" : age <= 1800 ? "STALE" : "OFFLINE";
  return live === "ONLINE" && b.entries_paused ? "PAUSED" : live;
}

export const STATE_TONE: Record<BotState, "ok" | "warn" | "bad" | "muted"> = {
  ONLINE: "ok", PAUSED: "warn", STALE: "warn", OFFLINE: "bad", NO_REPORT: "muted", PROPOSED: "muted", DISABLED: "muted",
};

/** The pipeline phase of one bot, from its structured state (never parsed from free text). */
export function botPhase(b: Bot, nowMs: number): { phase: string; detail: string | null; live: boolean } {
  const s = botState(b, nowMs);
  if (s === "PROPOSED") return { phase: "Proposed, not running", detail: null, live: false };
  if (s === "DISABLED") return { phase: "Disabled", detail: null, live: false };
  if (s === "NO_REPORT") return { phase: "No engine report yet", detail: null, live: false };
  if (s === "OFFLINE") return { phase: "Offline", detail: b.engine?.received_at ? `last report ${b.engine.received_at.slice(11, 16)} UTC` : null, live: false };
  const pos = b.open_positions[0];
  if (pos) return { phase: `Managing ${pos.side}`, detail: `${pos.qty} @ ${pos.entry_price}${pos.stop ? ` · stop ${pos.stop}` : ""}`, live: s === "ONLINE" };
  // Bot ledger: a position only the engine holds comes from its warm-up history (never sent, never a PAPER trade).
  if (b.ledger_api === "bot" && b.engine?.position) return { phase: "Waiting for the next setup", detail: "the strategy is finishing a trade from its warm-up history (not a PAPER trade)", live: s === "ONLINE" };
  const st = b.engine?.strategy_state;
  if (st?.pending_order) {
    const o = st.pending_order;
    return { phase: "Limit order pending", detail: `${o.side} ${o.limit === null ? "market" : level(o.limit, b.symbol)}${o.stop ? ` · stop ${level(o.stop, b.symbol)}` : ""}${o.tp ? ` · target ${level(o.tp, b.symbol)}` : ""}`, live: s === "ONLINE" };
  }
  if (st?.direction) return { phase: `${st.direction} setup forming`, detail: st.setup_bars !== null && st.max_age_bars ? `${st.setup_bars}/${st.max_age_bars} bars` : null, live: s === "ONLINE" };
  return { phase: s === "STALE" ? "Stale report" : "Scanning", detail: b.engine?.last_candle_time ? `last candle ${b.engine.last_candle_time.slice(11, 16)} UTC` : null, live: s === "ONLINE" };
}

/** One pipeline line per bot, e.g. "ALPHA 02 · SOLUSD 5m · Limit order pending". */
export function pipelineLine(b: Bot, nowMs: number): string {
  return `${b.name} · ${b.symbol} ${b.timeframe} · ${botPhase(b, nowMs).phase}`;
}

/** Sum of a group's bots (funded PAPER only; mirror never included). */
export function groupTotals(bots: Bot[]) {
  const sum = (f: (b: Bot) => number) => bots.reduce((s, b) => s + f(b), 0);
  return {
    available_usd: sum((b) => b.balances.available_usd), reserved_usd: sum((b) => b.balances.reserved_usd),
    gross_usd: sum((b) => b.paper.gross_usd), fees_usd: sum((b) => b.paper.fees_usd), net_usd: sum((b) => b.paper.net_usd),
    swept_usd: sum((b) => b.funding.profit_swept_to_main_usd), trades: sum((b) => b.paper.trades),
  };
}

// ---- The STRATEGY ENGINE's status, from its own telemetry only -----------------------------------------------------
// Never from the website or Worker being reachable, and never from the Alpaca broker route's kill switch (a separate,
// optional /webhook route that the strategies do not use).
export type EngineStatusKey = "SCANNING" | "PENDING_ORDER" | "POSITION_OPEN" | "PAUSED" | "MARKET_DATA_STALE" | "BACKEND_DISCONNECTED" | "OFFLINE" | "NOT_ACTIVE";
export interface EngineStatus { key: EngineStatusKey; label: string; tone: "ok" | "warn" | "bad" | "muted"; detail: string }
export const ENGINE_STATUS_LABEL: Record<EngineStatusKey, string> = {
  SCANNING: "Online — scanning", PENDING_ORDER: "Pending order", POSITION_OPEN: "Position open", PAUSED: "Paused",
  MARKET_DATA_STALE: "Market data stale", BACKEND_DISCONNECTED: "Backend disconnected", OFFLINE: "Engine offline", NOT_ACTIVE: "Not active",
};
const hhmm = (iso: string | null | undefined) => (iso ? `${iso.slice(11, 16)} UTC` : "never");

/**
 * One bot's engine status:
 *   heartbeat  the age of ITS OWN latest engine report received by the Worker (offline beyond 30 min or never);
 *   market     the age of its last COMPLETED candle (stale beyond three candles + 2 min);
 *   backend    the engine's own ledger check (UNVERIFIED = it could not reach the PAPER ledger);
 *   state      paused flag, open position, durable/engine pending order, otherwise scanning.
 */
export function engineStatus(b: Bot, nowMs: number, pendingFromLedger = false): EngineStatus {
  const s = botState(b, nowMs);
  const mk = (key: EngineStatusKey, detail: string): EngineStatus => ({ key, label: ENGINE_STATUS_LABEL[key], tone: key === "SCANNING" || key === "PENDING_ORDER" || key === "POSITION_OPEN" ? "ok" : key === "PAUSED" || key === "MARKET_DATA_STALE" ? "warn" : key === "NOT_ACTIVE" ? "muted" : "bad", detail });
  if (s === "PROPOSED" || s === "DISABLED") return mk("NOT_ACTIVE", s === "PROPOSED" ? "proposed; activation needs the owner's approval" : "disabled");
  const e = b.engine;
  if (s === "NO_REPORT" || s === "OFFLINE") return mk("OFFLINE", `last heartbeat ${hhmm(e?.received_at)}; the engine host may be off or the engine stopped`);
  const tf = Number(String(b.timeframe).replace(/\D/g, "")) || 5;
  const candleClose = Date.parse(String(e?.last_candle_time ?? "")) + tf * 60_000;
  if (!Number.isFinite(candleClose) || nowMs - candleClose > (3 * tf * 60 + 120) * 1000) return mk("MARKET_DATA_STALE", `last completed candle ${hhmm(e?.last_candle_time)}; heartbeat ${hhmm(e?.received_at)}`);
  if (e?.ledger_check?.status === "UNVERIFIED") return mk("BACKEND_DISCONNECTED", e.ledger_check.issues?.[0] ?? "the engine could not reach the PAPER ledger");
  if (s === "PAUSED") return mk("PAUSED", "new entries paused by the owner; open positions are still managed");
  // Bot ledger: only a real PAPER position counts (the engine may still carry one from its warm-up history).
  const pos = b.open_positions[0] ?? (b.ledger_api !== "bot" && e?.position ? { side: e.position.side, qty: e.position.qty } : null);
  if (pos) return mk("POSITION_OPEN", `${pos.side} ${pos.qty} · last candle ${hhmm(e?.last_candle_time)}`);
  if (pendingFromLedger || e?.strategy_state?.pending_order) return mk("PENDING_ORDER", `last candle ${hhmm(e?.last_candle_time)}`);
  return mk("SCANNING", `last candle ${hhmm(e?.last_candle_time)} · heartbeat ${hhmm(e?.received_at)}`);
}

/** The fleet's headline: the active bots' statuses, the most serious first. */
export function fleetEngineStatus(bots: Bot[], nowMs: number): { worst: EngineStatus | null; byBot: { bot: Bot; status: EngineStatus }[] } {
  const order: EngineStatusKey[] = ["OFFLINE", "BACKEND_DISCONNECTED", "MARKET_DATA_STALE", "PAUSED", "POSITION_OPEN", "PENDING_ORDER", "SCANNING", "NOT_ACTIVE"];
  const byBot = bots.filter((b) => b.status === "ACTIVE").map((b) => ({ bot: b, status: engineStatus(b, nowMs) }));
  const worst = byBot.length ? [...byBot].sort((a, c) => order.indexOf(a.status.key) - order.indexOf(c.status.key))[0].status : null;
  return { worst, byBot };
}

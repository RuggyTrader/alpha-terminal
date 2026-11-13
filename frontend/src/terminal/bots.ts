// The bot fleet (docs/MULTI-BOT-ARCHITECTURE.md): data from GET /api/dashboard/bots (worker/src/bots.ts) and the
// owner's authenticated actions (worker/src/bot_ledger.ts). Every figure comes from the Worker: the bot's OWN wallet and
// ledger rows, and the bot's own latest engine report. Hypothetical Strategy Mirror results are a separate field and are
// never added to PAPER figures. Nothing is estimated here; missing data stays missing.

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
  const st = b.engine?.strategy_state;
  if (st?.pending_order) {
    const o = st.pending_order;
    return { phase: "Limit order pending", detail: `${o.side} ${o.limit ?? "market"}${o.stop ? ` · stop ${o.stop}` : ""}${o.tp ? ` · target ${o.tp}` : ""}`, live: s === "ONLINE" };
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

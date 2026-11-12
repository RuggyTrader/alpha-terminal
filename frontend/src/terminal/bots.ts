// The bot fleet (docs/MULTI-BOT-ARCHITECTURE.md): read-only data from GET /api/dashboard/bots (worker/src/bots.ts).
// Every figure comes from the Worker: the ledger (PAPER, per bot) and the bot's own latest engine report. Hypothetical
// Strategy Mirror results are a separate field and are never added to PAPER figures. Nothing is estimated here.

import { api, ApiError } from "../api/client";

export interface BotEngineReport {
  bot_id?: string | null;
  timeframe?: string | null;
  status_text?: string | null;
  last_candle_time?: string | null;
  last_poll_at?: string | null;
  received_at?: string | null;
  position?: { side: string; qty: number; entry: number | null; stop: number | null } | null;
  ledger_check?: { status?: string; issues?: string[] } | null;
}

export interface Bot {
  bot_id: string;
  name: string;
  symbol: string;
  timeframe: string;
  profile: string | null;
  status: "ACTIVE" | "PROPOSED" | "DISABLED";
  entries_paused: boolean;
  wallet: string;
  allocation_cap_usd: number | null;
  reserved_usd: number;
  risk_pct: number;
  max_risk_usd: number;
  open_positions: { id: number; symbol: string; qty: number; avg_entry_price: number; mark_price: number | null; opened_at: string; open_alert_id: string }[];
  paper: { trades: number; realized_net_usd: number; wins: number; win_rate: number | null; profit_factor: number | null; max_drawdown_usd: number };
  mirror: { account_id: string; trades: number; gross: number; last_candle_time: string | null; hypothetical: true }[];
  engine: BotEngineReport | null;
}

export interface Fleet {
  available: boolean;
  bots: Bot[];
}

export async function fetchBots(): Promise<Fleet> {
  const env = await api.get<{ ok: boolean; data?: Fleet; code?: string; message?: string }>("/api/dashboard/bots");
  if (!env?.ok || !env.data || !Array.isArray(env.data.bots)) throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected bots response");
  return env.data;
}

export type BotState = "DISABLED" | "PROPOSED" | "PAUSED" | "ONLINE" | "STALE" | "OFFLINE" | "NO_REPORT";

/**
 * A bot's state from real telemetry only: its registry status, its paused flag and the age of ITS OWN latest engine
 * report (ONLINE within two of its candles + 2 min, STALE within 30 min, otherwise OFFLINE; no report = NO_REPORT).
 */
export function botState(b: Bot, nowMs: number): BotState {
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

/** One pipeline line per bot, e.g. "ALPHA 02 · SOLUSD 5m · Waiting for a swing" (the engine's own status text). */
export function pipelineLine(b: Bot, nowMs: number): string {
  const s = botState(b, nowMs);
  const what = s === "PROPOSED" ? "Proposed, not running" : s === "DISABLED" ? "Disabled" : s === "NO_REPORT" ? "No engine report yet"
    : s === "OFFLINE" ? "Offline" : b.open_positions.length ? `Managing open ${b.engine?.position?.side ?? "LONG"}` : b.engine?.status_text ?? "No status";
  return `${b.name} · ${b.symbol} ${b.timeframe} · ${what}`;
}

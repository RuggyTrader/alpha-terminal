// Bot trade records (worker/src/bot_trades.ts): the Trades filters (?bot=, ?signal=), the Performance bot filter and
// the bot trade proof page. Read-only; every figure is the ledger's own.

import { api, ApiError } from "../api/client";

export interface BotTradeRow {
  trade_id: string; bot_id: string; ledger: "bot" | "legacy"; symbol: string; side: string; status: string; qty: number;
  entry_price: number; exit_price: number | null; opened_at: string; closed_at: string | null;
  gross_usd: number | null; fees_usd: number | null; net_usd: number | null; swept_usd: number | null; stop: number | null; tp: number | null; proof_url: string;
  story?: import("./tradeStory").TradeStory | null;
}
export interface BotOrderRow { order_id: string; bot_id: string; action: string; symbol: string; requested_qty: number | null; status: string; code: string; message: string | null; trade_id: string | null; received_at: string }
export interface SignalRow { id: number; alert_id: string; received_at: string; symbol: string; action: string; status: string; response_code: string | null; rejection_reason: string | null; bot_id: string | null }
export interface BotTrades { available: boolean; filter?: { bot: string | null; signal: string | null }; trades: BotTradeRow[]; orders: BotOrderRow[]; signals: SignalRow[] }

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

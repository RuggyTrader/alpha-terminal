// Strategy Mirror (read-only): the original strategy's HYPOTHETICAL TradingView-style trades with margin 0.
// GET /api/dashboard/mirror, /api/dashboard/mirror/trades, /api/dashboard/mirror/trade (worker/src/mirror.ts).
// Kept apart from the funded ALPHA PAPER ledger everywhere: no figure here is ever added to a funded total.

import { api, ApiError } from "../api/client";

export type MirrorCategory = "live" | "catch_up" | "historical";
export const MIRROR_CATEGORIES: MirrorCategory[] = ["live", "catch_up", "historical"];

export const CATEGORY_INFO: Record<MirrorCategory, { title: string; short: string; explain: string }> = {
  live: {
    title: "Strategy Mirror — Live Observation", short: "Live",
    explain: "Hypothetical trades from candles observed after the mirror's activation, processed on time.",
  },
  catch_up: {
    title: "Catch-up (processed late)", short: "Catch-up",
    explain: "Hypothetical trades from candles after activation that the engine processed late (after an outage or a data-gap re-warm). Same strategy, but not observed live.",
  },
  historical: {
    title: "Historical replay", short: "Historical",
    explain: "Replay of Kraken history from before the mirror's activation (warm-up). A backtest, not an observation.",
  },
};

export interface MirrorTrade {
  trade_id: string; seq: number; side: "LONG" | "SHORT"; qty: number; entry_time: string; entry_price: number; exit_time: string; exit_price: number;
  stop_price: number | null; tp2_price: number | null; exit_kind: string; result: string; exit_r: number | null; gross_pnl: number; risk_usd: number | null;
  notional_usd: number; est_fees: number; est_slippage: number; net_modelled_pnl: number; classification: MirrorCategory; exit_late: number;
  provenance_complete: number; reference_price: number | null; processed_at: string;
}

export interface SidePart { trades: number; wins: number; gross: number; est_costs: number; net_modelled: number }

export interface MirrorMetrics {
  trades: number; longs: number; shorts: number; wins: number; losses: number; flat: number; win_rate_pct: number | null;
  gross_pnl: number; gross_profit: number; gross_loss: number; profit_factor: number | null; max_drawdown: number;
  est_fees: number; est_slippage: number; net_modelled_pnl: number; long: SidePart; short: SidePart;
  exits: Record<string, number>; first_trade_at: string | null; last_exit_at: string | null;
  risk: {
    reporting_equity_usd: number; end_equity: number; min_equity: number; negative_equity: boolean; first_negative_at: string | null;
    max_notional_usd: number; median_notional_usd: number | null; fixed_risk_usd: number | null; max_implied_leverage: number | null;
    margin_required_usd: Record<string, number>; liquidation_risk_trades: Record<string, number>; liquidation_model: string;
  };
  curve: { t: string; equity: number; net_equity: number }[];
}

export interface MirrorPosition {
  trade_id: string | null; side: "LONG" | "SHORT" | null; qty: number | null; entry_time: string | null; entry_price: number | null;
  initial_stop: number | null; current_stop: number | null; tp2: number | null; notional_usd: number | null;
  unrealized_at_last_close: number | null; classification: MirrorCategory | null;
}

export interface MirrorSummary {
  label: string;
  disclosure: string;
  accounts: { account_id: string; symbol: string; timeframe: string; activated_at: string | null; last_seen_at: string | null }[];
  account: {
    account_id: string; symbol: string; timeframe: string; profile: string | null; strategy: string | null; inputs_hash: string;
    engine_version: string | null; engine_release: string | null; engine_commit: string | null; activated_at: string | null;
    first_seen_at: string; last_seen_at: string | null; last_candle_time: string | null; last_candle_close: number | null;
    candles_processed: number | null; risk_usd: number | null; reporting_equity_usd: number; margin: string;
  } | null;
  cost_model: { id: string; name: string; maker_pct: number; taker_pct: number; taker_slippage_pct: number; fee_source: string; slippage_source: string; caveat: string | null; note: string } | null;
  health: {
    state: "OK" | "DEGRADED" | "DIVERGED" | "STALE" | "NOT_ACTIVE"; issues: string[]; last_seen_age_seconds?: number | null; pending?: number | null;
    last_contiguous_seq?: number; max_seq_seen?: number;
    /** Spans after activation that the engine processed late (engine down, catch-up). Their trades are catch_up, not live. */
    observation_gaps?: { from: string; to: string; candles: number | null; processed_at: string | null }[];
    no_trade_intervals?: number;
  };
  reconciliation?: { ok: boolean; journal_entries: number; journal_total: number; trades: number; trades_gross: number; issues: string[] };
  categories: Record<MirrorCategory, MirrorMetrics> | null;
  open_position: MirrorPosition | null;
  activity: { trade_id: string; seq: number; side: string; classification: MirrorCategory; result: string; exit_time: string; gross_pnl: number }[];
  interruptions: { seq: number; classification: MirrorCategory; recorded_at: string; side?: string; qty?: number; entry_time?: string; entry_price?: number; reason?: string }[];
}

export interface MirrorProof {
  label: string; disclosure: string;
  trade: MirrorTrade & Record<string, unknown>;
  candles: { entry: Candle | null; exit: Candle };
  journal_entry: { entry_key: string; amount_usd: number; classification: string; created_at: string } | null;
  account: { account_id: string; symbol: string; timeframe: string; profile: string | null; strategy: string | null; inputs_hash: string; activated_at: string | null; reporting_equity_usd: number } | null;
  checks: { gross_equals_price_move: boolean; journal_matches: boolean; net_equals_gross_minus_costs: boolean };
}
export interface Candle { t: string; o: number; h: number; l: number; c: number }

type Env<T> = { ok: boolean; data?: T; code?: string; message?: string };
async function getData<T>(path: string): Promise<T> {
  const env = await api.get<Env<T>>(path);
  if (!env?.ok || env.data === undefined) throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected mirror response");
  return env.data;
}

export const fetchMirror = () => getData<MirrorSummary>("/api/dashboard/mirror");
export const fetchMirrorTrades = (category: MirrorCategory, limit = 50) =>
  getData<{ trades: MirrorTrade[]; total: number }>(`/api/dashboard/mirror/trades?category=${category}&limit=${limit}`);
export const fetchMirrorProof = (id: string) => getData<MirrorProof>(`/api/dashboard/mirror/trade?id=${encodeURIComponent(id)}`);

export const RESULT_LABEL: Record<string, string> = {
  TP2: "Take profit (TP2)", SL: "Stop loss", TRAILING_SL: "Trailing stop", BREAK_EVEN: "Break-even", TIME_EXIT: "Time exit", SAME_BAR: "Same-candle entry and exit", UNLABELLED: "Unlabelled",
};

// Verified performance from closed ALPHA PAPER ledger trades only (GET /api/dashboard/performance).
// Pure functions: nothing here estimates, extrapolates or fills gaps. A metric that the evidence cannot
// support is null and shown as N/A. Engine-internal simulations and backtests never enter these numbers.

import type { LifetimePerformance, PerformanceData, VerifiedTrade } from "./types";

export type Range = "1D" | "1W" | "1M" | "ALL";
export const RANGES: Range[] = ["1D", "1W", "1M", "ALL"];
const RANGE_MS: Record<Range, number | null> = { "1D": 86_400_000, "1W": 7 * 86_400_000, "1M": 30 * 86_400_000, ALL: null };

/** Fewer closed trades than this: no equity curve (one point is not a curve). */
export const MIN_CURVE_TRADES = 2;

export interface CurvePoint {
  t: number;
  equity: number; // cumulative verified realized P&L since the start of the range
  tradeId: number | null;
}

export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  /** % of the PAPER capital funded into the portfolio; null when nothing is funded. */
  returnPct: number | null;
  winRate: number | null;
  /** Gross profit ÷ gross loss; null without trades or without any losing trade. */
  profitFactor: number | null;
  /** Average verified P&L per closed trade. */
  expectancy: number | null;
  /** Largest fall of cumulative verified P&L from a previous peak (≥ 0); null without trades. */
  maxDrawdown: number | null;
  curve: CurvePoint[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const ms = (iso: string) => {
  const v = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(" ", "T")}Z` : iso;
  return Date.parse(v);
};

export function inRange(trades: VerifiedTrade[], range: Range, now: number): VerifiedTrade[] {
  const span = RANGE_MS[range];
  const ok = trades.filter((t) => Number.isFinite(ms(t.closed_at)) && Number.isFinite(Number(t.realized_pnl)));
  return span === null ? ok : ok.filter((t) => ms(t.closed_at) >= now - span);
}

export function computeMetrics(all: VerifiedTrade[], range: Range, now: number, fundedCapital: number | null): Metrics {
  const trades = inRange(all, range, now).slice().sort((a, b) => ms(a.closed_at) - ms(b.closed_at) || a.id - b.id);
  const pnls = trades.map((t) => Number(t.realized_pnl));
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p < 0).length;
  const total = round2(pnls.reduce((a, b) => a + b, 0));
  const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = -pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0);

  const curve: CurvePoint[] = [];
  let eq = 0, peak = 0, dd = 0;
  if (trades.length) curve.push({ t: ms(trades[0].opened_at) < ms(trades[0].closed_at) ? ms(trades[0].opened_at) : ms(trades[0].closed_at), equity: 0, tradeId: null });
  for (const t of trades) {
    eq += Number(t.realized_pnl);
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    curve.push({ t: ms(t.closed_at), equity: round2(eq), tradeId: t.id });
  }

  const n = trades.length;
  return {
    trades: n, wins, losses, totalPnl: total,
    returnPct: fundedCapital !== null && fundedCapital > 0 ? (total / fundedCapital) * 100 : null,
    winRate: n ? (wins / n) * 100 : null,
    profitFactor: n && grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: n ? round2(total / n) : null,
    maxDrawdown: n ? round2(dd) : null,
    curve,
  };
}

/** Why the profit factor is N/A, for the label under it. */
export function profitFactorNote(m: Metrics): string | null {
  if (m.trades === 0) return "no closed trades";
  if (m.losses === 0) return "no losing trades yet";
  return null;
}

/** Account headlines never infer lifetime totals from a bounded trade array. */
export function lifetimeMetrics(data: PerformanceData | null, capital: number | null): Metrics | null {
  const p: LifetimePerformance | undefined = data?.lifetime;
  if (!p?.complete || p.scope !== "all-funded-paper") return null;
  return { trades: p.closed_trades, wins: p.wins, losses: p.losses, totalPnl: p.net_usd,
    returnPct: capital !== null && capital > 0 ? p.net_usd / capital * 100 : null,
    winRate: p.win_rate === null ? null : p.win_rate * 100, profitFactor: p.profit_factor,
    expectancy: p.expectancy_usd, maxDrawdown: p.closed_trades ? p.max_drawdown_usd : null, curve: [] };
}

export function completeFundedHistory(data: PerformanceData | null): boolean {
  return !!data?.lifetime?.complete && !data.truncated && !data.history_error && data.trades.length === data.lifetime.closed_trades;
}

// Risk and performance simulator over a VERIFIED engine backtest (real Kraken candles, the engine's own fills).
// Pure functions; the dashboard and the engine's report both use this file, so they always agree.
//
// Why scaling by risk is exact here (and only here): the strategy sizes every order as
//   qty = riskUSD / |entry − stop|        (Pine: riskUSD * usdRate / (|ep − slPlan| * pointvalue), no rounding)
// and no trading decision depends on qty, equity or risk (no commission, no slippage, pyramiding 0). So at risk r
// every trade has the same times and prices and qty_r = qty_basis × r / basis, pnl_r = pnl_basis × r / basis.
// The engine test re-runs the backtest at other risks and checks this equality on every trade.
//
// Three result types are kept apart:
//   A. raw TradingView-style backtest: every trade, long and short, no capital limit (TV Properties: leverage ∞).
//   B. portfolio-constrained PAPER backtest: starts at the selected allocation; an entry is rejected when the
//      position value (qty × entry) exceeds the balance (no leverage, no borrowing), when it is a short (ALPHA PAPER
//      is long-only) or when it breaks the Worker's order/position limits. Fills still at the engine's prices.
//   C. the ALPHA PAPER ledger itself (not computed here; read from the portfolio).

export interface BacktestTrade {
  n: number;
  side: "LONG" | "SHORT";
  qty: number;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  exitKind: string;
  result: string | null;
  pnl: number;
}

export interface BacktestResult {
  strategy: string;
  profile: string;
  config_hash: string;
  risk_basis_usd: number;
  inputs: Record<string, unknown>;
  data: { source: string; from: string; to: string; candles: number; trades_from: string };
  execution: string[];
  trades: BacktestTrade[];
}

export interface Limits {
  maxOrderNotional: number | null; // Worker MAX_ORDER_NOTIONAL
  maxPositionExposure: number | null; // Worker MAX_POSITION_EXPOSURE
  longOnly: boolean; // ALPHA PAPER refuses shorts
}

export interface SimTrade extends BacktestTrade {
  notional: number;
  accepted: boolean;
  rejection: string | null;
  equityAfter: number;
}

export interface SimStats {
  startEquity: number;
  endEquity: number;
  trades: number; // closed trades counted (accepted only for B)
  rejected: number;
  rejectedBy: Record<string, number>;
  netPnl: number;
  avgPnl: number | null;
  winRate: number | null; // 0..1
  wins: number;
  losses: number;
  profitFactor: number | null; // null when there is no losing trade
  avgWin: number | null;
  avgLoss: number | null;
  maxConsecutiveLosses: number;
  maxDrawdownUsd: number; // closed-trade equity, peak to trough
  maxDrawdownPct: number | null; // of the peak equity at that point, starting from startEquity
  maxNotional: number | null;
  medianNotional: number | null;
  curve: { t: string; equity: number }[];
  list: SimTrade[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function stats(startEquity: number, list: SimTrade[]): SimStats {
  const done = list.filter((t) => t.accepted);
  const pnls = done.map((t) => t.pnl);
  const winsP = pnls.filter((p) => p > 0);
  const lossP = pnls.filter((p) => p < 0);
  let eq = startEquity, peak = startEquity, dd = 0, ddPct: number | null = null, streak = 0, maxStreak = 0;
  const curve = [{ t: list[0]?.entryTime ?? "", equity: r2(startEquity) }];
  for (const t of done) {
    eq += t.pnl;
    curve.push({ t: t.exitTime, equity: r2(eq) });
    peak = Math.max(peak, eq);
    if (peak - eq > dd) {
      dd = peak - eq;
      ddPct = peak > 0 ? (peak - eq) / peak : null;
    }
    streak = t.pnl < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const grossWin = winsP.reduce((a, b) => a + b, 0);
  const grossLoss = -lossP.reduce((a, b) => a + b, 0);
  const notionals = done.map((t) => t.notional).sort((a, b) => a - b);
  const rejectedBy: Record<string, number> = {};
  for (const t of list) if (!t.accepted && t.rejection) rejectedBy[t.rejection] = (rejectedBy[t.rejection] ?? 0) + 1;
  const net = pnls.reduce((a, b) => a + b, 0);
  return {
    startEquity, endEquity: r2(eq), trades: done.length, rejected: list.length - done.length, rejectedBy,
    netPnl: r2(net), avgPnl: done.length ? r2(net / done.length) : null,
    winRate: done.length ? winsP.length / done.length : null, wins: winsP.length, losses: lossP.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWin: winsP.length ? r2(grossWin / winsP.length) : null, avgLoss: lossP.length ? r2(-grossLoss / lossP.length) : null,
    maxConsecutiveLosses: maxStreak, maxDrawdownUsd: r2(dd), maxDrawdownPct: ddPct,
    maxNotional: notionals.length ? r2(notionals[notionals.length - 1]) : null,
    medianNotional: notionals.length ? r2(notionals[Math.floor(notionals.length / 2)]) : null,
    curve, list,
  };
}

const scaled = (t: BacktestTrade, k: number) => ({ ...t, qty: t.qty * k, pnl: t.pnl * k });

/** A. Raw TradingView-style backtest at `riskUsd`: every trade, no capital constraint. */
export function rawBacktest(bt: BacktestResult, riskUsd: number, startEquity: number): SimStats {
  const k = riskUsd / bt.risk_basis_usd;
  let eq = startEquity;
  const list = bt.trades.map((t0) => {
    const t = scaled(t0, k);
    eq += t.pnl;
    return { ...t, notional: t.qty * t.entryPrice, accepted: true, rejection: null, equityAfter: eq };
  });
  return stats(startEquity, list);
}

/** B. Portfolio-constrained PAPER backtest at `riskUsd`, starting from `allocation`. */
export function constrainedBacktest(bt: BacktestResult, riskUsd: number, allocation: number, limits: Limits): SimStats {
  const k = riskUsd / bt.risk_basis_usd;
  let balance = allocation;
  const list = bt.trades.map((t0) => {
    const t = scaled(t0, k);
    const notional = t.qty * t.entryPrice;
    let rejection: string | null = null;
    if (limits.longOnly && t.side === "SHORT") rejection = "SHORT_NOT_SUPPORTED";
    else if (limits.maxOrderNotional !== null && notional > limits.maxOrderNotional) rejection = "MAX_ORDER_NOTIONAL";
    else if (limits.maxPositionExposure !== null && notional > limits.maxPositionExposure) rejection = "MAX_POSITION_EXPOSURE";
    else if (notional > balance) rejection = "INSUFFICIENT_PAPER_CAPITAL";
    if (!rejection) balance += t.pnl;
    return { ...t, notional, accepted: rejection === null, rejection, equityAfter: balance };
  });
  return stats(allocation, list);
}

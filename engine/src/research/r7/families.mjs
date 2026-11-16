// Round 7 strategy families (docs/research/round7/PREREGISTRATION.md). Simple, interpretable rules with SMALL fixed
// grids. Every rule reads bars 0..i only (indicators from bt.mjs exclude the future by construction). Symmetric for SHORT.
import { atr, priorHigh, priorLow, sma, std } from "./bt.mjs";

const up = (side) => side === "LONG";

/** T1 Donchian breakout: close beyond the prior N-bar range; exit on the opposite M-bar range; 2xATR initial stop. */
export const T1 = (p) => (bars, side) => {
  const A = atr(bars), hiN = priorHigh(bars, p.N), loN = priorLow(bars, p.N), hiM = priorHigh(bars, p.M), loM = priorLow(bars, p.M);
  return (i, pos) => {
    const c = bars[i].c;
    if (!pos) {
      if (A[i] === null || hiN[i] === null) return null;
      if (up(side) ? c > hiN[i] : c < loN[i]) return { enter: { stop: up(side) ? c - 2 * A[i] : c + 2 * A[i] } };
      return null;
    }
    if (up(side) ? c < loM[i] : c > hiM[i]) return { exit: true };
    return null;
  };
};

/** T2 Moving-average regime: price above a RISING SMA(N) (long); exit on a close back through it; 3xATR trailing stop. */
export const T2 = (p) => (bars, side) => {
  const C = bars.map((b) => b.c), S = sma(C, p.N), A = atr(bars);
  let best = null;
  return (i, pos) => {
    const c = C[i];
    if (S[i] === null || i < 10 || S[i - 10] === null || A[i] === null) return null;
    if (!pos) {
      best = c;
      const ok = up(side) ? c > S[i] && S[i] > S[i - 10] : c < S[i] && S[i] < S[i - 10];
      return ok ? { enter: { stop: up(side) ? c - 3 * A[i] : c + 3 * A[i] } } : null;
    }
    best = up(side) ? Math.max(best ?? c, c) : Math.min(best ?? c, c);
    if (up(side) ? c < S[i] : c > S[i]) return { exit: true };
    return { stop: up(side) ? best - 3 * A[i] : best + 3 * A[i] };
  };
};

/** M1 Time-series momentum (daily bars): every 7th bar, hold while the L-bar return has the trade's sign; 3xATR trail. */
export const M1 = (p) => (bars, side) => {
  const A = atr(bars);
  let best = null;
  return (i, pos) => {
    if (i < p.L || A[i] === null) return null;
    const mom = bars[i].c / bars[i - p.L].c - 1, c = bars[i].c, rebalance = i % 7 === 0;
    if (!pos) { best = c; return rebalance && (up(side) ? mom > 0 : mom < 0) ? { enter: { stop: up(side) ? c - 3 * A[i] : c + 3 * A[i] } } : null; }
    best = up(side) ? Math.max(best ?? c, c) : Math.min(best ?? c, c);
    if (rebalance && (up(side) ? mom <= 0 : mom >= 0)) return { exit: true };
    return { stop: up(side) ? best - 3 * A[i] : best + 3 * A[i] };
  };
};

/** B1 Volatility contraction then expansion: Bollinger width in its lowest 20% of the last 120 bars within the last 5
 *  bars, then a close beyond the prior 20-bar range; 3xATR trailing stop; time exit after 30 bars. */
export const B1 = () => (bars, side) => {
  const C = bars.map((b) => b.c), M = sma(C, 20), SD = std(C, 20), A = atr(bars), hi = priorHigh(bars, 20), lo = priorLow(bars, 20);
  const W = C.map((c, i) => (M[i] === null ? null : (4 * SD[i]) / M[i]));
  const squeeze = W.map((w, i) => {
    if (w === null || i < 125) return false;
    for (let k = i - 4; k <= i; k++) { const win = W.slice(k - 119, k + 1).filter((x) => x !== null).sort((a, b) => a - b); if (win.length > 50 && W[k] <= win[Math.floor(win.length * 0.2)]) return true; }
    return false;
  });
  let best = null;
  return (i, pos) => {
    const c = C[i];
    if (A[i] === null || hi[i] === null) return null;
    if (!pos) { best = c; return squeeze[i] && (up(side) ? c > hi[i] : c < lo[i]) ? { enter: { stop: up(side) ? c - 3 * A[i] : c + 3 * A[i] } } : null; }
    best = up(side) ? Math.max(best ?? c, c) : Math.min(best ?? c, c);
    if (pos.bars >= 30) return { exit: true };
    return { stop: up(side) ? best - 3 * A[i] : best + 3 * A[i] };
  };
};

/** R1 Mean reversion inside the trend: long when close < SMA20 - k*sd20 while close > SMA200 (short mirrored); exit at
 *  SMA20 or after 12 bars; 2.5xATR stop. */
export const R1 = (p) => (bars, side) => {
  const C = bars.map((b) => b.c), M = sma(C, 20), SD = std(C, 20), L = sma(C, 200), A = atr(bars);
  return (i, pos) => {
    const c = C[i];
    if (L[i] === null || A[i] === null || M[i] === null) return null;
    if (!pos) {
      const ok = up(side) ? c < M[i] - p.k * SD[i] && c > L[i] : c > M[i] + p.k * SD[i] && c < L[i];
      return ok ? { enter: { stop: up(side) ? c - 2.5 * A[i] : c + 2.5 * A[i] } } : null;
    }
    if ((up(side) ? c >= M[i] : c <= M[i]) || pos.bars >= 12) return { exit: true };
    return null;
  };
};

/** The pre-registered grid: family -> list of { id, tf, params }. */
export const GRID = {
  T1: [240, 1440].flatMap((tf) => [[20, 10], [55, 20]].map(([N, M]) => ({ id: `T1-${tf}-${N}-${M}`, tf, make: T1({ N, M }) }))),
  T2: [240, 1440].flatMap((tf) => [50, 100, 200].map((N) => ({ id: `T2-${tf}-${N}`, tf, make: T2({ N }) }))),
  M1: [30, 60, 120].map((L) => ({ id: `M1-1440-${L}`, tf: 1440, make: M1({ L }) })),
  B1: [60, 240].map((tf) => ({ id: `B1-${tf}`, tf, make: B1() })),
  R1: [60, 240].flatMap((tf) => [2, 2.5].map((k) => ({ id: `R1-${tf}-${k}`, tf, make: R1({ k }) }))),
};

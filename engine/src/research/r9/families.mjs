// Round 9 strategy families (docs/research/round9/PREREGISTRATION.md, frozen in 7288171). LONG only. Every rule reads
// bars 0..i only and decides at bar i's close (r7/bt.mjs fills at the next open). The BTC regime is read from the last
// COMPLETED UTC day at the decision time, never the current day.
import { atr, priorHigh, priorLow, sma, std } from "../r7/bt.mjs";

export const DAY = 86_400_000;

/** BTC regime: ON when the last completed daily close is above its 200-day SMA. btcDaily = [{t,o,h,l,c}] (t = day start). */
export function makeRegime(btcDaily) {
  const C = btcDaily.map((b) => b.c), S = sma(C, 200), on = new Map();
  btcDaily.forEach((b, i) => on.set(b.t, S[i] !== null && b.c > S[i]));
  // decision at time tc (a bar's CLOSE time): the latest UTC day that has fully closed by tc starts at floor(tc/DAY)*DAY - DAY
  return (tc) => { const d = Math.floor(tc / DAY) * DAY - DAY; for (let k = 0; k < 7; k++) { const v = on.get(d - k * DAY); if (v !== undefined) return v; } return false; };
}

const closeTime = (bars, i, tfMin) => bars[i].t + tfMin * 60_000;

/** F1 regime-filtered Donchian: close above the prior N-bar high while BTC regime ON; exit below the prior M-bar low; 2xATR stop. */
export const F1 = ({ N, M, tf, regime }) => (bars) => {
  const A = atr(bars), hiN = priorHigh(bars, N), loM = priorLow(bars, M);
  return (i, pos) => {
    const c = bars[i].c;
    if (!pos) {
      if (A[i] === null || hiN[i] === null || !regime(closeTime(bars, i, tf))) return null;
      return c > hiN[i] ? { enter: { stop: c - 2 * A[i] } } : null;
    }
    return loM[i] !== null && c < loM[i] ? { exit: true } : null;
  };
};

/** F2 volatility-normalised momentum (daily): weekly, z = ln(c_i/c_{i-L}) / (sigma60 * sqrt L) > theta and regime ON;
 *  exit at a weekly check when z <= 0 or the regime is OFF; 3xATR trailing stop. */
export const F2 = ({ L, theta, regime }) => (bars) => {
  const A = atr(bars), lr = bars.map((b, i) => (i === 0 ? null : Math.log(b.c / bars[i - 1].c)));
  const sig = lr.map((_, i) => { if (i < 61) return null; let m = 0; for (let j = i - 59; j <= i; j++) m += lr[j]; m /= 60; let v = 0; for (let j = i - 59; j <= i; j++) v += (lr[j] - m) ** 2; return Math.sqrt(v / 59); });
  let best = null;
  return (i, pos) => {
    if (i < L || A[i] === null || sig[i] === null || sig[i] === 0) return null;
    const z = Math.log(bars[i].c / bars[i - L].c) / (sig[i] * Math.sqrt(L)), c = bars[i].c, weekly = i % 7 === 0, on = regime(closeTime(bars, i, 1440));
    if (!pos) { best = c; return weekly && on && z > theta ? { enter: { stop: c - 3 * A[i] } } : null; }
    best = Math.max(best ?? c, c);
    if (weekly && (z <= 0 || !on)) return { exit: true };
    return { stop: best - 3 * A[i] };
  };
};

/** Kaufman efficiency ratio over n bars (bars 0..i). */
export const efficiency = (C, n = 20) => C.map((c, i) => { if (i < n) return null; let path = 0; for (let j = i - n + 1; j <= i; j++) path += Math.abs(C[j] - C[j - 1]); return path === 0 ? 0 : Math.abs(c - C[i - n]) / path; });

/** F3 regime-adaptive (4h): ER(20) > e -> trend mode (20-bar breakout, exit below 10-bar low, 2xATR stop); otherwise
 *  range mode (close < SMA20 - 2sd while > SMA200; exit at SMA20 or after 12 bars; 2.5xATR stop). Mode fixed at entry. */
export const F3 = ({ e }) => (bars) => {
  const C = bars.map((b) => b.c), ER = efficiency(C, 20), A = atr(bars), hi20 = priorHigh(bars, 20), lo10 = priorLow(bars, 10), M = sma(C, 20), SD = std(C, 20), L = sma(C, 200);
  let mode = null;
  return (i, pos) => {
    const c = C[i];
    if (!pos) {
      if (ER[i] === null || A[i] === null || hi20[i] === null || L[i] === null || M[i] === null) return null;
      if (ER[i] > e) { if (c > hi20[i]) { mode = "trend"; return { enter: { stop: c - 2 * A[i] } }; } return null; }
      if (c < M[i] - 2 * SD[i] && c > L[i]) { mode = "range"; return { enter: { stop: c - 2.5 * A[i] } }; }
      return null;
    }
    if (mode === "trend") return lo10[i] !== null && c < lo10[i] ? { exit: true } : null;
    return c >= M[i] || pos.bars >= 12 ? { exit: true } : null;
  };
};

/** F4 reversion after an extreme bar: return < -k * sd(returns of the prior 100 bars) while close > SMA200; exit at SMA20
 *  or after 24 bars; 2.5xATR stop. */
export const F4 = ({ k }) => (bars) => {
  const C = bars.map((b) => b.c), r = C.map((c, i) => (i === 0 ? null : c / C[i - 1] - 1)), A = atr(bars), M = sma(C, 20), L = sma(C, 200);
  const sd = r.map((_, i) => { if (i < 101) return null; let m = 0; for (let j = i - 100; j < i; j++) m += r[j]; m /= 100; let v = 0; for (let j = i - 100; j < i; j++) v += (r[j] - m) ** 2; return Math.sqrt(v / 99); });
  return (i, pos) => {
    const c = C[i];
    if (!pos) {
      if (sd[i] === null || L[i] === null || A[i] === null) return null;
      return r[i] < -k * sd[i] && c > L[i] ? { enter: { stop: c - 2.5 * A[i] } } : null;
    }
    return c >= M[i] || pos.bars >= 24 ? { exit: true } : null;
  };
};

/** The pre-registered grid (16 configurations). F5 is a portfolio rule, run by run.mjs through r8/xsmom.mjs. */
export function grid(regime) {
  return {
    F1: [240, 1440].flatMap((tf) => [[20, 10], [55, 20]].map(([N, M]) => ({ id: `F1-${tf}-${N}-${M}`, tf, make: F1({ N, M, tf, regime }) }))),
    F2: [30, 90].flatMap((L) => [0.5, 1.0].map((theta) => ({ id: `F2-1440-${L}-${theta}`, tf: 1440, make: F2({ L, theta, regime }) }))),
    F3: [0.3, 0.4].map((e) => ({ id: `F3-240-${e}`, tf: 240, make: F3({ e }) })),
    F4: [60, 240].flatMap((tf) => [3, 4].map((k) => ({ id: `F4-${tf}-${k}`, tf, make: F4({ k }) }))),
    F5: [30, 90].map((L) => ({ id: `F5-1440-${L}-top3`, tf: 1440, L, K: 3, portfolio: true })),
  };
}

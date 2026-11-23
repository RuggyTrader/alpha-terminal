// Round 10 helpers (docs/research/round10/PREREGISTRATION.md). Research only.

/** Drawdown-floor (Grossman-Zhou / CPPI) multiplier: min(1, m x (E - (1 - D) x HWM) / E), never negative. */
export const floorOverlay = (D, m) => ({ eqC, hwm }) => Math.max(0, Math.min(1, (m * (eqC - (1 - D) * hwm)) / eqC));

/** Rolling h-day net returns of a daily equity curve [[t, eq]]: { n, median_pct, p5_pct, worst_pct, best_pct }. */
export function rolling(curve, h) {
  const r = [];
  for (let i = 0; i + h < curve.length; i++) r.push(curve[i + h][1] / curve[i][1] - 1);
  if (!r.length) return { n: 0 };
  r.sort((a, b) => a - b);
  const q = (p) => r[Math.min(r.length - 1, Math.floor(p * r.length))] * 100;
  return { n: r.length, median_pct: q(0.5), p5_pct: q(0.05), worst_pct: r[0] * 100, best_pct: r.at(-1) * 100 };
}

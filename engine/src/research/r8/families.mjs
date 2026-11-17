// Round 8 candidates (docs/research/round8/PREREGISTRATION.md). LONG only. NO parameter grid: every setting is fixed
// before any run. T1 and M1 are the round-7 INCONCLUSIVE configurations, frozen exactly as selected there; P3 is a
// new, parameter-free cross-sectional rotation whose settings are fixed a priori (never tuned on any data).
import { atr } from "../r7/bt.mjs";
import { M1, T1 } from "../r7/families.mjs";

const DAY = 86_400_000;

/** P3 cross-sectional momentum rotation (daily). Every 7th UTC day (days since epoch % 7 === 0), rank the basket by
 *  30-day return using closes at or before that day's close; hold the top K whose own 30-day return is > 0 (absolute
 *  momentum filter: in a falling market it holds cash). A held market that leaves the selection exits at the next
 *  open; 3xATR(14) trailing stop protects between rebalances. Ranks are precomputed from closes only (no lookahead). */
export function rotationRanks(series, { L = 30, K = 3 } = {}) {
  const sel = new Map(); // t -> Set(markets selected at that close)
  const closes = {};
  for (const [m, bars] of Object.entries(series)) closes[m] = new Map(bars.map((b, i) => [b.t, { c: b.c, i, bars }]));
  const times = [...new Set(Object.values(series).flatMap((b) => b.map((x) => x.t)))].sort((a, b) => a - b);
  for (const t of times) {
    if (Math.floor(t / DAY) % 7 !== 0) continue;
    const scored = [];
    for (const [m, map] of Object.entries(closes)) {
      const x = map.get(t); if (!x || x.i < L) continue;
      const past = x.bars[x.i - L];
      if (t - past.t > (L + 3) * DAY) continue; // too many missing days: not ranked
      scored.push([m, x.c / past.c - 1]);
    }
    scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    sel.set(t, new Set(scored.filter(([, r]) => r > 0).slice(0, K).map(([m]) => m)));
  }
  return sel;
}

export const P3 = (sel) => (bars, m) => {
  const A = atr(bars);
  let best = null;
  return (i, pos) => {
    const t = bars[i].t, c = bars[i].c, s = sel.get(t);
    if (A[i] === null) return null;
    if (!pos) { best = c; return s && s.has(m) ? { enter: { stop: c - 3 * A[i] } } : null; }
    best = Math.max(best ?? c, c);
    if (s && !s.has(m)) return { exit: true };
    return { stop: best - 3 * A[i] };
  };
};

/** The round-8 candidate list. `make(series)` returns the per-market factory for backtestPortfolio. */
export const CANDIDATES = [
  { id: "R8-T1-240-55-20", family: "Breakout / trend", tf: 240, origin: "round 7 T1 LONG (frozen)", make: () => { const f = T1({ N: 55, M: 20 }); return (bars) => f(bars, "LONG"); } },
  { id: "R8-M1-1440-30", family: "Time-series momentum", tf: 1440, origin: "round 7 M1 LONG (frozen)", make: () => { const f = M1({ L: 30 }); return (bars) => f(bars, "LONG"); } },
  { id: "R8-P3-1440-30-3", family: "Cross-sectional momentum rotation", tf: 1440, origin: "new in round 8 (fixed a priori)", make: (series) => P3(rotationRanks(series, { L: 30, K: 3 })) },
];

// Event-study statistics: Student t p-values, Holm correction, day-clustered bootstrap, seeded RNG. Pure functions.
export function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
export { mean };
export const median = (a) => { const z = [...a].sort((x, y) => x - y), n = z.length; return n ? (n % 2 ? z[(n - 1) / 2] : (z[n / 2 - 1] + z[n / 2]) / 2) : null; };
export const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

// regularized incomplete beta (Numerical Recipes continued fraction)
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300; let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m; let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function lgamma(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const k of c) s += k / ++y; return -t + Math.log((2.5066282746310005 * s) / x); }
export function ibeta(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Two-sided p-value of a one-sample t-test that the mean of xs is 0. */
export function tTest(xs) {
  const n = xs.length; if (n < 3) return { n, t: null, p: null };
  const s = sd(xs); if (!(s > 0)) return { n, t: null, p: null };
  const t = mean(xs) / (s / Math.sqrt(n)), df = n - 1;
  return { n, t, p: ibeta(df / 2, 0.5, df / (df + t * t)) };
}
/** Holm-Bonferroni adjusted p-values (same order as input; nulls stay null). */
export function holm(ps) {
  const idx = ps.map((p, i) => [p, i]).filter(([p]) => p !== null).sort((a, b) => a[0] - b[0]), m = idx.length, out = ps.map(() => null);
  let run = 0; idx.forEach(([p, i], k) => { run = Math.max(run, Math.min(1, (m - k) * p)); out[i] = run; });
  return out;
}
/** Day-clustered bootstrap CI of the mean: groups = { day: [values] }. Resamples days with replacement. */
export function clusterBootstrap(groups, { B = 2000, seed = 7, alpha = 0.05 } = {}) {
  const days = Object.values(groups).filter((g) => g.length); if (days.length < 3) return null;
  const r = rng(seed), stats = [];
  for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let k = 0; k < days.length; k++) { const g = days[Math.floor(r() * days.length)]; for (const x of g) { s += x; n++; } } stats.push(s / n); }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor((alpha / 2) * B)], stats[Math.floor((1 - alpha / 2) * B) - 1]];
}
/** Deciles: returns a function value -> decile 0..9 using the cut points of `pool`. */
export function decileFn(pool) {
  const z = pool.filter(Number.isFinite).sort((a, b) => a - b); const cuts = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => z[Math.floor((k / 10) * (z.length - 1))]);
  return (v) => { let d = 0; while (d < 9 && v > cuts[d]) d++; return d; };
}
/** Value at quantile q of a SORTED array. */
export const quantileSorted = (z, q) => z[Math.min(z.length - 1, Math.max(0, Math.floor(q * (z.length - 1))))];

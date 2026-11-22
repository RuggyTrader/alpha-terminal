// Signal construction for round S (docs/research/signals/PREREGISTRATION.md). Every signal for decision day d (00:00 UTC)
// uses data strictly BEFORE d: daily observations dated d-1 or earlier; 8-hourly funding with fundingTime < d.
export const DAY = 86_400_000;
const dayOf = (t) => Math.floor(t / DAY) * DAY;

/** Daily series Map(day -> value) from [t, v] rows (t at 00:00 UTC of the day the value describes). */
export const dailyMap = (rows) => new Map(rows.map(([t, v]) => [dayOf(t), v]));

/** Mean of 8-hourly funding rates with d - 7 days <= fundingTime < d. */
export function fundingSignal(fundingRows) {
  const sorted = [...fundingRows].sort((a, b) => a[0] - b[0]);
  return (d) => { let s = 0, n = 0; for (const [t, r] of sorted) { if (t >= d) break; if (t >= d - 7 * DAY) { s += r; n++; } } return n >= 15 ? s / n : null; };
}
/** Mean of a daily series over days d-7 .. d-1 (all 7 required). */
export function mean7(map) {
  return (d) => { let s = 0; for (let k = 1; k <= 7; k++) { const v = map.get(d - k * DAY); if (v === undefined || !Number.isFinite(v)) return null; s += v; } return s / 7; };
}
/** Sum over d-7..d-1 of (in - out), divided by supply on d-1. */
export function netflowSignal(inMap, outMap, supplyMap) {
  return (d) => { let s = 0; for (let k = 1; k <= 7; k++) { const a = inMap.get(d - k * DAY), b = outMap.get(d - k * DAY); if (a === undefined || b === undefined) return null; s += a - b; } const sup = supplyMap.get(d - DAY); return sup > 0 ? s / sup : null; };
}
/** Growth of a supply series between d-31 and d-1. */
export function growth30(map) { return (d) => { const a = map.get(d - DAY), b = map.get(d - 31 * DAY); return a > 0 && b > 0 ? a / b - 1 : null; }; }
/** Forward log return from the open of day d to the open of day d + h days (bars: Map(day -> {o})). */
export function forwardReturn(bars, h = 7) { return (d) => { const a = bars.get(d), b = bars.get(d + h * DAY); return a && b ? Math.log(b.o / a.o) : null; }; }

/** Spearman rank correlation. */
export function spearman(x, y) {
  const rank = (v) => { const idx = v.map((a, i) => [a, i]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; } return r; };
  const rx = rank(x), ry = rank(y), n = x.length, mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let c = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { c += (rx[i] - mx) * (ry[i] - my); vx += (rx[i] - mx) ** 2; vy += (ry[i] - my) ** 2; }
  return c / Math.sqrt(vx * vy);
}
/** Block bootstrap of a statistic over paired samples (blocks of `block` consecutive samples). */
export function blockBootstrap(x, y, stat, { block = 4, reps = 5000, seed = 12345 } = {}) {
  let s = seed >>> 0; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const n = x.length, out = [];
  for (let r = 0; r < reps; r++) { const bx = [], by = []; while (bx.length < n) { const st = Math.floor(rnd() * (n - block + 1)); for (let k = 0; k < block && bx.length < n; k++) { bx.push(x[st + k]); by.push(y[st + k]); } } out.push(stat(bx, by)); }
  out.sort((a, b) => a - b);
  const mean = out.reduce((a, b) => a + b, 0) / reps, sd = Math.sqrt(out.reduce((a, b) => a + (b - mean) ** 2, 0) / (reps - 1));
  return { q: (p) => out[Math.min(reps - 1, Math.max(0, Math.floor(p * reps)))], lo99: out[Math.floor(0.005 * reps)], hi99: out[Math.floor(0.995 * reps)], lo95: out[Math.floor(0.025 * reps)], hi95: out[Math.floor(0.975 * reps)], se: sd };
}
/** Mean of y in the top and bottom quintile of x. */
export function quintiles(x, y) {
  const idx = x.map((v, i) => i).sort((a, b) => x[a] - x[b]), q = Math.floor(idx.length / 5);
  const m = (ids) => ids.reduce((a, i) => a + y[i], 0) / ids.length;
  const Q = [0, 1, 2, 3, 4].map((k) => m(idx.slice(k * q, k === 4 ? idx.length : (k + 1) * q)));
  return { Q, top_minus_bottom: Q[4] - Q[0] };
}

// Is the trend result timing skill or market exposure? (research only; GROSS daily returns, no costs, fixed sizing;
// REUSED Kraken data and REUSED rules -> diagnostic, not independent validation)
//   node edge-test.mjs <kraken-ohlcvt dir> <out.json>
// Tests, fixed before running:
//   1) regression of strategy daily return on the 50/50 BTC/ETH market return: beta, alpha (annualized), alpha 90 % CI by
//      block bootstrap (20-day blocks);
//   2) constant-exposure benchmark with the strategy's AVERAGE net exposure;
//   3) random-timing null: each asset's signal series circularly shifted by a random offset (>= 90 days), 2,000 draws;
//      keeps time in market and run lengths, destroys timing; p = share of shifted strategies with mean return >= actual;
//   4) period dependence: windows, and excluding 2017.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY } from "../lab/data.mjs";
import { sma } from "../dd2/bt.mjs";

const [KR, OUT] = process.argv.slice(2);
const load = (f) => loadKraken(join(KR, `${f}_1440.csv`), DAY).bars;
const K = { BTC: load("XBTUSD"), ETH: load("ETHUSD") };
const map = Object.fromEntries(Object.entries(K).map(([a, b]) => [a, new Map(b.map((x, i) => [x.t, i]))]));
const days = [...map.BTC.keys()].filter((t) => map.ETH.has(t)).sort((x, y) => x - y);
const series = {};
for (const a of ["BTC", "ETH"]) {
  const c = K[a].map((x) => x.c), S = sma(c, 200);
  series[a] = days.map((t) => { const i = map[a].get(t); return { t, ret: i > 0 ? c[i] / c[i - 1] - 1 : 0, sig: i > 0 && S[i - 1] !== null ? (c[i - 1] > S[i - 1] ? 1 : -1) : null }; });
}
// signal decided at the previous close applies to this day's close-to-close return
const strat = (longShort, shift = { BTC: 0, ETH: 0 }, idxs) => idxs.map((k) => {
  let r = 0;
  for (const a of ["BTC", "ETH"]) { const n = series[a].length, j = (k - shift[a] + n * 4) % n, s = series[a][j].sig; const w = s === null ? 0 : s > 0 ? 1 : longShort ? -1 : 0; r += 0.5 * w * series[a][k].ret; }
  return r;
});
const mkt = (idxs) => idxs.map((k) => 0.5 * series.BTC[k].ret + 0.5 * series.ETH[k].ret);
const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
function regress(y, x) { const mx = mean(x), my = mean(y); let c = 0, v = 0; for (let i = 0; i < x.length; i++) { c += (x[i] - mx) * (y[i] - my); v += (x[i] - mx) ** 2; } const b = c / v; return { beta: b, alpha: my - b * mx }; }
function bootAlpha(y, x, reps = 2000, block = 20) { let s = 99; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); const n = y.length, out = []; for (let r = 0; r < reps; r++) { const by = [], bx = []; while (by.length < n) { const st = Math.floor(rnd() * (n - block)); for (let k = 0; k < block && by.length < n; k++) { by.push(y[st + k]); bx.push(x[st + k]); } } out.push(regress(by, bx).alpha); } out.sort((a, b) => a - b); return [out[Math.floor(0.05 * reps)], out[Math.floor(0.95 * reps)]]; }
const ann = (d) => d * 365 * 100;
const res = { note: "GROSS (no costs), fixed sizing, REUSED data and rules: a diagnostic, not independent validation", tests: {} };
const WINDOWS = { "2017-01..2026-09": ["2017-01-01", "2026-10-01"], "2018-04..2026-09": ["2018-04-01", "2026-10-01"], "2022-01..2026-09": ["2022-01-01", "2026-10-01"], "2018-01..2026-09 (excl. 2017)": ["2018-01-01", "2026-10-01"] };
for (const [name, ls] of [["H1 trend long-only", false], ["H2 trend long/short", true]]) {
  res.tests[name] = {};
  for (const [wn, [a, b]] of Object.entries(WINDOWS)) {
    const idxs = days.map((t, k) => [t, k]).filter(([t]) => t >= Date.parse(a) && t < Date.parse(b) && series.BTC[days.indexOf(t)]?.sig !== null && series.ETH[days.indexOf(t)]?.sig !== null).map(([, k]) => k);
    const y = strat(ls, undefined, idxs), x = mkt(idxs), rg = regress(y, x), ci = bootAlpha(y, x);
    // average net exposure and constant-exposure benchmark
    const expo = mean(idxs.map((k) => ["BTC", "ETH"].reduce((s, as) => { const sg = series[as][k].sig; return s + 0.5 * (sg > 0 ? 1 : ls ? -1 : 0); }, 0)));
    const bench = x.map((r) => expo * r);
    // random-timing null (circular shifts >= 90 days)
    let s = 7; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const n = series.BTC.length, actual = mean(y); let ge = 0; const draws = [];
    for (let r = 0; r < 2000; r++) { const sh = { BTC: 90 + Math.floor(rnd() * (n - 180)), ETH: 90 + Math.floor(rnd() * (n - 180)) }; const m = mean(strat(ls, sh, idxs)); draws.push(m); if (m >= actual) ge++; }
    draws.sort((p, q) => p - q);
    const sharpe = (v) => (mean(v) / Math.sqrt(mean(v.map((z) => (z - mean(v)) ** 2)))) * Math.sqrt(365);
    res.tests[name][wn] = {
      days: idxs.length, strategy_mean_pct_per_yr: ann(actual), strategy_sharpe: sharpe(y), market_mean_pct_per_yr: ann(mean(x)), market_sharpe: sharpe(x),
      beta: rg.beta, alpha_pct_per_yr: ann(rg.alpha), alpha_ci90_pct_per_yr: ci.map(ann), alpha_ci_excludes_0: ci[0] > 0,
      avg_net_exposure: expo, constant_exposure_benchmark_pct_per_yr: ann(mean(bench)),
      random_timing_null: { p_value: ge / 2000, null_median_pct_per_yr: ann(draws[1000]), null_95th_pct_per_yr: ann(draws[1900]) },
    };
  }
}
writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
for (const [h, w] of Object.entries(res.tests)) for (const [wn, v] of Object.entries(w)) console.log(`${h.padEnd(20)} ${wn.padEnd(30)} strat ${v.strategy_mean_pct_per_yr.toFixed(1)}%/yr (Sh ${v.strategy_sharpe.toFixed(2)}) mkt ${v.market_mean_pct_per_yr.toFixed(1)}% (Sh ${v.market_sharpe.toFixed(2)}) beta ${v.beta.toFixed(2)} alpha ${v.alpha_pct_per_yr.toFixed(1)}% CI [${v.alpha_ci90_pct_per_yr.map((z) => z.toFixed(1))}] expo ${v.avg_net_exposure.toFixed(2)} bench ${v.constant_exposure_benchmark_pct_per_yr.toFixed(1)}% | null p ${v.random_timing_null.p_value.toFixed(3)} (null median ${v.random_timing_null.null_median_pct_per_yr.toFixed(1)}%, 95th ${v.random_timing_null.null_95th_pct_per_yr.toFixed(1)}%)`);

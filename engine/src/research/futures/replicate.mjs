// Cross-market replication of the frozen trend rules (docs/research/futures/REPLICATION-PREREGISTRATION.md).
// Research only; REUSED data (not independent validation); THEORETICAL PAPER ONLY for all net results.
//   node replicate.mjs <kraken-ohlcvt dir> <out.json>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, HOUR, DAY } from "../lab/data.mjs";
import { sma } from "../dd2/bt.mjs";
import { simulatePerp, longestRecoveryDays } from "./perp.mjs";

const [KR, OUT] = process.argv.slice(2);
const COINS = { XRP: "XRPUSD", XLM: "XLMUSD", LTC: "LTCUSD", XMR: "XMRUSD", ETC: "ETCUSD", ADA: "ADAUSD", BCH: "BCHUSD", ZEC: "ZECUSD", DASH: "DASHUSD", DOGE: "XDGUSD" };
const END = Date.parse("2026-10-01"), EX2017 = Date.parse("2018-01-01");
const mean = (x) => x.reduce((a, b) => a + b, 0) / (x.length || 1);
const ann = (d) => d * 365 * 100;
function regress(y, x) { const mx = mean(x), my = mean(y); let c = 0, v = 0; for (let i = 0; i < x.length; i++) { c += (x[i] - mx) * (y[i] - my); v += (x[i] - mx) ** 2; } const b = v > 0 ? c / v : 0; return { beta: b, alpha: my - b * mx }; }
function bootAlpha(y, x, reps = 2000, block = 20, seed = 99) { let s = seed; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); const n = y.length, out = []; if (n < 2 * block) return [NaN, NaN]; for (let r = 0; r < reps; r++) { const by = [], bx = []; while (by.length < n) { const st = Math.floor(rnd() * (n - block)); for (let k = 0; k < block && by.length < n; k++) { by.push(y[st + k]); bx.push(x[st + k]); } } out.push(regress(by, bx).alpha); } out.sort((a, b) => a - b); return [out[Math.floor(0.05 * reps)], out[Math.floor(0.95 * reps)]]; }
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); };
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);

// ---- per-coin daily series: return of day t and the signal decided at the previous close ----
const coins = {};
for (const [name, f] of Object.entries(COINS)) {
  const D = loadKraken(join(KR, `${f}_1440.csv`), DAY), Hh = loadKraken(join(KR, `${f}_60.csv`), HOUR);
  const K = D.bars, c = K.map((b) => b.c), S = sma(c, 200);
  const vol = c.map((_, i) => { if (i < 31) return null; const r = []; for (let j = i - 29; j <= i; j++) r.push(Math.log(c[j] / c[j - 1])); const m = mean(r); return Math.sqrt(r.reduce((p, q) => p + (q - m) ** 2, 0) / 29) * Math.sqrt(365); });
  const byDay = new Map();
  for (let i = 1; i < K.length; i++) { if (K[i].t >= END) break; if (S[i - 1] === null || vol[i - 1] === null || K[i].t - K[i - 1].t !== DAY) continue; byDay.set(K[i].t, { ret: c[i] / c[i - 1] - 1, sig: c[i - 1] > S[i - 1] ? 1 : -1, vol: vol[i - 1] }); }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  coins[name] = { name, H: Hh.bars, byDay, days, first: days[0], hourlyMissing: Hh.report.missing_bars, hourlyBars: Hh.report.bars, dailyMissing: D.report.missing_bars };
}
const weight = (rule, sizing, x) => { const size = sizing === "1x" ? 0.5 : Math.min(1.5, 0.106 / x.vol); return rule === "H1" ? (x.sig > 0 ? size : 0) : x.sig * size; };
const COSTS = {
  ideal: { fee: { mode: "ideal", pct: { X: 0.0029 }, perContract: { X: 0.5 }, contract: { X: 1 } }, spread: { X: 0.001 }, slip: 0.0002, liqSlip: 0.003, missProb: 0, liqFee: { pct: 0.005, perContract: 10 } },
  conservative: { fee: { mode: "conservative", pct: { X: 0.0029 }, perContract: { X: 0.5 }, contract: { X: 1 } }, spread: { X: 0.002 }, slip: 0.0005, liqSlip: 0.003, missProb: 0.02, liqFee: { pct: 0.005, perContract: 10 } },
};
const MARGIN = { init: { X: 0.1 }, maint: { X: 0.05 } };
function simulate(coin, rule, sizing, costName, compound, from) {
  const decide = (d) => { const x = coin.byDay.get(d); return x ? { X: weight(rule, sizing, x) } : null; };
  return simulatePerp([{ name: "X", H: coin.H, funding: () => 0.0001 / 8 }], decide, { capital: 100, compound, margin: MARGIN, band: 0.25, ...COSTS[costName] }, { from, to: END });
}
const res = { status: "THEORETICAL PAPER ONLY; REUSED data; not independent validation", prereg: "docs/research/futures/REPLICATION-PREREGISTRATION.md", coins: {}, pooled: {} };
for (const rule of ["H2", "H1"]) {
  const netDaily = {}, grossDaily = {};
  for (const coin of Object.values(coins)) {
    const out = { coverage: { signal_from: new Date(coin.first).toISOString().slice(0, 10), to: "2026-09-30", hourly_bars: coin.hourlyBars, hourly_missing: coin.hourlyMissing, daily_missing: coin.dailyMissing } };
    for (const [wName, from] of [["full", coin.first], ["excl_2017", Math.max(coin.first, EX2017)]]) {
      if (wName === "full" && coin.first >= EX2017) { out[wName] = { note: "no 2017 data: full window = excl_2017" }; continue; }
      const days = coin.days.filter((t) => t >= from), xs = days.map((t) => coin.byDay.get(t));
      const y = xs.map((x) => weight(rule, "1x", x) * x.ret), mkt = xs.map((x) => x.ret);
      const rg = regress(y, mkt), ci = bootAlpha(y, mkt);
      // random-timing null: circular shift of the signal over this window
      let s = 7; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); const n = xs.length, act = mean(y); let ge = 0;
      for (let k = 0; k < 2000; k++) { const sh = 90 + Math.floor(rnd() * Math.max(1, n - 180)); let m = 0; for (let i = 0; i < n; i++) { const sx = xs[(i + sh) % n]; m += weight(rule, "1x", { ...sx, vol: xs[i].vol }) * xs[i].ret; } if (m / n >= act) ge++; }
      // year concentration: alpha contribution per year, and alpha without the best year
      const years = {}; days.forEach((t, i) => { const yr = new Date(t).getUTCFullYear(); (years[yr] ??= []).push(y[i] - rg.beta * mkt[i]); });
      const contrib = Object.fromEntries(Object.entries(years).map(([yr, v]) => [yr, r2(ann(mean(v)))]));
      const best = Object.entries(contrib).sort((a, b) => b[1] - a[1])[0]?.[0];
      const keep = days.map((t, i) => [t, i]).filter(([t]) => String(new Date(t).getUTCFullYear()) !== best).map(([, i]) => i);
      const rgNoBest = regress(keep.map((i) => y[i]), keep.map((i) => mkt[i]));
      // net (simulator): fixed-size conservative for the net alpha; plus headline runs
      const fixedCons = simulate(coin, rule, "1x", "conservative", false, from);
      const netMap = new Map(fixedCons.daily.map(([t, e], i, arr) => [t, i ? (e - arr[i - 1][1]) / 100 : null]));
      const pairs = days.map((t) => [netMap.get(t), coin.byDay.get(t).ret]).filter(([a]) => a !== null && a !== undefined);
      const nrg = regress(pairs.map((p) => p[0]), pairs.map((p) => p[1])), nci = bootAlpha(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
      const runs = {};
      for (const sizing of ["1x", "vol-target 15%"]) for (const cn of ["ideal", "conservative"]) for (const compound of [true, false]) {
        if (!compound && cn === "ideal") continue;
        const r = simulate(coin, rule, sizing, cn, compound, from);
        runs[`${sizing} | ${cn} | ${compound ? "compounded" : "fixed"}`] = { cagr_pct: r2(r.cagr_pct), max_dd_pct: r2(r.dd_pct), worst_day_pct: r2(Math.min(...r.daily.slice(1).map((d, i) => (d[1] / r.daily[i][1] - 1) * 100))), trades: r.trades, longest_recovery_days: r2(longestRecoveryDays(r.daily)), liquidations: r.liquidations, final: r2(r.final), within_10pct: r.dd_pct <= 10, within_15pct: r.dd_pct <= 15 };
      }
      out[wName] = { days: n, passive_pct_per_yr: r2(ann(mean(mkt))), gross_strategy_pct_per_yr: r2(ann(act)), beta: r2(rg.beta), gross_alpha_pct_per_yr: r2(ann(rg.alpha)), gross_alpha_ci90: ci.map((v) => r2(ann(v))), random_timing_p: ge / 2000,
        net_alpha_pct_per_yr: r2(ann(nrg.alpha)), net_alpha_ci90: nci.map((v) => r2(ann(v))), alpha_by_year: contrib, best_year: best, gross_alpha_without_best_year: r2(ann(rgNoBest.alpha)), runs };
      if (wName === "excl_2017") { netDaily[coin.name] = new Map(pairs.length ? days.map((t) => [t, netMap.get(t)]).filter(([, v]) => v !== null && v !== undefined) : []); grossDaily[coin.name] = new Map(days.map((t, i) => [t, y[i]])); }
    }
    (res.coins[coin.name] ??= {})[rule] = out;
  }
  // ---- pooled (2018-01 .. 2026-09; equal weight across coins available that day) ----
  const grid = [...new Set(Object.values(coins).flatMap((c) => c.days.filter((t) => t >= EX2017)))].sort((a, b) => a - b);
  const pooledNet = [], pooledGross = [], pooledMkt = [];
  for (const t of grid) {
    const av = Object.values(coins).filter((c) => c.byDay.has(t) && netDaily[c.name].has(t)); if (!av.length) continue;
    pooledNet.push(mean(av.map((c) => netDaily[c.name].get(t)))); pooledGross.push(mean(av.map((c) => grossDaily[c.name].get(t)))); pooledMkt.push(mean(av.map((c) => c.byDay.get(t).ret)));
  }
  const prg = regress(pooledNet, pooledMkt), pci = bootAlpha(pooledNet, pooledMkt), grg = regress(pooledGross, pooledMkt), gci = bootAlpha(pooledGross, pooledMkt);
  // pooled random-timing null: the SAME shift for every coin on the common grid (keeps cross-coin correlation of positions)
  let s = 11; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); const G = grid.length; let ge = 0; const actual = mean(pooledGross);
  for (let k = 0; k < 1000; k++) { const sh = 90 + Math.floor(rnd() * (G - 180)); const v = []; for (let i = 0; i < G; i++) { const t = grid[i], ts = grid[(i + sh) % G]; const av = Object.values(coins).filter((c) => c.byDay.has(t) && c.byDay.has(ts)); if (!av.length) continue; v.push(mean(av.map((c) => weight(rule, "1x", { ...c.byDay.get(ts), vol: c.byDay.get(t).vol }) * c.byDay.get(t).ret))); } if (mean(v) >= actual) ge++; }
  // correlation of coin strategy returns and effective N
  const names = Object.keys(coins), common = grid.filter((t) => names.every((n) => grossDaily[n].has(t)));
  const M = names.map((a) => names.map((b) => corr(common.map((t) => grossDaily[a].get(t)), common.map((t) => grossDaily[b].get(t)))));
  const sumRho = M.flat().reduce((p, q) => p + q, 0), nEff = (names.length ** 2) / sumRho;
  const offDiag = M.flatMap((row, i) => row.filter((_, j) => j !== i));
  // pooled drawdown (equal-weight combination of fixed-size $100 accounts; close-based) per sizing, conservative costs
  const pooledDD = {};
  for (const sizing of ["1x", "vol-target 15%"]) {
    const curves = Object.values(coins).map((c) => new Map(simulate(c, rule, sizing, "conservative", false, Math.max(c.first, EX2017)).daily));
    let pk = -Infinity, md = 0; const series = [];
    for (const t of grid) { const vals = curves.map((m) => m.get(t) ?? null); const have = vals.filter((v) => v !== null); if (have.length < names.length) continue; const v = mean(have); series.push([t, v]); pk = Math.max(pk, v); md = Math.max(md, 1 - v / pk); }
    pooledDD[sizing] = { from: series[0] ? new Date(series[0][0]).toISOString().slice(0, 10) : null, max_dd_close_pct: r2(md * 100), total_return_pct: series.length ? r2((series.at(-1)[1] / series[0][1] - 1) * 100) : null };
  }
  const positiveNet = names.filter((n) => res.coins[n][rule].excl_2017.net_alpha_pct_per_yr > 0).length;
  const fullPos = names.filter((n) => (res.coins[n][rule].full.net_alpha_pct_per_yr ?? res.coins[n][rule].excl_2017.net_alpha_pct_per_yr) > 0).length;
  res.pooled[rule] = { window: "2018-01-01..2026-09-30", days: pooledNet.length, net_alpha_pct_per_yr: r2(ann(prg.alpha)), net_alpha_ci90: pci.map((v) => r2(ann(v))), net_beta: r2(prg.beta), gross_alpha_pct_per_yr: r2(ann(grg.alpha)), gross_alpha_ci90: gci.map((v) => r2(ann(v))), pooled_random_timing_p: ge / 1000,
    coins_positive_net_alpha_excl_2017: positiveNet, coins_positive_net_alpha_full: fullPos, mean_pairwise_correlation: r2(mean(offDiag)), effective_independent_coins: r2(nEff), pooled_drawdown_conservative_fixed: pooledDD, common_days_for_correlation: common.length };
}
writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
for (const rule of ["H2", "H1"]) { console.log(`\n=== ${rule} pooled`, JSON.stringify(res.pooled[rule])); for (const [n, v] of Object.entries(res.coins)) { const e = v[rule].excl_2017, f = v[rule].full; console.log(`${n.padEnd(5)} from ${v[rule].coverage.signal_from} | excl2017: gross a ${e.gross_alpha_pct_per_yr}% [${e.gross_alpha_ci90}] p ${e.random_timing_p} net a ${e.net_alpha_pct_per_yr}% [${e.net_alpha_ci90}] noBest ${e.gross_alpha_without_best_year}% (best ${e.best_year}) | full: ${f.note ?? `net a ${f.net_alpha_pct_per_yr}% p ${f.random_timing_p}`} | vol-cons-cmp ${JSON.stringify(e.runs["vol-target 15% | conservative | compounded"])}`); } }

#!/usr/bin/env node
// RESEARCH ROUND 2 driver. Protocol fixed BEFORE looking at any result:
//   development  2021-07-01 .. 2023-12-31  (2021 bull top, 2022 bear, 2023 recovery)  -> parameter selection
//   validation   2024-01-01 .. 2025-06-30  -> pass/fail gate for the selected setting (no re-tuning)
//   final test   2025-07-01 .. 2026-11-14  -> untouched; every selected setting is run on it exactly ONCE
// Selection = robustness, not the maximum: a setting qualifies on development only if it AND every one-step neighbour
// in the grid is net positive; the qualifying setting with the MEDIAN development net is chosen. Costs for selection:
// 0.20 % per fill + 0.05 % slippage; risk 2 % of strategy equity per trade; $100 capital.
import { readFileSync, writeFileSync } from "node:fs";
import { buyHold, metrics, simulate, to4h } from "./r2.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = arg("data"), OUT = arg("out");
const load = (f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
const D = Date.parse;
const P = { dev: [D("2021-07-01"), D("2024-01-01")], val: [D("2024-01-01"), D("2025-07-01")], test: [D("2025-07-01"), D("2026-11-15")] };
const SEL = { fee: 0.2, slip: 0.05 }, RISK = 2, CAP = 100;
const COSTS = [{ fee: 0.2, slip: 0.05 }, { fee: 0.2, slip: 0.15 }, { fee: 0.4, slip: 0.05 }, { fee: 0.4, slip: 0.15 }];

const data = {};
const quality = {};
for (const [asset, prod] of [["SOL", "SOL-USD"], ["BTC", "BTC-USD"]]) {
  const h = load(`${prod}-3600.json`), d = load(`${prod}-86400.json`);
  const f4 = to4h(h.candles);
  data[asset] = { "4h": { K: f4.candles, barMs: 14_400_000 }, "1d": { K: d.candles, barMs: 86_400_000 } };
  quality[asset] = { "1h": h.meta, "1d": d.meta, "4h_partial_buckets": f4.partial };
}

// Reasonable, small grids (economically motivated ranges, not thousands of combinations).
const GRIDS = {
  donchian: { "4h": { n: [20, 55, 100], k: [2, 3], trail: [0, 3] }, "1d": { n: [20, 55], k: [2, 3], trail: [0, 3] } },
  ma: { "4h": { n: [100, 200, 300], k: [2, 3], trail: [0, 3] }, "1d": { n: [50, 100, 200], k: [2, 3], trail: [0, 3] } },
  cross: { "4h": { fs: ["20/50", "50/200"], k: [2, 3], trail: [0, 3] }, "1d": { fs: ["20/50", "50/200"], k: [2, 3], trail: [0, 3] } },
  pullback: { "4h": { r: [35, 40, 45], k: [2, 3], trail: [0, 3] }, "1d": { r: [35, 40, 45], k: [2, 3], trail: [0, 3] } },
};
const expand = (g) => Object.entries(g).reduce((acc, [k, vs]) => acc.flatMap((a) => vs.map((v) => ({ ...a, [k]: v }))), [{}]);
const params = (family, c, short) => {
  const p = { ...c, short };
  if (family === "donchian") p.m = Math.round(c.n / 2);
  if (family === "cross") { const [f, s] = c.fs.split("/").map(Number); p.f = f; p.s = s; }
  return p;
};
const key = (c) => JSON.stringify(c);
const neighbours = (grid, c) => {
  const out = [];
  for (const [k, vs] of Object.entries(grid)) { const i = vs.indexOf(c[k]); for (const j of [i - 1, i + 1]) if (j >= 0 && j < vs.length) out.push({ ...c, [k]: vs[j] }); }
  return out;
};
const run = (asset, tf, family, c, short, [a, b], { fee, slip } = SEL, risk = RISK, capital = CAP) => {
  const { K, barMs } = data[asset][tf];
  const r = simulate({ K, barMs, family, p: params(family, c, short), capital, asset, fee, slip, riskPct: risk, fromMs: a, toMs: b });
  return { r, m: metrics(r, capital) };
};

// Market regimes: calendar quarters of the asset; bull > +15 %, bear < -15 %, else sideways; volatility = daily-return
// standard deviation above / below the median quarter. Each trade is assigned by its entry time.
const regimes = {};
for (const asset of ["SOL", "BTC"]) {
  const K = data[asset]["1d"].K, q = new Map();
  for (const k of K) { const d = new Date(k.t), id = `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`; (q.get(id) ?? q.set(id, []).get(id)).push(k); }
  const rows = [...q.entries()].map(([id, ks]) => {
    const ret = ks.at(-1).c / ks[0].o - 1, rs = ks.slice(1).map((k, i) => Math.log(k.c / ks[i].c));
    const sd = Math.sqrt(rs.reduce((s, v) => s + v * v, 0) / Math.max(1, rs.length));
    return { id, from: ks[0].t, to: ks.at(-1).t + 86_400_000, ret, sd };
  });
  const med = [...rows.map((r) => r.sd)].sort((a, b) => a - b)[rows.length >> 1];
  regimes[asset] = rows.map((r) => ({ ...r, trend: r.ret > 0.15 ? "bull" : r.ret < -0.15 ? "bear" : "sideways", vol: r.sd >= med ? "high vol" : "low vol" }));
}
const byRegime = (asset, trades) => {
  const out = {};
  for (const t of trades) {
    const q = regimes[asset].find((r) => t.entryT >= r.from && t.entryT < r.to);
    if (!q) continue;
    for (const k of [q.trend, q.vol]) { const o = (out[k] ??= { trades: 0, net: 0 }); o.trades++; o.net = +(o.net + t.net).toFixed(2); }
  }
  return out;
};

const results = [];
for (const asset of ["SOL", "BTC"]) for (const tf of ["4h", "1d"]) for (const family of Object.keys(GRIDS)) for (const short of [false, true]) {
  const grid = GRIDS[family][tf], configs = expand(grid);
  const dev = new Map(configs.map((c) => [key(c), run(asset, tf, family, c, short, P.dev).m]));
  const positive = configs.filter((c) => dev.get(key(c)).net > 0 && dev.get(key(c)).trades >= 10);
  const robust = positive.filter((c) => neighbours(grid, c).every((n) => dev.get(key(n)).net > 0));
  const pick = robust.length ? [...robust].sort((a, b) => dev.get(key(a)).net - dev.get(key(b)).net)[Math.floor((robust.length - 1) / 2)] : null;
  const row = { asset, tf, family, mode: short ? "LONG+SHORT" : "LONG only", grid_size: configs.length,
    dev_positive: positive.length, dev_robust: robust.length, chosen: pick,
    dev_grid: configs.map((c) => ({ c, net: dev.get(key(c)).net, trades: dev.get(key(c)).trades, pf: dev.get(key(c)).profit_factor })) };
  if (pick) {
    row.dev = dev.get(key(pick));
    row.val = run(asset, tf, family, pick, short, P.val).m;
    row.val_neighbours = neighbours(grid, pick).map((n) => ({ c: n, net: run(asset, tf, family, n, short, P.val).m.net }));
    // Walk-forward stability over development + validation: 12-month windows every 6 months.
    row.walk_forward = [];
    for (let a = D("2021-07-01"); a + 365 * 86_400_000 <= P.val[1]; a += 182 * 86_400_000) {
      const m = run(asset, tf, family, pick, short, [a, a + 365 * 86_400_000]).m;
      row.walk_forward.push({ from: new Date(a).toISOString().slice(0, 10), net: m.net, trades: m.trades, pf: m.profit_factor });
    }
    row.passes_validation = row.val.net > 0 && (row.val.profit_factor ?? 0) > 1 && row.val.trades >= 10;
    // FINAL TEST (run once per selected setting, whatever validation said; the verdict uses passes_validation first).
    const t = run(asset, tf, family, pick, short, P.test);
    row.test = t.m;
    row.test_costs = COSTS.map((cost) => ({ ...cost, ...run(asset, tf, family, pick, short, P.test, cost).m }));
    row.test_risk1 = run(asset, tf, family, pick, short, P.test, SEL, 1).m;
    row.test_capital = [20, 50, 100].map((cap) => ({ capital: cap, ...run(asset, tf, family, pick, short, P.test, SEL, RISK, cap).m }));
    row.test_neighbours = neighbours(grid, pick).map((n) => ({ c: n, net: run(asset, tf, family, n, short, P.test).m.net }));
    const full = run(asset, tf, family, pick, short, [P.dev[0], P.test[1]]);
    row.regimes_all_periods = byRegime(asset, full.r.trades);
    row.test_equity = t.r.equity.filter((_, i) => i % (tf === "4h" ? 6 : 1) === 0).map(([tt, v]) => [tt, +v.toFixed(2)]);
  }
  results.push(row);
  console.error(`${asset} ${tf} ${family} ${row.mode}: dev+ ${row.dev_positive}/${row.grid_size} robust ${row.dev_robust} ${pick ? `chosen ${key(pick)} val ${row.val.net} (${row.passes_validation ? "PASS" : "fail"}) test ${row.test.net} n=${row.test.trades}` : "no robust setting"}`);
}

// Benchmarks (same costs: 0.20 % fee + 0.05 % slippage on each fill), per period.
const bench = {};
for (const [name, [a, b]] of Object.entries(P)) {
  const bh = (asset, cap = CAP) => buyHold(data[asset]["1d"].K, { capital: cap, fee: SEL.fee, slip: SEL.slip, fromMs: a, toMs: b });
  const sol = bh("SOL"), btc = bh("BTC"), s50 = bh("SOL", 50), b50 = bh("BTC", 50);
  const trend = (asset) => { const { m, r } = run(asset, "1d", "ma", { n: 200, k: 50, trail: 0 }, false, [a, b], SEL, 100); return { ...m, equity: r.equity.map(([t, v]) => [t, +v.toFixed(2)]) }; };
  bench[name] = { cash: { net: 0, return_pct: 0, max_dd_pct: 0 },
    buy_hold_SOL: { net: sol.net, return_pct: sol.return_pct, max_dd_pct: sol.max_dd_pct, equity: name === "test" ? sol.equity.map(([t, v]) => [t, +v.toFixed(2)]) : undefined },
    buy_hold_BTC: { net: btc.net, return_pct: btc.return_pct, max_dd_pct: btc.max_dd_pct, equity: name === "test" ? btc.equity.map(([t, v]) => [t, +v.toFixed(2)]) : undefined },
    buy_hold_50_50: { net: +(s50.net + b50.net).toFixed(2), return_pct: +((s50.net + b50.net)).toFixed(1) },
    trend_SMA200_long_only_BTC: (({ equity, ...m }) => ({ ...m, equity: name === "test" ? equity : undefined }))(trend("BTC")),
    trend_SMA200_long_only_SOL: (({ equity, ...m }) => ({ ...m, equity: name === "test" ? equity : undefined }))(trend("SOL")),
  };
}
writeFileSync(OUT, JSON.stringify({ label: "RESEARCH ROUND 2 (Coinbase candles; not PAPER results)", protocol: { periods: Object.fromEntries(Object.entries(P).map(([k, [a, b]]) => [k, [new Date(a).toISOString().slice(0, 10), new Date(b - 1).toISOString().slice(0, 10)]])), selection_costs: SEL, risk_pct: RISK, capital: CAP, costs_tested: COSTS }, data_quality: quality, regimes, results, benchmarks: bench }, null, 1));
console.error("written", OUT);

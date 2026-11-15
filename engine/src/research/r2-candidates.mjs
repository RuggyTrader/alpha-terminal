#!/usr/bin/env node
// Round 2, after selection: the validated candidates that were positive on the final test, examined for what a real
// implementation would face. Nothing here selects or re-tunes anything (the settings are those chosen on development).
//   * SHORT financing: a real spot short is a margin loan (Kraken-style rollover per 4 h); 0, 0.01 % and 0.02 % per 4 h.
//   * LONG vs SHORT contribution; the long-only twin of the same rule.
//   * $100 portfolio variants ($100 concentrated, $50 + $50 BTC/SOL) at 1 % and 2 % risk.
//   * Final-test equity curves of the candidates and of the benchmarks (daily samples).
import { readFileSync, writeFileSync } from "node:fs";
import { buyHold, metrics, simulate, to4h } from "./r2.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = arg("data"), OUT = arg("out");
const load = (f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")).candles;
const D = Date.parse;
const P = { dev: [D("2021-07-01"), D("2024-01-01")], val: [D("2024-01-01"), D("2025-07-01")], test: [D("2025-07-01"), D("2026-11-15")] };
const data = {
  BTC: { "1d": { K: load("BTC-USD-86400.json"), barMs: 86_400_000 }, "4h": { K: to4h(load("BTC-USD-3600.json")).candles, barMs: 14_400_000 } },
  SOL: { "1d": { K: load("SOL-USD-86400.json"), barMs: 86_400_000 }, "4h": { K: to4h(load("SOL-USD-3600.json")).candles, barMs: 14_400_000 } },
};
const run = (c, period, o = {}) => {
  const { K, barMs } = data[c.asset][c.tf];
  const r = simulate({ K, barMs, family: c.family, p: c.p, capital: o.capital ?? 100, asset: c.asset, fee: o.fee ?? 0.2, slip: o.slip ?? 0.05, riskPct: o.risk ?? 2, fromMs: P[period][0], toMs: P[period][1], borrow4h: o.borrow ?? 0 });
  return { r, m: metrics(r, o.capital ?? 100) };
};
const side = (r, s) => +r.trades.filter((t) => t.side === s).reduce((a, t) => a + t.net, 0).toFixed(2);
const CANDS = [
  { id: "BTC 1d MA-50 trend, LONG+SHORT", asset: "BTC", tf: "1d", family: "ma", p: { n: 50, k: 3, trail: 3, short: true } },
  { id: "BTC 4h trend pullback, LONG+SHORT", asset: "BTC", tf: "4h", family: "pullback", p: { r: 35, k: 3, trail: 0, short: true } },
  { id: "SOL 1d trend pullback, LONG+SHORT", asset: "SOL", tf: "1d", family: "pullback", p: { r: 45, k: 3, trail: 3, short: true } },
];
const out = { candidates: [], portfolios: [], curves: {} };
for (const c of CANDS) {
  const row = { id: c.id, settings: c.p, periods: {} };
  for (const per of ["dev", "val", "test"]) {
    const base = run(c, per), b1 = run(c, per, { borrow: 0.01 }), b2 = run(c, per, { borrow: 0.02 });
    const longOnly = run({ ...c, p: { ...c.p, short: false } }, per);
    row.periods[per] = { no_borrow: base.m, borrow_001_per_4h: b1.m, borrow_002_per_4h: b2.m, long_net: side(base.r, "LONG"), short_net: side(base.r, "SHORT"),
      short_borrow_cost_002: +b2.r.trades.reduce((a, t) => a + (t.borrow ?? 0), 0).toFixed(2), long_only_twin: longOnly.m };
  }
  row.test_costs_with_borrow_002 = [[0.2, 0.05], [0.2, 0.15], [0.4, 0.05], [0.4, 0.15]].map(([fee, slip]) => ({ fee, slip, net: run(c, "test", { fee, slip, borrow: 0.02 }).m.net }));
  row.test_risk = [1, 2, 3].map((risk) => ({ risk, ...(({ net, max_dd_pct, trades }) => ({ net, max_dd_pct, trades }))(run(c, "test", { risk, borrow: 0.02 }).m) }));
  const eq = run(c, "test", { borrow: 0.02 }).r.equity, step = c.tf === "4h" ? 6 : 1;
  out.curves[c.id + " (borrow 0.02%/4h)"] = eq.filter((_, i) => i % step === 0).map(([t, v]) => [t, +v.toFixed(2)]);
  out.curves[c.id + " LONG only"] = run({ ...c, p: { ...c.p, short: false } }, "test").r.equity.filter((_, i) => i % step === 0).map(([t, v]) => [t, +v.toFixed(2)]);
  out.candidates.push(row);
  console.error(c.id, "test net", row.periods.test.no_borrow.net, "with borrow 0.02:", row.periods.test.borrow_002_per_4h.net, "L/S", row.periods.test.long_net, row.periods.test.short_net, "long-only twin", row.periods.test.long_only_twin.net);
}
// $100 portfolios on the final test (borrow 0.02 % / 4 h on shorts; 0.20 % + 0.05 %).
const ma = (asset, short) => ({ asset, tf: "1d", family: "ma", p: { n: 50, k: 3, trail: 3, short } });
for (const [name, legs] of [
  ["$100 BTC MA-50 L+S", [[ma("BTC", true), 100]]],
  ["$100 BTC MA-50 long only", [[ma("BTC", false), 100]]],
  ["$50 BTC + $50 SOL MA-50 L+S", [[ma("BTC", true), 50], [ma("SOL", true), 50]]],
  ["$50 BTC + $50 SOL MA-50 long only", [[ma("BTC", false), 50], [ma("SOL", false), 50]]],
]) {
  for (const risk of [1, 2]) {
    const runs = legs.map(([c, cap]) => run(c, "test", { capital: cap, risk, borrow: 0.02 }));
    const net = runs.reduce((a, x) => a + x.m.net, 0), trades = runs.reduce((a, x) => a + x.m.trades, 0);
    // combined drawdown on the summed daily equity
    const days = new Map(); for (const x of runs) for (const [t, v] of x.r.equity) days.set(t, (days.get(t) ?? 0) + v);
    let peak = 0, dd = 0; for (const v of [...days.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) { peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); }
    out.portfolios.push({ name, risk, net: +net.toFixed(2), trades, max_dd_pct: +(dd * 100).toFixed(1), skipped_min: runs.reduce((a, x) => a + x.m.skipped_min_size, 0) });
  }
}
const bh = (asset) => buyHold(data[asset]["1d"].K, { capital: 100, fee: 0.2, slip: 0.05, fromMs: P.test[0], toMs: P.test[1] }).equity.map(([t, v]) => [t, +v.toFixed(2)]);
out.curves["Buy and hold BTC"] = bh("BTC"); out.curves["Buy and hold SOL"] = bh("SOL");
out.curves["Cash"] = out.curves["Buy and hold BTC"].map(([t]) => [t, 100]);
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const p of out.portfolios) console.error(p);

// DD2 driver: applies the pre-registered selection (docs/research/dd2/PREREGISTRATION.md) mechanically.
//   node src/research/dd2/run.mjs --data <engine/data> --out <results.json>
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COSTS, DAY, MIN_QTY, PERIODS, STRESS, backtest, grid, specId } from "./bt.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DATA = arg("--data"), OUT = arg("--out");
const hashes = {};
function load(asset) {
  const by = new Map();
  for (const f of [join(DATA, "strategy-select", `${asset}-USD-86400-pre2021.json`), join(DATA, "research2", `${asset}-USD-86400.json`)]) {
    let raw; try { raw = readFileSync(f); } catch { continue; }
    hashes[f.split(/[\\/]/).slice(-2).join("/")] = createHash("sha256").update(raw).digest("hex");
    for (const k of JSON.parse(raw).candles) by.set(k.t, k);
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}
const K = { BTC: load("BTC"), ETH: load("ETH"), SOL: load("SOL") };
const U = { "BTC": [{ name: "BTC", K: K.BTC, minQty: MIN_QTY.BTC }], "BTC+ETH+SOL": ["BTC", "ETH", "SOL"].map((n) => ({ name: n, K: K[n], minQty: MIN_QTY[n] })) };
const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
const summary = (r) => ({ start: 100, final: r2(r.final), net: r2(r.net), ret_pct: r2(r.ret_pct), cagr_pct: r2(r.cagr_pct), dd_pct: r3(r.dd_pct), dd_close_pct: r3(r.dd_close_pct),
  trades: r.trades, wins: r.wins, fees: r2(r.fees), skipped_below_min: r.skipped, exposure_pct: r2(r.exposure_pct), open_at_end: r.open_at_end });
const run = (uni, spec, [from, to], cost = COSTS.base) => backtest(U[uni], spec, { from, to, ...cost });
const ok = (r, minTrades) => r.dd_pct < 2 && r.net > 0 && r.trades >= minTrades;

const G = grid();
const t0 = Date.now();
// 1) training: every configuration on both universes
const train = [];
for (const uni of Object.keys(U)) for (const spec of G) { const r = run(uni, spec, PERIODS.train); train.push({ uni, spec, id: `${uni} · ${specId(spec)}`, r }); }
const eligibleTrain = train.filter((x) => ok(x.r, 10));
const kept = [];
for (const fam of ["T", "M", "R", "B", "V"]) for (const uni of Object.keys(U)) kept.push(...eligibleTrain.filter((x) => x.spec.family === fam && x.uni === uni).sort((a, b) => b.r.net - a.r.net || a.r.dd_pct - b.r.dd_pct).slice(0, 3));
// 2) validation
const val = kept.map((x) => ({ ...x, v: run(x.uni, x.spec, PERIODS.validation) }));
const eligibleVal = val.filter((x) => ok(x.v, 5)).sort((a, b) => b.v.net - a.v.net || a.v.dd_pct - b.v.dd_pct);
const five = [], perFam = {};
for (const x of eligibleVal) { if ((perFam[x.spec.family] ?? 0) >= 2) continue; perFam[x.spec.family] = (perFam[x.spec.family] ?? 0) + 1; five.push(x); if (five.length === 5) break; }
// 3) test: evaluated once, for the five only
const cands = five.map((x, rank) => {
  const te = run(x.uni, x.spec, PERIODS.test);
  const stress = Object.fromEntries(Object.entries(STRESS).map(([k, [a, b]]) => [k, summary(run(x.uni, x.spec, [Date.parse(a), Date.parse(b)]))]));
  const costs = Object.fromEntries(Object.entries(COSTS).map(([k, c]) => [k, Object.fromEntries(Object.entries(PERIODS).map(([p, w]) => [p, summary(run(x.uni, x.spec, w, c))]))]));
  const full = run(x.uni, x.spec, [PERIODS.train[0], PERIODS.test[1]]);
  return { rank: rank + 1, id: x.id, universe: x.uni, spec: x.spec, train: summary(x.r), validation: summary(x.v), test: summary(te), test_pass: te.dd_pct < 2 && te.net > 0,
    full_2016_2026: summary(full), total_trades: x.r.trades + x.v.trades + te.trades, stress, costs };
});
// 4) benchmarks (same periods, fresh $100)
const S3 = { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 };
const s3U = { name: "BTC+ETH", a: ["BTC", "ETH"].map((n) => ({ name: n, K: K[n], minQty: MIN_QTY[n] })) };
const bench = {};
for (const [p, w] of Object.entries(PERIODS)) {
  const s3 = (cost) => summary(backtest(s3U.a, S3, { from: w[0], to: w[1], ...cost }));
  const bh = (() => { const f = COSTS.base.fee, s = COSTS.base.slip, legs = ["BTC", "ETH"].map((n) => { const k0 = K[n].find((k) => k.t >= w[0]), k1 = [...K[n]].reverse().find((k) => k.t < w[1]); return { q: 50 / (k0.o * (1 + s) * (1 + f)), K: K[n].filter((k) => k.t >= w[0] && k.t < w[1]), end: k1.c }; });
    let pk = 0, dd = 0; const days = legs[0].K.map((k) => k.t); for (const t of days) { const eq = legs.reduce((sum, l) => sum + l.q * (l.K.find((k) => k.t === t)?.c ?? l.end), 0); pk = Math.max(pk, eq); dd = Math.max(dd, 1 - eq / pk); }
    const fin = legs.reduce((sum, l) => sum + l.q * l.end * (1 - s) * (1 - f), 0); return { start: 100, final: r2(fin), net: r2(fin - 100), dd_close_pct: r3(dd * 100) }; })();
  bench[p] = { S3_paper_costs: s3(COSTS.paper), S3_base_costs: s3(COSTS.base), buy_and_hold_BTC_ETH: bh, cash: { start: 100, final: 100, net: 0, dd_pct: 0 } };
}
// 5) what the drawdown limit does to each family: the best configuration per family over 2016-2026 (illustration, NOT selection)
const frontier = {};
for (const fam of ["T", "M", "R", "B", "V"]) {
  const rows = train.filter((x) => x.spec.family === fam).map((x) => ({ x, f: run(x.uni, x.spec, [PERIODS.train[0], PERIODS.test[1]]) }));
  const under2 = rows.filter((y) => y.f.dd_pct < 2).sort((a, b) => b.f.net - a.f.net)[0];
  const best = rows.sort((a, b) => b.f.net - a.f.net)[0];
  frontier[fam] = { best_any_dd: best && { id: best.x.id, ...summary(best.f) }, best_under_2pct: under2 ? { id: under2.x.id, ...summary(under2.f) } : null };
}
const winner = cands[0] ?? null;
const out = {
  generated_by: "engine/src/research/dd2/run.mjs", preregistration: "docs/research/dd2/PREREGISTRATION.md", data_sha256: hashes,
  periods: Object.fromEntries(Object.entries(PERIODS).map(([k, [a, b]]) => [k, [new Date(a).toISOString().slice(0, 10), new Date(b - DAY).toISOString().slice(0, 10)]])),
  grid_size: G.length * Object.keys(U).length,
  counts: { trained: train.length, eligible_after_training: eligibleTrain.length, kept_for_validation: kept.length, eligible_after_validation: eligibleVal.length },
  training_eligible_by_family: Object.fromEntries(["T", "M", "R", "B", "V"].map((f) => [f, eligibleTrain.filter((x) => x.spec.family === f).length])),
  validation_all: val.map((x) => ({ id: x.id, train: summary(x.r), validation: summary(x.v), eligible: ok(x.v, 5) })),
  candidates: cands,
  winner: winner ? { id: winner.id, test_pass: winner.test_pass, activity_ok: winner.total_trades >= 30 } : null,
  benchmarks: bench, frontier_post_hoc_not_selection: frontier,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`runs done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(JSON.stringify(out.counts), JSON.stringify(out.training_eligible_by_family));
for (const c of cands) console.log(`#${c.rank} ${c.id}\n   train ${JSON.stringify(c.train)}\n   valid ${JSON.stringify(c.validation)}\n   TEST  ${JSON.stringify(c.test)} pass=${c.test_pass} total trades ${c.total_trades}`);
console.log("benchmarks", JSON.stringify(bench));
console.log("frontier", JSON.stringify(frontier));

// DD2 frontier (docs/research/dd2/FRONTIER-PREREGISTRATION.md): the DD2 protocol at drawdown limits 2/3/5/10/15 %, with
// the pre-registered robustness diagnostics. Research only.
//   node src/research/dd2/frontier.mjs --data <engine/data> --out <frontier-results.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COSTS, MIN_QTY, PERIODS, backtest, grid, specId } from "./bt.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DATA = arg("--data"), OUT = arg("--out");
function load(a) { const m = new Map(); for (const f of [join(DATA, "strategy-select", `${a}-USD-86400-pre2021.json`), join(DATA, "research2", `${a}-USD-86400.json`)]) { try { for (const k of JSON.parse(readFileSync(f)).candles) m.set(k.t, k); } catch { /* absent */ } } return [...m.values()].sort((x, y) => x.t - y.t); }
const K = { BTC: load("BTC"), ETH: load("ETH"), SOL: load("SOL") };
const U = { "BTC": [{ name: "BTC", K: K.BTC, minQty: MIN_QTY.BTC }], "BTC+ETH+SOL": ["BTC", "ETH", "SOL"].map((n) => ({ name: n, K: K[n], minQty: MIN_QTY[n] })) };
const FULL = [PERIODS.train[0], PERIODS.test[1]];
const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
const brief = (r) => ({ final: r2(r.final), net: r2(r.net), cagr_pct: r2(r.cagr_pct), dd_pct: r3(r.dd_pct), trades: r.trades, fees: r2(r.fees) });
const CAPS = [2, 3, 5, 10, 15];

// every configuration, every period, once
const all = [];
for (const uni of Object.keys(U)) for (const spec of grid()) {
  const res = Object.fromEntries(Object.entries(PERIODS).map(([p, w]) => [p, backtest(U[uni], spec, { from: w[0], to: w[1], ...COSTS.base })]));
  all.push({ uni, spec, id: `${uni} · ${specId(spec)}`, res });
}
const ok = (r, C, minT) => r.dd_pct < C && r.net > 0 && r.trades >= minT;
const consistent = (x, C) => ok(x.res.train, C, 10) && ok(x.res.validation, C, 5) && x.res.test.dd_pct < C && x.res.test.net > 0;

// neighbours: one setting one step away
const LADDER = { n: [20, 50, 100, 200], L: [14, 28, 56, 90], th: [0, 0.05, 0.1], x: [5, 10, 15, 25], N: [20, 55, 100], M: [10, 20], k: [1.5, 2, 3], r: [0.1, 0.25, 0.5, 1], cb: [0, 1.5], tv: [0.05, 0.1, 0.2, 0.4] };
const flat = (s) => ({ ...s.p, ...(s.family === "V" ? { cb: s.cb } : { k: s.k, trail: s.trail, r: s.r, cb: s.cb }), ...(s.family === "V" ? { n: s.p.n === 100 || s.p.n === 200 ? s.p.n : s.p.n } : {}) });
function isNeighbour(a, b) {
  if (a.uni !== b.uni || a.spec.family !== b.spec.family || a === b) return false;
  const fa = flat(a.spec), fb = flat(b.spec); let diff = 0, adjacent = true;
  for (const k of Object.keys(fa)) {
    if (fa[k] === fb[k]) continue; diff++;
    if (typeof fa[k] === "boolean") continue;
    const lad = a.spec.family === "V" && k === "n" ? [100, 200] : LADDER[k];
    if (!lad || Math.abs(lad.indexOf(fa[k]) - lad.indexOf(fb[k])) !== 1) adjacent = false;
  }
  return diff === 1 && adjacent;
}
function reshuffleP(spec, uni, C) {
  const r = backtest(U[uni], spec, { from: FULL[0], to: FULL[1], ...COSTS.base });
  const days = r.curve.map((x) => x[0]);
  const rets = r.trade_list.map((tr) => { const i = days.indexOf(tr.entryT); return tr.net / (i > 0 ? r.curve[i - 1][1] : 100); });
  if (rets.length < 5) return { trades: rets.length, p_dd_over_cap: null };
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let over = 0; const sims = 20000;
  for (let s = 0; s < sims; s++) { let e = 1, pk = 1, dd = 0; for (let j = 0; j < rets.length; j++) { e *= 1 + rets[Math.floor(rnd() * rets.length)]; pk = Math.max(pk, e); dd = Math.max(dd, 1 - e / pk); } if (dd * 100 > C) over++; }
  return { trades: rets.length, p_dd_over_cap: r3(over / sims), full: brief(r) };
}

const frontier = [];
for (const C of CAPS) {
  const eligT = all.filter((x) => ok(x.res.train, C, 10));
  const kept = [];
  for (const fam of ["T", "M", "R", "B", "V"]) for (const uni of Object.keys(U)) kept.push(...eligT.filter((x) => x.spec.family === fam && x.uni === uni).sort((a, b) => b.res.train.net - a.res.train.net || a.res.train.dd_pct - b.res.train.dd_pct).slice(0, 3));
  const eligV = kept.filter((x) => ok(x.res.validation, C, 5)).sort((a, b) => b.res.validation.net - a.res.validation.net);
  const cands = [], perFam = {};
  for (const x of eligV) { if ((perFam[x.spec.family] ?? 0) >= 2) continue; perFam[x.spec.family] = (perFam[x.spec.family] ?? 0) + 1; cands.push(x); if (cands.length === 5) break; }
  const diag = (x) => {
    const cons = consistent(x, C), decay = x.res.train.cagr_pct > 0 ? x.res.test.cagr_pct / x.res.train.cagr_pct : null;
    const nb = all.filter((y) => isNeighbour(x, y)), nbOk = nb.filter((y) => consistent(y, C)).length;
    const rs = reshuffleP(x.spec, x.uni, C);
    const stressTest = backtest(U[x.uni], x.spec, { from: PERIODS.test[0], to: PERIODS.test[1], ...COSTS.stress });
    const nbShare = nb.length ? nbOk / nb.length : 0;
    const robust = cons && decay !== null && decay >= 0.25 && nbShare >= 0.5 && rs.p_dd_over_cap !== null && rs.p_dd_over_cap <= 0.25 && stressTest.net > 0;
    return { id: x.id, train: brief(x.res.train), validation: brief(x.res.validation), test: brief(x.res.test), full_2016_2026: rs.full ?? null,
      consistent: cons, decay: decay === null ? null : r2(decay), neighbours: `${nbOk}/${nb.length}`, neighbours_share: r2(nbShare), p_dd_over_cap: rs.p_dd_over_cap, stress_cost_test_net: r2(stressTest.net),
      label: !cons ? "OVERFITTED/FAILED" : robust ? "ROBUST" : "FRAGILE" };
  };
  const population = { training_eligible: eligT.length, consistent_in_val_and_test: eligT.filter((x) => consistent(x, C)).length };
  population.survival_pct = eligT.length ? r2((population.consistent_in_val_and_test / eligT.length) * 100) : null;
  frontier.push({ cap_pct: C, population, candidates: cands.map(diag) });
  console.log(`C=${C}%  trained-eligible ${eligT.length}, survive ${population.consistent_in_val_and_test}`);
}
writeFileSync(OUT, JSON.stringify({ generated_by: "engine/src/research/dd2/frontier.mjs", preregistration: "docs/research/dd2/FRONTIER-PREREGISTRATION.md", caps: CAPS, frontier }, null, 1) + "\n");
for (const f of frontier) { console.log(`\n=== cap ${f.cap_pct}% (survival ${f.population.survival_pct}%)`); for (const c of f.candidates) console.log(`${c.label.padEnd(18)} ${c.id}\n   train ${c.train.cagr_pct}%/yr dd ${c.train.dd_pct} | val ${c.validation.cagr_pct}%/yr dd ${c.validation.dd_pct} | test ${c.test.cagr_pct}%/yr dd ${c.test.dd_pct} net ${c.test.net} trades ${c.test.trades} | full ${c.full_2016_2026?.final} (${c.full_2016_2026?.cagr_pct}%/yr, dd ${c.full_2016_2026?.dd_pct}) | decay ${c.decay} nb ${c.neighbours} P>cap ${c.p_dd_over_cap} stress ${c.stress_cost_test_net}`); }

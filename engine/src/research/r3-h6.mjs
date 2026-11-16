#!/usr/bin/env node
// H6 sensitivity and weakness study. The GRID BELOW WAS FIXED AND COMMITTED BEFORE THIS SCRIPT WAS FIRST RUN; it is
// reported in full (including every losing variant) and is NEVER used to pick a new setting. ETH has already been
// examined (round 3), so nothing here is an untouched test any more.
//   ALPHA_RESEARCH_DATA=<engine/data/research2> node src/research/r3-h6.mjs --out h6.json
import { writeFileSync } from "node:fs";
import { DATA, metrics, runOne, simAsset, H } from "./r3.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const D = Date.parse, DAY = 86_400_000;
const PERIODS = {
  development: [D("2021-07-01"), D("2024-07-01")], validation: [D("2024-07-01"), D("2026-11-15")], all: [D("2021-07-01"), D("2026-11-15")],
  y2022: [D("2022-01-01"), D("2023-01-01")], y2023: [D("2023-01-01"), D("2024-01-01")], y2024: [D("2024-01-01"), D("2025-01-01")], y2025: [D("2025-01-01"), D("2026-01-01")], y2026: [D("2026-01-01"), D("2026-11-15")],
};
const ASSETS = ["BTC", "SOL", "ETH"];
const SEL = { fee: 0.2, slip: 0.05 };
// ---- the predefined grid (one factor at a time around the registered H6) ----
const REGISTERED = {};
const GRID = [
  ...[30, 40, 60, 80, 100].map((ma) => ({ ma })),          // entry/exit average (registered 50)
  ...[150, 250].map((gs) => ({ gs })),                      // regime average (registered 200)
  ...[0.4, 0.6].map((vq) => ({ vq })), { volGate: false },  // volatility threshold percentile (registered 0.5 = median), off
  ...[20, 45].map((vw) => ({ vw })),                        // volatility lookback (registered 30)
  ...[180, 730].map((mw) => ({ mw })),                      // median lookback (registered 365)
  ...[2, 2.5, 3.5, 4].map((k) => ({ k, trail: 3 })),        // protective stop only (trail kept at 3)
  ...[2, 4].map((trail) => ({ trail })), { trail: null },   // trailing stop distance only (stop kept at 3), off
  { trendGate: false }, { trendGate: false, volGate: false }, // ablation: vol filter only; NO filter = unfiltered Candidate B
];
const RISKS = [1, 2, 3];
const COSTS = [{ fee: 0, slip: 0 }, { fee: 0.2, slip: 0.05 }, { fee: 0.2, slip: 0.15 }, { fee: 0.4, slip: 0.05 }, { fee: 0.4, slip: 0.15 }];

const years = ([a, b]) => (b - a) / (365.25 * DAY);
const cagr = (net, per) => +(((1 + net / 100) ** (1 / years(per)) - 1) * 100).toFixed(1);
function bhPath(asset, [a, b], { fee, slip }) {
  const ks = DATA[asset].filter((k) => k.t >= a && k.t < b), q = 100 / (ks[0].o * (1 + slip / 100) * (1 + fee / 100));
  let pk = 100, dd = 0; for (const k of ks) { const v = q * k.c; pk = Math.max(pk, v); dd = Math.max(dd, (pk - v) / pk); }
  const net = q * ks.at(-1).c * (1 - slip / 100) * (1 - fee / 100) - 100;
  return { net: +net.toFixed(2), max_dd_pct: +(dd * 100).toFixed(1), cagr: cagr(net, [a, b]) };
}
const row = (variant, asset, per, cost = SEL, risk = 2) => {
  const { r, m } = runOne("H6", asset, variant, PERIODS[per], cost, risk);
  return { ...m, cagr: cagr(m.net, PERIODS[per]), exposure_pct: 100 - m.cash_pct, eq: r.eq };
};
const strip = ({ eq, ...m }) => m;

const out = { label: "H6 sensitivity and weakness study (RESEARCH; ETH already examined; nothing selected from this)", registered: "ma 50, k 3, trail 3, gs 200, vw 30, mw 365, vq 0.5, risk 2 %", periods: Object.keys(PERIODS), grid: [], risk: [], costs: [], weakness: {}, ma_selection_bias: {} };
// 1) the grid
for (const v of [REGISTERED, ...GRID]) {
  const cells = {};
  for (const a of ASSETS) for (const per of Object.keys(PERIODS)) cells[`${a}.${per}`] = (({ net, trades, pf, max_dd_pct }) => ({ net, trades, pf, max_dd_pct }))(row(v, a, per));
  out.grid.push({ variant: Object.keys(v).length ? v : "registered H6", cells });
}
// 2) risk per trade and 3) costs (registered settings)
for (const risk of RISKS) out.risk.push({ risk, ...Object.fromEntries(ASSETS.map((a) => [a, strip(row(REGISTERED, a, "all", SEL, risk))])) });
for (const c of COSTS) out.costs.push({ ...c, ...Object.fromEntries(ASSETS.map((a) => [a, row(REGISTERED, a, "all", c).net])) });
// 4) weaknesses: exposure, annualised return, bull-market shortfall, exposure-matched benchmark, filter value
for (const a of ASSETS) {
  const w = {};
  for (const per of ["development", "validation", "all"]) {
    const h6 = row(REGISTERED, a, per), unf = row({ trendGate: false, volGate: false }, a, per), bh = bhPath(a, PERIODS[per], SEL);
    const e = h6.exposure_pct / 100;
    // exposure-matched: hold e of the money in buy-and-hold and the rest in cash for the whole period
    const matched = { net: +(bh.net * e).toFixed(2), max_dd_pct: +(bh.max_dd_pct * e).toFixed(1), cagr: cagr(bh.net * e, PERIODS[per]) };
    w[per] = { h6: strip(h6), unfiltered_candidate_B: strip(unf), buy_hold: bh, exposure_matched_buy_hold: matched,
      ret_per_dd: { h6: h6.max_dd_pct ? +(h6.net / h6.max_dd_pct).toFixed(2) : null, unfiltered: unf.max_dd_pct ? +(unf.net / unf.max_dd_pct).toFixed(2) : null, buy_hold: bh.max_dd_pct ? +(bh.net / bh.max_dd_pct).toFixed(2) : null, matched: matched.max_dd_pct ? +(matched.net / matched.max_dd_pct).toFixed(2) : null },
      expectancy_per_trade: { h6: h6.avg, unfiltered: unf.avg } };
  }
  // bull quarters: H6 vs buy-and-hold inside the strongest quarters (asset quarterly return > +15 %)
  const K = DATA[a], q = new Map();
  for (const k of K) { const d = new Date(k.t), id = `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`; (q.get(id) ?? q.set(id, []).get(id)).push(k); }
  w.bull_quarters = [...q.entries()].filter(([, ks]) => ks.at(-1).c / ks[0].o - 1 > 0.15 && ks[0].t >= PERIODS.all[0]).map(([id, ks]) => {
    const per = [ks[0].t, ks.at(-1).t + DAY], r = simAsset(a, K, H.H6.make(K, {}, DATA.BTC), { ...SEL, risk: 2, from: per[0], to: per[1] });
    return { quarter: id, asset_return_pct: +((ks.at(-1).c / ks[0].o - 1) * 100).toFixed(1), h6_net: +(r.end - 100).toFixed(2), h6_exposure_pct: +(100 - r.cashPct * 100).toFixed(0) };
  });
  out.weakness[a] = w;
}
// 5) MA-50 selection bias: the whole entry-average range, unfiltered (Candidate B family) and with the H6 gate
for (const a of ASSETS) out.ma_selection_bias[a] = [20, 30, 40, 50, 60, 80, 100, 150, 200].map((ma) => ({ ma,
  unfiltered_all: row({ ma, trendGate: false, volGate: false }, a, "all").net, h6_all: row({ ma }, a, "all").net }));

writeFileSync(arg("out", "h6.json"), JSON.stringify(out, null, 1));
const pos = (cells, pre) => Object.entries(cells).filter(([k]) => k.startsWith(pre)).map(([k, v]) => `${k.split(".")[1].slice(0, 4)} ${v.net}`).join(" ");
for (const g of out.grid) console.log(JSON.stringify(g.variant).padEnd(34), "| BTC", pos(g.cells, "BTC.").slice(0, 70), "| ETH all", g.cells["ETH.all"].net, "n", g.cells["ETH.all"].trades);

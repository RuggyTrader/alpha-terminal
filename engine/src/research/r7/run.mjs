#!/usr/bin/env node
// Round 7 driver (docs/research/round7/PREREGISTRATION.md). Development -> selection -> validation -> independent.
//   ALPHA_RESEARCH_DATA=<engine/data/research2> node src/research/r7/run.mjs --out r7-results.json
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { aggregate } from "../../cli/fleet-backtest.mjs";
import { backtest, bootstrap, summarize } from "./bt.mjs";
import { GRID } from "./families.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = process.env.ALPHA_RESEARCH_DATA, D = Date.parse;
const DEV = [D("2021-07-01"), D("2024-07-01")], VAL = [D("2024-07-01"), D("2026-11-15")], ALL = [D("2021-07-01"), D("2026-11-15")];
// Kraken public AssetPairs (fetched 2026-11-16): [ordermin, costmin]
const MIN = { BTC: [0.00006, 0.5], ETH: [0.002, 0.5], SOL: [0.05, 0.5], LTC: [0.08, 0.5], LINK: [0.35, 0.5], AVAX: [0.5, 0.5], ADA: [20, 0.5], BCH: [0.018, 0.5], DOGE: [50, 0.5], XRP: [4, 0.5],
  DOT: [3.9, 0.5], ATOM: [3.5, 0.5], UNI: [0.7, 0.5], AAVE: [0.03, 0.5], XLM: [25, 0.5], ETC: [0.7, 0.5], FIL: [6, 0.5], ALGO: [41, 0.5] };
const DEVM = ["BTC", "ETH", "SOL"], VALM = ["BTC", "ETH", "SOL", "LTC", "LINK", "AVAX", "ADA", "BCH", "DOGE", "XRP"], INDM = ["DOT", "ATOM", "UNI", "AAVE", "XLM", "ETC", "FIL", "ALGO"];
const COST = { selected: { feePct: 0.2, slipPct: 0.05 }, stress: { feePct: 0.4, slipPct: 0.1 }, kraken_taker: { feePct: 0.8, slipPct: 0.05 } };

const provenance = {};
const cache = new Map();
function bars(m, tf) {
  const k = `${m}-${tf}`;
  if (cache.has(k)) return cache.get(k);
  const g = tf === 1440 ? 86400 : 3600, file = `${DIR}/${m}-USD-${g}.json`, raw = readFileSync(file);
  provenance[`${m}-USD-${g}`] = { sha256: createHash("sha256").update(raw).digest("hex").slice(0, 16), source: "Coinbase Exchange public candles" };
  let b = JSON.parse(raw).candles.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
  if (tf === 240) b = aggregate(b, 240);
  cache.set(k, b);
  return b;
}
const sum = (x) => x.reduce((a, b) => a + b, 0);
function runOne(cfg, m, side, [from, to], cost = COST.selected) {
  const [minQty, minNotional] = MIN[m];
  const r = backtest(bars(m, cfg.tf), cfg.make, { side, capital: 100, riskPct: 2, ...cost, minQty, minNotional, from, to });
  return { ...summarize(r), trades_list: r.trades };
}
function pool(rs) {
  const nets = rs.flatMap((r) => r.nets);
  return { trades: sum(rs.map((r) => r.trades)), gross: +sum(rs.map((r) => r.gross)).toFixed(2), fees: +sum(rs.map((r) => r.fees)).toFixed(2), net: +sum(rs.map((r) => r.net)).toFixed(2),
    positive: rs.filter((r) => r.net > 0).length, markets: rs.length, dd: rs.map((r) => +r.max_dd_pct.toFixed(1)), nets };
}
const strip = (r) => ({ trades: r.trades, gross: +r.gross.toFixed(2), fees: +r.fees.toFixed(2), net: +r.net.toFixed(2), pf: r.pf === Infinity ? "inf" : r.pf === null ? null : +r.pf.toFixed(2), win: r.win === null ? null : +r.win.toFixed(2), max_dd_pct: +r.max_dd_pct.toFixed(1), exposure: +r.exposure.toFixed(2) });
function buyHold(m, [from, to]) { const b = bars(m, 1440).filter((k) => k.t >= from && k.t < to); return +(100 * (b.at(-1).c / b[0].o) * (1 - 0.0025) ** 2 - 100).toFixed(2); }

let gitRev = null; try { gitRev = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
const out = { label: "RESEARCH ROUND 7 (different strategy families; Coinbase candles; conservative bar backtester; NOT PAPER results)", code_version: gitRev, preregistration: arg("prereg", null), costs: COST,
  development_all: {}, candidates: {}, provenance };
for (const side of ["LONG", "SHORT"]) {
  for (const [fam, cfgs] of Object.entries(GRID)) {
    const dev = cfgs.map((cfg) => { const rs = DEVM.map((m) => runOne(cfg, m, side, DEV)); const p = pool(rs); out.development_all[`${cfg.id} ${side}`] = { ...p, nets: undefined, per_market: Object.fromEntries(DEVM.map((m, i) => [m, strip(rs[i])])) }; return { cfg, p }; });
    const eligible = dev.filter((x) => x.p.trades >= 30).sort((a, b) => b.p.net - a.p.net);
    const key = `${fam} ${side}`;
    if (!eligible.length) { out.candidates[key] = { selected: null, reason: "no configuration with >= 30 development trades" }; console.error(`${key}: none eligible`); continue; }
    const { cfg, p: devP } = eligible[0];
    const val = VALM.map((m) => runOne(cfg, m, side, VAL)), valP = pool(val);
    const ind = INDM.map((m) => runOne(cfg, m, side, ALL)), indP = pool(ind);
    const indStress = pool(INDM.map((m) => runOne(cfg, m, side, ALL, COST.stress))), indK = pool(INDM.map((m) => runOne(cfg, m, side, ALL, COST.kraken_taker)));
    const ci = bootstrap(indP.nets, 0.995);
    const years = {}; for (const r of ind) for (const t of r.trades_list) { const y = new Date(t.exitT).getUTCFullYear(); years[y] = (years[y] ?? 0) + t.net; }
    const yrs = [2022, 2023, 2024, 2025, 2026].map((y) => years[y] ?? 0), dds = ind.map((r) => r.max_dd_pct).sort((a, b) => a - b);
    const crit = { c1_development: devP.net > 0, c2_validation: valP.net > 0, c3_independent_net_and_breadth: indP.net > 0 && indP.positive >= 6, c4_100_trades: indP.trades >= 100,
      c5_ci_995: !!ci && ci[0] > 0, c6_stress_costs: indStress.net > 0, c7_drawdown: dds[Math.floor(dds.length / 2)] <= 25 && dds.at(-1) <= 40, c8_years: yrs.filter((v) => v > 0).length >= 3 };
    const pass = Object.values(crit).every(Boolean);
    out.candidates[key] = { selected: cfg.id, status: pass ? "ELIGIBLE FOR FURTHER VALIDATION" : "FAILED", criteria: crit, failed: Object.entries(crit).filter(([, v]) => !v).map(([k]) => k),
      development: { ...devP, nets: undefined }, validation: { ...valP, nets: undefined, per_market: Object.fromEntries(VALM.map((m, i) => [m, strip(val[i])])) },
      independent: { ...indP, nets: undefined, ci_995: ci && ci.map((x) => +x.toFixed(4)), per_market: Object.fromEntries(INDM.map((m, i) => [m, strip(ind[i])])), by_year: Object.fromEntries(Object.entries(years).map(([y, v]) => [y, +v.toFixed(2)])),
        buy_hold: Object.fromEntries(INDM.map((m) => [m, buyHold(m, ALL)])), fee_drag_pct_of_gross_profit: null },
      independent_stress_040_010: { net: indStress.net, trades: indStress.trades }, independent_080: { net: indK.net, trades: indK.trades } };
    console.error(`${key} -> ${cfg.id}: dev ${devP.net} (${devP.trades}) | val ${valP.net} (${valP.trades}, ${valP.positive}/10) | indep ${indP.net} (${indP.trades}, ${indP.positive}/8, CI99.5 ${JSON.stringify(ci && ci.map((x) => +x.toFixed(3)))}) | stress ${indStress.net} | ${pass ? "ELIGIBLE" : "FAILED " + out.candidates[key].failed.join(",")}`);
    writeFileSync(arg("out", "r7-results.json"), JSON.stringify(out, null, 1));
  }
}
writeFileSync(arg("out", "r7-results.json"), JSON.stringify(out, null, 1));

#!/usr/bin/env node
// Round 9 driver (docs/research/round9/PREREGISTRATION.md, 7288171). Development -> selection -> validation ->
// independent -> the 11 gates, exactly as pre-registered. Research only; nothing here trades.
//   ALPHA_RESEARCH_DATA=<engine/data/research2> node src/research/r9/run.mjs --out r9-results.json
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { aggregate } from "../../cli/fleet-backtest.mjs";
import { backtest, bootstrap, sma, summarize } from "../r7/bt.mjs";
import { blockBootstrap, rotate } from "../r8/xsmom.mjs";
import { DAY, grid, makeRegime } from "./families.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = process.env.ALPHA_RESEARCH_DATA, D = Date.parse;
const DEV = [D("2021-07-01"), D("2024-07-01")], VAL = [D("2024-07-01"), D("2026-11-15")], IND = [D("2022-01-01"), D("2026-11-15")];
const DEVM = ["BTC", "ETH", "SOL", "LTC", "LINK", "XRP", "ADA", "AVAX"];
const INDM_LISTED = ["AXS", "ENJ", "CHZ", "SUSHI", "1INCH", "STORJ", "SKL", "ANKR", "KNC", "UMA", "BAL", "ZRX", "LRC", "QNT", "FET", "NMR"];
const COST = { primary: { feePct: 0.2, slipPct: 0.05 }, stress: { feePct: 0.4, slipPct: 0.1 }, instant: { feePct: 0.8, slipPct: 0.05 } };
const CAP = 20, CAP_ALT = 100, B = 10_000, LEVEL = 0.99;
const KMIN = JSON.parse(readFileSync(`${DIR}/r9-kraken-min.json`, "utf8")); // Kraken public AssetPairs, fetched 2026-11-17

const provenance = {}, cache = new Map();
function raw(m, g) {
  const k = `${m}-${g}`;
  if (!cache.has(k)) {
    let txt = null;
    try { txt = readFileSync(`${DIR}/${m}-USD-${g}.json`); } catch { cache.set(k, null); return null; }
    provenance[`${m}-USD-${g}`] = createHash("sha256").update(txt).digest("hex").slice(0, 16);
    cache.set(k, JSON.parse(txt).candles.map(({ t, o, h, l, c }) => ({ t, o, h, l, c })));
  }
  return cache.get(k);
}
const agg = new Map();
function bars(m, tf) {
  if (tf === 1440) return raw(m, 86400);
  if (tf === 60) return raw(m, 3600);
  const k = `${m}-${tf}`; if (!agg.has(k)) agg.set(k, aggregate(raw(m, 3600), tf)); return agg.get(k);
}
const regime = makeRegime(raw("BTC", 86400));
const GRID = grid(regime);
const sum = (x) => x.reduce((a, b) => a + b, 0), r2 = (x) => (x === null || x === undefined ? null : +Number(x).toFixed(2));

// ---- independent universe: the pre-registered data rules (never extended or substituted) ----
const excluded = {}, INDM = [];
for (const m of INDM_LISTED) {
  const d = raw(m, 86400), h = raw(m, 3600);
  if (!KMIN[m]) excluded[m] = "not listed on Kraken (USD)";
  else if (!d || !h) excluded[m] = "no Coinbase history";
  else if (d[0].t > IND[0] || h[0].t > IND[0]) excluded[m] = `history starts ${new Date(Math.max(d[0].t, h[0].t)).toISOString().slice(0, 10)} (after 2022-01-01)`;
  else INDM.push(m);
}

function runOne(cfg, m, [from, to], cost = COST.primary, capital = CAP) {
  const [minQty, minNotional] = KMIN[m] ?? [0, 0.5];
  let b = bars(m, cfg.tf);
  // data that ends early (round 8 A1): the backtester closes any open position at the last available close, with costs
  const r = backtest(b, cfg.make, { side: "LONG", capital, riskPct: 2, ...cost, minQty, minNotional, from, to });
  const s = summarize(r, capital);
  for (const t of r.trades) if (Math.abs(t.net - (t.gross - t.fees)) > 1e-9) throw new Error(`accounting: ${m} ${t.entryT} net != gross - fees`);
  return { ...s, trades_list: r.trades, curve: r.curve, signals: r.signals, skippedMin: r.skippedMin, holdBars: r.trades.length ? sum(r.trades.map((t) => t.bars)) / r.trades.length : null };
}
function pool(rs, capital = CAP) {
  const nets = rs.flatMap((r) => r.nets), trades = rs.flatMap((r) => r.trades_list), gp = sum(trades.filter((t) => t.gross > 0).map((t) => t.gross));
  const w = nets.filter((v) => v > 0), l = nets.filter((v) => v <= 0);
  // daily pooled equity -> Sharpe (annualised, 365)
  const byDay = new Map();
  for (const r of rs) { const last = new Map(); for (const p of r.curve) last.set(Math.floor(p.t / DAY), p.eq); for (const [d, e] of last) byDay.set(d, (byDay.get(d) ?? 0) + e); }
  const days = [...byDay.keys()].sort((a, b) => a - b), rets = [];
  for (let i = 1; i < days.length; i++) rets.push(byDay.get(days[i]) / byDay.get(days[i - 1]) - 1);
  const mu = rets.length ? sum(rets) / rets.length : 0, sd = rets.length > 1 ? Math.sqrt(sum(rets.map((x) => (x - mu) ** 2)) / (rets.length - 1)) : 0;
  return { markets: rs.length, trades: nets.length, gross: r2(sum(rs.map((r) => r.gross))), fees: r2(sum(rs.map((r) => r.fees))), net: r2(sum(rs.map((r) => r.net))),
    net_pct_of_capital: r2((sum(rs.map((r) => r.net)) / (capital * rs.length)) * 100), positive: rs.filter((r) => r.net > 0).length,
    win_rate: nets.length ? r2(w.length / nets.length) : null, profit_factor: l.length && sum(l) < 0 ? r2(sum(w) / -sum(l)) : null, expectancy: nets.length ? +(sum(nets) / nets.length).toFixed(4) : null,
    sharpe_daily_ann: sd > 0 ? r2((mu / sd) * Math.sqrt(365)) : null, fee_drag_pct_of_gross_profit: gp > 0 ? r2((sum(rs.map((r) => r.fees)) / gp) * 100) : null,
    avg_hold_bars: r2(sum(rs.map((r) => (r.holdBars ?? 0) * r.trades)) / Math.max(1, nets.length)), exposure: r2(sum(rs.map((r) => r.exposure)) / rs.length),
    max_dd_pct: rs.map((r) => r2(r.max_dd_pct)), signals: sum(rs.map((r) => r.signals)), skipped_min: sum(rs.map((r) => r.skippedMin)), nets, trades_all: trades };
}
const lean = (p) => { const { nets: _n, trades_all: _t, ...rest } = p; return rest; };
function buyHold(m, [from, to], capital = CAP) {
  const b = raw(m, 86400).filter((k) => k.t >= from && k.t < to); if (!b.length) return null;
  return r2(capital * (b.at(-1).c / b[0].o) * (1 - 0.0025) ** 2 - capital);
}

// ---- F5 (portfolio) helpers ----
function universe(ms) { return Object.fromEntries(ms.map((m) => [m, raw(m, 86400)])); }
function f5opts(series, L) {
  const smaMap = {};
  for (const [m, b] of Object.entries(series)) { const S = sma(b.map((k) => k.c), 100); smaMap[m] = new Map(b.map((k, i) => [k.t, S[i] === null ? null : k.c > S[i]])); }
  return { L, K: 3, minQty: Object.fromEntries(Object.keys(series).map((m) => [m, (KMIN[m] ?? [0])[0]])),
    eligible: (m, t) => series[m][0].t <= t - (L + 100) * DAY && smaMap[m].get(t) === true && regime(t + DAY) };
}
function runF5(cfg, ms, [from, to], cost = COST.primary, capital = CAP) {
  const s = universe(ms), r = rotate(s, { ...f5opts(s, cfg.L), from, to, ...cost, capital });
  return { net: r2(r.net), fees: r2(r.fees), entries: r.entries, skipped_min: r.skippedMin, mdd_pct: r2(r.mdd * 100), exposure: r2(r.exposure), by_year: Object.fromEntries(Object.entries(r.byYear).map(([y, v]) => [y, r2(v)])),
    pnl_by_market: Object.fromEntries(Object.entries(r.pnl).map(([m, v]) => [m, r2(v)])), weekly: r.weekly, sells: r.trades.filter((t) => t.side === "SELL") };
}

const out = { label: "RESEARCH ROUND 9 (strategy discovery tournament; Coinbase candles; conservative bar backtester; NOT PAPER results)", preregistration: "docs/research/round9/PREREGISTRATION.md (7288171)",
  capital_per_market_usd: CAP, costs: COST, kraken_minimums: KMIN, universes: { development: DEVM, independent: INDM, independent_excluded: excluded }, development_all: {}, candidates: {}, provenance };

for (const [fam, cfgs] of Object.entries(GRID)) {
  if (fam === "F5") {
    const dev = cfgs.map((cfg) => ({ cfg, r: runF5(cfg, DEVM, DEV) }));
    for (const { cfg, r } of dev) out.development_all[cfg.id] = { net: r.net, entries: r.entries, mdd_pct: r.mdd_pct };
    const ok = dev.filter((x) => x.r.entries >= 30).sort((a, b) => b.r.net - a.r.net);
    if (!ok.length) { out.candidates.F5 = { selected: null, status: "FAILED", reason: "no configuration with >= 30 development entries" }; continue; }
    const { cfg, r: devR } = ok[0];
    const val = runF5(cfg, DEVM, VAL), ind = runF5(cfg, INDM, IND), indS = runF5(cfg, INDM, IND, COST.stress), indI = runF5(cfg, INDM, IND, COST.instant), ind100 = runF5(cfg, INDM, IND, COST.primary, CAP_ALT);
    const boot = blockBootstrap(ind.weekly, { block: 4, n: B, alpha: 1 - LEVEL });
    const profit = Object.values(ind.pnl_by_market).filter((v) => v > 0);
    const topM = Math.max(0, ...profit), topT = Math.max(0, ...ind.sells.map((t) => t.net ?? 0));
    const neighbours = cfgs.filter((c) => c.id !== cfg.id).map((c) => ({ id: c.id, net: runF5(c, INDM, IND).net }));
    const yrs = [2022, 2023, 2024, 2025, 2026].filter((y) => (ind.by_year[y] ?? 0) > 0).length;
    const gates = { g1_development: devR.net > 0, g2_validation: val.net > 0, g3_independent: ind.net > 0, g4_sample_30_entries: ind.entries >= 30, g5_ci99: boot.lo > 0, g6_stress: indS.net > 0,
      g7_drawdown_40: ind.mdd_pct <= 40, g8_years: yrs >= 3, g9_concentration: ind.net > 0 && topM <= 0.5 * ind.net && topT <= 0.25 * ind.net, g10_neighbours: neighbours.every((n) => n.net > 0),
      g11_feasible_80pct: ind.entries / Math.max(1, ind.entries + ind.skipped_min) >= 0.8 };
    const pass = Object.values(gates).every(Boolean);
    out.candidates.F5 = { selected: cfg.id, status: pass ? "ELIGIBLE FOR FURTHER VALIDATION" : val.net > 0 && ind.net > 0 ? "INCONCLUSIVE" : "FAILED", gates, failed: Object.entries(gates).filter(([, v]) => !v).map(([k]) => k),
      development: { net: devR.net, entries: devR.entries, mdd_pct: devR.mdd_pct }, validation: { net: val.net, entries: val.entries, mdd_pct: val.mdd_pct },
      independent: { ...ind, weekly: undefined, sells: undefined, bootstrap_weekly_99: { lo: +boot.lo.toFixed(5), mean: +boot.mean.toFixed(5), hi: +boot.hi.toFixed(5) } },
      independent_stress: { net: indS.net }, independent_080: { net: indI.net }, independent_100usd: { net: ind100.net, skipped_min: ind100.skipped_min }, neighbours,
      buy_hold_independent: Object.fromEntries(INDM.map((m) => [m, buyHold(m, IND)])) };
    console.error(`F5 -> ${cfg.id}: dev ${devR.net} | val ${val.net} | indep ${ind.net} (${ind.entries} entries, mdd ${ind.mdd_pct}%) | stress ${indS.net} | ${out.candidates.F5.status} ${out.candidates.F5.failed.join(",")}`);
    continue;
  }
  const dev = cfgs.map((cfg) => { const rs = DEVM.map((m) => runOne(cfg, m, DEV)); const p = pool(rs); out.development_all[cfg.id] = lean(p); return { cfg, p }; });
  const ok = dev.filter((x) => x.p.trades >= 30).sort((a, b) => b.p.net - a.p.net);
  if (!ok.length) { out.candidates[fam] = { selected: null, status: "FAILED", reason: "no configuration with >= 30 development trades" }; console.error(`${fam}: none eligible`); continue; }
  const { cfg, p: devP } = ok[0];
  const val = DEVM.map((m) => runOne(cfg, m, VAL)), valP = pool(val);
  const ind = INDM.map((m) => runOne(cfg, m, IND)), indP = pool(ind);
  const indS = pool(INDM.map((m) => runOne(cfg, m, IND, COST.stress))), indI = pool(INDM.map((m) => runOne(cfg, m, IND, COST.instant))), ind100 = pool(INDM.map((m) => runOne(cfg, m, IND, COST.primary, CAP_ALT)), CAP_ALT);
  const ci = bootstrap(indP.nets, LEVEL, B);
  const years = {}; for (const t of indP.trades_all) { const y = new Date(t.exitT).getUTCFullYear(); years[y] = (years[y] ?? 0) + t.net; }
  const yrs = [2022, 2023, 2024, 2025, 2026].filter((y) => (years[y] ?? 0) > 0).length;
  const dds = ind.map((r) => r.max_dd_pct).sort((a, b) => a - b);
  const topM = Math.max(0, ...ind.map((r) => r.net)), topT = Math.max(0, ...indP.nets);
  const neighbours = cfgs.filter((c) => c.id !== cfg.id).map((c) => ({ id: c.id, net: pool(INDM.map((m) => runOne(c, m, IND))).net }));
  const gates = { g1_development: devP.net > 0, g2_validation: valP.net > 0, g3_independent_and_breadth: indP.net > 0 && indP.positive >= Math.ceil(0.6 * INDM.length), g4_sample_100: indP.trades >= 100,
    g5_ci99: !!ci && ci[0] > 0, g6_stress: indS.net > 0, g7_drawdown: dds[Math.floor(dds.length / 2)] <= 25 && dds.at(-1) <= 40, g8_years: yrs >= 3,
    g9_concentration: indP.net > 0 && topM <= 0.5 * indP.net && topT <= 0.25 * indP.net, g10_neighbours: neighbours.every((n) => n.net > 0),
    g11_feasible_80pct: indP.signals > 0 && (indP.signals - indP.skipped_min) / indP.signals >= 0.8 };
  const pass = Object.values(gates).every(Boolean);
  out.candidates[fam] = { selected: cfg.id, status: pass ? "ELIGIBLE FOR FURTHER VALIDATION" : valP.net > 0 && indP.net > 0 ? "INCONCLUSIVE" : "FAILED", gates, failed: Object.entries(gates).filter(([, v]) => !v).map(([k]) => k),
    development: lean(devP), validation: { ...lean(valP), per_market: Object.fromEntries(DEVM.map((m, i) => [m, r2(val[i].net)])) },
    independent: { ...lean(indP), ci99_per_trade: ci && ci.map((x) => +x.toFixed(4)), per_market: Object.fromEntries(INDM.map((m, i) => [m, r2(ind[i].net)])), by_year: Object.fromEntries(Object.entries(years).map(([y, v]) => [y, r2(v)])),
      top_market_net: r2(topM), top_trade_net: r2(topT), buy_hold: Object.fromEntries(INDM.map((m) => [m, buyHold(m, IND)])) },
    independent_stress: { net: indS.net, trades: indS.trades }, independent_080: { net: indI.net }, independent_100usd: { net: ind100.net, trades: ind100.trades, skipped_min: ind100.skipped_min }, neighbours };
  console.error(`${fam} -> ${cfg.id}: dev ${devP.net} (${devP.trades}) | val ${valP.net} (${valP.trades}) | indep ${indP.net} (${indP.trades}, ${indP.positive}/${INDM.length}, CI99 ${JSON.stringify(ci && ci.map((x) => +x.toFixed(3)))}) | stress ${indS.net} | skipped ${indP.skipped_min}/${indP.signals} | ${out.candidates[fam].status} ${out.candidates[fam].failed.join(",")}`);
}
writeFileSync(arg("out", "r9-results.json"), JSON.stringify(out, null, 1));
console.error("written; excluded:", JSON.stringify(excluded));

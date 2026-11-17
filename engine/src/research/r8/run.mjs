#!/usr/bin/env node
// Round 8 driver (docs/research/round8/PREREGISTRATION.md): eligibility screen -> every candidate x scenario x cost on
// the untouched basket (confirmatory) and the examined basket (secondary) -> frozen acceptance on scenario B.
//   ALPHA_RESEARCH_DATA=data/research8 node src/research/r8/run.mjs --out ../docs/research/round8/r8-results.json
// The data dir holds <M>-USD-3600.json and <M>-USD-86400.json (download.mjs format) and kraken-minimums.json.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { aggregate } from "../../cli/fleet-backtest.mjs";
import { backtestPortfolio, blockBootstrap, isolatedSleeves, monthlyReturns, summarizePortfolio } from "./portfolio.mjs";
import { CANDIDATES } from "./families.mjs";
import { COSTS, EXAMINED, PERIOD, SCENARIOS, SCREEN, UNTOUCHED } from "./markets.mjs";

const D = Date.parse, round = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? x : +x.toFixed(d));
const sum = (x) => x.reduce((a, b) => a + b, 0);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Mechanical eligibility screen (pre-registration section 5). Pure. */
export function screen(markets, { meta, minimums }) {
  const eligible = [], excluded = [];
  for (const m of markets) {
    const reasons = [], h = meta[`${m}-3600`], d = meta[`${m}-86400`];
    if (!h || !d) reasons.push("no Coinbase data");
    else {
      if (!(D(h.first) <= D(SCREEN.firstBy)) || !(D(d.first) <= D(SCREEN.firstBy))) reasons.push(`history starts ${h.first} (after ${SCREEN.firstBy})`);
      const pct = (100 * h.missing_candles) / Math.max(1, h.candles + h.missing_candles);
      if (pct > SCREEN.maxMissingPct) reasons.push(`${pct.toFixed(2)}% of 1h candles missing`);
    }
    if (!minimums[m]) reasons.push("no Kraken USD pair / minimum");
    (reasons.length ? excluded : eligible).push(reasons.length ? { market: m, reasons } : m);
  }
  return { eligible, excluded, underpowered: eligible.length < SCREEN.minMarkets };
}

/** Frozen acceptance on the primary scenario (pre-registration section 7). Pure. */
export function accept({ sel, stress, curve }) {
  const months = monthlyReturns(curve).map((x) => x.ret);
  const ci = blockBootstrap(months, { level: 0.995, block: 3 });
  const yrs = [2022, 2023, 2024, 2025, 2026].map((y) => sel.by_year[y] ?? 0);
  const crit = {
    c1_net_selected: sel.net > 0,
    c2_net_stress: stress.net > 0,
    c3_ci_995_monthly: !!ci && ci[0] > 0,
    c4_100_trades: sel.trades >= 100,
    c5_drawdown_30: sel.max_dd_pct <= 30,
    c6_years_3_of_5: yrs.filter((v) => v > 0).length >= 3,
    c7_concentration_40: sel.largest_market_share_of_net !== null && sel.largest_market_share_of_net <= 0.4,
    c8_feasible_60: (sel.executable_pct ?? 0) >= 60,
  };
  return { criteria: crit, failed: Object.entries(crit).filter(([, v]) => !v).map(([k]) => k), pass: Object.values(crit).every(Boolean), ci_monthly_995: ci, months: months.length };
}

/** Minimum equity per signal = min notional x stop% / risk% (risk 2%). */
export function minEquityPerSignal(signals, minimums, riskPct = 2) {
  return signals.map((s) => { const mn = minimums[s.market] ?? {}; const notional = Math.max((mn.minQty ?? 0) * s.px, mn.minCost ?? 0); return (notional * ((s.px - s.stop) / s.px)) / (riskPct / 100); });
}

/** Runs one candidate on one basket: every scenario at both cost levels. Pure given the loaded series. */
export function evaluate(cand, series, minimums, { from, to }) {
  const make = cand.make(series), out = {};
  for (const [key, sc] of Object.entries(SCENARIOS)) {
    out[key] = {};
    for (const [ck, cost] of Object.entries(COSTS)) {
      if (sc.isolated) {
        const runs = isolatedSleeves(series, make, { sleeveCapital: sc.sleeveCapital, riskPct: sc.riskPct, ...cost, minimums, from, to });
        const ss = Object.values(runs).map(summarizePortfolio), sigs = sum(ss.map((x) => x.setups)), exe = sum(ss.map((x) => x.executed_setups));
        const reasons = {}; for (const x of ss) for (const [r, n] of Object.entries(x.rejections)) reasons[r] = (reasons[r] ?? 0) + n;
        out[key][ck] = { capital: sc.sleeveCapital * ss.length, trades: sum(ss.map((x) => x.trades)), gross: round(sum(ss.map((x) => x.gross))), fees: round(sum(ss.map((x) => x.fees))), net: round(sum(ss.map((x) => x.net))),
          attempts: sum(ss.map((x) => x.signals)), setups: sigs, executed_setups: exe, executable_pct: round(sigs ? (100 * exe) / sigs : null, 1), rejections: reasons, median_sleeve_dd_pct: round(median(ss.map((x) => x.max_dd_pct)), 1) };
        continue;
      }
      const r = backtestPortfolio(series, make, { capital: 100, ...cost, scenario: sc.scenario, sizing: sc.sizing, minimums, from, to });
      const s = summarizePortfolio(r);
      out[key][ck] = { capital: 100, trades: s.trades, gross: round(s.gross), fees: round(s.fees), net: round(s.net), ret_pct: round(s.ret_pct, 1), max_dd_pct: round(s.max_dd_pct, 1), exposure: round(s.exposure),
        win: round(s.win), avg_trade: round(s.avg_trade, 4), attempts: s.signals, filled_attempts: s.executed, setups: s.setups, executed_setups: s.executed_setups, executable_pct: round(s.executable_pct, 1), raised_to_min: s.raised_to_min, rejections: s.rejections,
        by_market: Object.fromEntries(Object.entries(s.by_market).map(([m, v]) => [m, round(v)])), by_year: Object.fromEntries(Object.entries(s.by_year).map(([y, v]) => [y, round(v)])),
        largest_market_share_of_net: round(s.largest_market_share_of_net, 3), fee_drag_pct_of_gross: s.gross > 0 ? round((100 * s.fees) / s.gross, 1) : null,
        median_min_equity_per_signal_2pct: round(median(minEquityPerSignal(r.signals, minimums))), _run: r, _summary: s };
    }
  }
  const B = out.B, acc = accept({ sel: B.selected._summary, stress: B.stress._summary, curve: B.selected._run.curve });
  for (const k of Object.keys(out)) for (const c of Object.keys(out[k])) { delete out[k][c]._run; delete out[k][c]._summary; }
  return { scenarios: out, acceptance: acc };
}

/** Benchmark: equal-weight buy-and-hold of the basket (daily bars), one entry and one exit at the given costs. */
export function equalWeightBuyHold(daily, { from, to }, { feePct, slipPct }) {
  const ms = Object.keys(daily), c = (feePct + slipPct) / 100;
  if (!ms.length) return null;
  const vals = ms.map((m) => { const b = daily[m].filter((k) => k.t >= from && k.t < to); return b.length ? (100 / ms.length) * (b.at(-1).c / b[0].o) * (1 - c) ** 2 : 100 / ms.length; });
  return round(sum(vals) - 100);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const DIR = process.env.ALPHA_RESEARCH_DATA ?? "data/research8";
  const minFile = `${DIR}/kraken-minimums.json`;
  if (!existsSync(minFile)) throw new Error(`missing ${minFile}: run r8/kraken-minimums.mjs first`);
  const minSnap = JSON.parse(readFileSync(minFile, "utf8")), minimums = minSnap.markets;
  const provenance = { kraken_minimums: { fetched_at: minSnap.fetched_at, sha256: createHash("sha256").update(readFileSync(minFile)).digest("hex").slice(0, 16) } }, meta = {}, raw = {};
  for (const m of [...UNTOUCHED, ...EXAMINED]) for (const g of [3600, 86400]) {
    const f = `${DIR}/${m}-USD-${g}.json`; if (!existsSync(f)) continue;
    const buf = readFileSync(f), j = JSON.parse(buf);
    meta[`${m}-${g}`] = j.meta; raw[`${m}-${g}`] = j.candles.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
    provenance[`${m}-USD-${g}`] = { sha256: createHash("sha256").update(buf).digest("hex").slice(0, 16), first: j.meta.first, last: j.meta.last, missing: j.meta.missing_candles, downloaded_at: j.meta.downloaded_at };
  }
  const load = (markets, tf) => Object.fromEntries(markets.map((m) => [m, tf === 1440 ? raw[`${m}-86400`] : aggregate(raw[`${m}-3600`], 240)]));
  const win = { from: D(PERIOD.from), to: D(PERIOD.to) };
  let gitRev = null; try { gitRev = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
  const scU = screen(UNTOUCHED, { meta, minimums }), scE = screen(EXAMINED, { meta, minimums });
  const out = { label: "RESEARCH ROUND 8 (portfolio-level, LONG only; Coinbase candles; Kraken minimums; NOT PAPER results)", code_version: gitRev, preregistration: arg("prereg", null),
    period: PERIOD, costs: COSTS, scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.label])), screen: { untouched: scU, examined: scE },
    benchmarks: { cash: 0, equal_weight_buy_hold_untouched: equalWeightBuyHold(load(scU.eligible, 1440), win, COSTS.selected), equal_weight_buy_hold_examined: equalWeightBuyHold(load(scE.eligible, 1440), win, COSTS.selected),
      btc_buy_hold: raw["BTC-86400"] ? equalWeightBuyHold({ BTC: raw["BTC-86400"] }, win, COSTS.selected) : null }, candidates: {}, provenance };
  for (const cand of CANDIDATES) {
    const u = evaluate(cand, load(scU.eligible, cand.tf), minimums, win), e = evaluate(cand, load(scE.eligible, cand.tf), minimums, win);
    const pass = u.acceptance.pass && !scU.underpowered;
    out.candidates[cand.id] = { family: cand.family, origin: cand.origin, tf: cand.tf, status: pass ? "ELIGIBLE FOR FURTHER VALIDATION" : "FAILED",
      failed: [...u.acceptance.failed, ...(scU.underpowered ? ["underpowered_screen"] : [])], untouched: u, examined_secondary: e.scenarios };
    const b = u.scenarios.B.selected;
    console.error(`${cand.id}: B net ${b.net} (${b.trades} trades, gross ${b.gross}, fees ${b.fees}, dd ${b.max_dd_pct}%, exec ${b.executable_pct}%) stress ${u.scenarios.B.stress.net} | A exec ${u.scenarios.A.selected.executable_pct}% | ${out.candidates[cand.id].status} ${out.candidates[cand.id].failed.join(",")}`);
  }
  writeFileSync(arg("out", "r8-results.json"), JSON.stringify(out, null, 1));
}

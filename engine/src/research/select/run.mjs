#!/usr/bin/env node
// Strategy selection driver (docs/research/strategy-select/PREREGISTRATION.md, frozen in d6d9c1f). Research only.
//   node src/research/select/run.mjs --pre <data/strategy-select> --post <data/research2> --out results.json
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BUYHOLD, DAY, S1, S2, S3, S4, runSleeve } from "./alloc.mjs";
import { blockBootstrap } from "../r8/xsmom.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const PRE = arg("pre"), POST = arg("post"), D = Date.parse;
const UNTOUCHED = [D("2016-01-01"), D("2021-06-01")], SEEN = [D("2021-06-01"), D("2026-11-15")];
const COST = { primary: { feePct: 0.2, slipPct: 0.05 }, stress: { feePct: 0.4, slipPct: 0.1 } };
const KMIN = { BTC: [0.00006, 0.5], ETH: [0.002, 0.5], SOL: [0.05, 0.5], LTC: [0.08, 0.5], BCH: [0.018, 0.5], ETC: [0.7, 0.5], XLM: [25, 0.5] }; // Kraken public AssetPairs
const provenance = {};
function load(file) { try { const raw = readFileSync(file); provenance[file.split(/[\\/]/).pop()] = createHash("sha256").update(raw).digest("hex").slice(0, 16); return JSON.parse(raw).candles.map(({ t, o, h, l, c }) => ({ t, o, h, l, c })); } catch { return []; } }
function series(m) {
  const byT = new Map();
  for (const b of [...load(`${PRE}/${m}-USD-86400-pre2021.json`), ...load(`${POST}/${m}-USD-86400.json`)]) byT.set(b.t, b);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

const CANDIDATES = {
  S1: { rule: S1({ n: 200 }), threshold: 0, neighbours: { "S1-150": S1({ n: 150 }), "S1-250": S1({ n: 250 }) } },
  S2: { rule: S2({ L: 84 }), threshold: 0, neighbours: { "S2-56": S2({ L: 56 }), "S2-112": S2({ L: 112 }) } },
  S3: { rule: S3({ n: 200, target: 0.4 }), threshold: 0.1, neighbours: { "S3-0.30": S3({ target: 0.3 }), "S3-0.50": S3({ target: 0.5 }) } },
  S4: { rule: S4({ N: 55, M: 20 }), threshold: 0, neighbours: { "S4-40/20": S4({ N: 40, M: 20 }), "S4-70/30": S4({ N: 70, M: 30 }) } },
};
const scaled = (rule, f) => (bars) => { const d = rule(bars); return (i) => { const w = d(i); return w === null || w === undefined ? w : w * f; }; };

/** $100 shared portfolio, equal sleeves; returns portfolio metrics. */
function portfolio(markets, rule, [from, to], cost, { threshold = 0, capital = 100, bandOnActual = false, skipInfeasible = false, minUsdBy = null } = {}) {
  const per = capital / markets.length, sleeves = markets.map((m) => ({ m, r: runSleeve(series(m), rule, { capital: per, from, to, threshold, bandOnActual, skipInfeasible, minUsd: minUsdBy?.[m] ?? 0, ...cost, minQty: KMIN[m][0], minNotional: KMIN[m][1] }) }));
  const days = []; for (let t = Math.ceil(from / DAY) * DAY; t < to; t += DAY) days.push(t);
  const maps = sleeves.map((s) => new Map(s.r.curve.map((p) => [p.t, p.eq])));
  const cur = sleeves.map(() => per), eq = [];
  for (const t of days) { maps.forEach((mp, k) => { if (mp.has(t)) cur[k] = mp.get(t); }); eq.push({ t, eq: cur.reduce((a, b) => a + b, 0) }); }
  const last = eq.at(-1).eq, net = last - capital;
  let peak = -Infinity, mdd = 0; for (const p of eq) { peak = Math.max(peak, p.eq); mdd = Math.max(mdd, 1 - p.eq / peak); }
  const rets = eq.slice(1).map((p, i) => p.eq / eq[i].eq - 1), mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1));
  const years = {}; for (let i = 1; i < eq.length; i++) { const y = new Date(eq[i].t).getUTCFullYear(); years[y] = (years[y] ?? 0) + eq[i].eq - eq[i - 1].eq; }
  const weekly = []; for (let i = 7; i < eq.length; i += 7) weekly.push(eq[i].eq / eq[i - 7].eq - 1);
  const trips = sleeves.flatMap((s) => s.r.trips), wins = trips.filter((x) => x.net > 0).reduce((a, x) => a + x.net, 0), losses = -trips.filter((x) => x.net <= 0).reduce((a, x) => a + x.net, 0);
  const orders = sleeves.flatMap((s) => s.r.orders);
  return { net: +net.toFixed(2), cagr_pct: +(((last / capital) ** (365 / eq.length) - 1) * 100).toFixed(2), mdd_pct: +(mdd * 100).toFixed(2), sharpe: +((mu / sd) * Math.sqrt(365)).toFixed(3),
    profit_factor: losses > 0 ? +(wins / losses).toFixed(2) : null, round_trips: trips.length, fees: +sleeves.reduce((a, s) => a + s.r.fees, 0).toFixed(2),
    exposure_pct: +((sleeves.reduce((a, s) => a + s.r.exposure, 0) / sleeves.length) * 100).toFixed(1), years: Object.fromEntries(Object.entries(years).map(([y, v]) => [y, +v.toFixed(2)])),
    orders: orders.length, orders_infeasible: orders.filter((o) => !o.feasible).length, weekly, per_market: Object.fromEntries(sleeves.map((s) => [s.m, +(s.r.final - per).toFixed(2)])) };
}
const lean = (p) => { const { weekly: _w, ...rest } = p; return rest; };

const out = { preregistration: "docs/research/strategy-select/PREREGISTRATION.md (d6d9c1f)", windows: { untouched: "2016-01-01..2021-05-31 (BTC, ETH)", seen: "2021-06-01..2026-11-14 (BTC, ETH, SOL)" }, costs: COST, results: {}, provenance };
const UM = ["BTC", "ETH"], SM = ["BTC", "ETH", "SOL"];
const bhU = portfolio(UM, BUYHOLD(), UNTOUCHED, COST.primary), bhS = portfolio(SM, BUYHOLD(), SEEN, COST.primary);
out.buy_hold = { untouched: lean(bhU), seen: lean(bhS) };
for (const [id, c] of Object.entries(CANDIDATES)) {
  const u = portfolio(UM, c.rule, UNTOUCHED, COST.primary, c), us = portfolio(UM, c.rule, UNTOUCHED, COST.stress, c), s = portfolio(SM, c.rule, SEEN, COST.primary, c);
  const nb = Object.fromEntries(Object.entries(c.neighbours).map(([k, r]) => [k, portfolio(UM, r, UNTOUCHED, COST.primary, c).net]));
  const boot = blockBootstrap(u.weekly, { block: 4, n: 10_000, alpha: 0.0125 });
  const fullYears = [2016, 2017, 2018, 2019, 2020].filter((y) => (u.years[y] ?? 0) > 0).length;
  const topYear = Math.max(...Object.values(u.years));
  const gates = {
    G1_net_and_stress: u.net > 0 && us.net > 0,
    G2_risk_adjusted_vs_buy_hold: u.sharpe >= bhU.sharpe || (u.mdd_pct <= 0.6 * bhU.mdd_pct && u.net > 0),
    G3_3_of_5_years_positive: fullYears >= 3,
    G4_no_year_over_70pct: u.net > 0 && topYear <= 0.7 * u.net,
    G5_neighbours_positive: Object.values(nb).every((x) => x > 0),
    G6_seen_period_positive: s.net > 0,
    G7_bootstrap_98_75_lower_gt_0: boot.lo > 0,
  };
  const pass = Object.values(gates).every(Boolean);
  out.results[id] = { pass, gates, failed: Object.entries(gates).filter(([, v]) => !v).map(([k]) => k), untouched: lean(u), untouched_stress: { net: us.net, cagr_pct: us.cagr_pct, mdd_pct: us.mdd_pct },
    seen: lean(s), neighbours: nb, bootstrap_weekly_98_75: { lo: +boot.lo.toFixed(5), mean: +boot.mean.toFixed(5), hi: +boot.hi.toFixed(5) }, positive_full_years: fullYears };
  console.error(`${id}: untouched net ${u.net} CAGR ${u.cagr_pct}% MDD ${u.mdd_pct}% Sharpe ${u.sharpe} | stress ${us.net} | seen ${s.net} (MDD ${s.mdd_pct}%) | ${pass ? "PASS" : "fail " + out.results[id].failed.join(",")}`);
}
console.error(`buy&hold: untouched net ${bhU.net} CAGR ${bhU.cagr_pct}% MDD ${bhU.mdd_pct}% Sharpe ${bhU.sharpe} | seen ${bhS.net} MDD ${bhS.mdd_pct}%`);
const passing = Object.entries(out.results).filter(([, r]) => r.pass).sort((a, b) => b[1].untouched.sharpe - a[1].untouched.sharpe || a[1].untouched.mdd_pct - b[1].untouched.mdd_pct);
const lead = passing[0] ?? Object.entries(out.results).sort((a, b) => b[1].untouched.sharpe - a[1].untouched.sharpe)[0];
out.selected = passing.length ? passing[0][0] : null;
out.lead = lead[0];
// the < 2% drawdown objective, for the selected candidate or the lead
const L = CANDIDATES[lead[0]], f = Math.min(1, 2 / lead[1].untouched.mdd_pct);
const capped = portfolio(UM, scaled(L.rule, f), UNTOUCHED, COST.primary, L);
out.two_pct_drawdown = { candidate: lead[0], exposure_fraction: +f.toFixed(4), untouched: lean(capped), orders_infeasible_share: capped.orders ? +(capped.orders_infeasible / capped.orders).toFixed(3) : null };
// secondary independent markets (pre-2021), each as its own $100, for the lead
out.secondary = Object.fromEntries(["LTC", "BCH", "ETC", "XLM"].map((m) => { const s = series(m).filter((b) => b.t < UNTOUCHED[1]); if (s.length < 730) return [m, "excluded: < 2 years before 2021-06"]; const a = portfolio([m], L.rule, [s[0].t, UNTOUCHED[1]], COST.primary, L), bh = portfolio([m], BUYHOLD(), [s[0].t, UNTOUCHED[1]], COST.primary); return [m, { net: a.net, mdd_pct: a.mdd_pct, sharpe: a.sharpe, buy_hold_net: bh.net, buy_hold_mdd_pct: bh.mdd_pct }]; }));
// ---- SENSITIVITY (added after the first run, disclosed; never changes the selection above) ----
// The pre-registered S3 implementation compares a new target with the last executed target, so it never re-sizes for
// price drift; that also broke the 2% scaling (a 4.8% position grew with the price). The standard reading of a
// rebalancing band compares the target with the position's ACTUAL weight. Both are reported.
const s3a = { ...CANDIDATES.S3, bandOnActual: true };
const s3u = portfolio(UM, s3a.rule, UNTOUCHED, COST.primary, s3a), s3us = portfolio(UM, s3a.rule, UNTOUCHED, COST.stress, s3a), s3s = portfolio(SM, s3a.rule, SEEN, COST.primary, s3a);
const s3b = blockBootstrap(s3u.weekly, { block: 4, n: 10_000, alpha: 0.0125 });
out.sensitivity_S3_actual_weight_band = { untouched: lean(s3u), untouched_stress: { net: s3us.net, mdd_pct: s3us.mdd_pct }, seen: lean(s3s), bootstrap_weekly_98_75: { lo: +s3b.lo.toFixed(5), mean: +s3b.mean.toFixed(5), hi: +s3b.hi.toFixed(5) },
  neighbours: Object.fromEntries(Object.entries(CANDIDATES.S3.neighbours).map(([k, r]) => [k, portfolio(UM, r, UNTOUCHED, COST.primary, s3a).net])) };
// 2% drawdown objective, corrected: re-size relative to the scaled exposure (threshold x f) against the ACTUAL weight
const fixF = (mdd) => Math.min(1, 2 / mdd);
const f2 = fixF(s3u.mdd_pct);
const c2u = portfolio(UM, scaled(CANDIDATES.S3.rule, f2), UNTOUCHED, COST.primary, { threshold: 0.1 * f2, bandOnActual: true });
const c2s = portfolio(SM, scaled(CANDIDATES.S3.rule, f2), SEEN, COST.primary, { threshold: 0.1 * f2, bandOnActual: true });
const lastClose = (m) => series(m).at(-1).c;
const sleeveNow = (m, n) => (100 / n) * f2;   // the largest position a sleeve would hold at exposure f2
out.two_pct_drawdown_corrected = { candidate: "S3 (actual-weight band)", exposure_fraction: +f2.toFixed(4), untouched: lean(c2u), seen: lean(c2s),
  kraken_feasibility_at_latest_prices: Object.fromEntries(SM.map((m) => { const minUsd = Math.max(KMIN[m][0] * lastClose(m), KMIN[m][1]); return [m, { max_position_usd: +sleeveNow(m, SM.length).toFixed(2), min_order_usd: +minUsd.toFixed(2), feasible: sleeveNow(m, SM.length) >= minUsd }]; })) };
// ---- POST-HOC ILLUSTRATIONS (NOT validation: computed after seeing the results; no parameter was chosen from them) ----
// The forward PAPER trial configuration: BTC + ETH, one shared $100 ($50 sleeves), corrected S3, and TODAY's Kraken
// minimum order in USD enforced (orders below it are skipped, full exits always allowed). Plus an exposure frontier:
// the same weights scaled by f, to show what a smaller drawdown costs. These are deterministic scalings, not fits.
const TRIAL = ["BTC", "ETH"];
const minUsdBy = Object.fromEntries(TRIAL.map((m) => [m, Math.max(KMIN[m][0] * lastClose(m), KMIN[m][1])]));
const trialRun = (f, win) => portfolio(TRIAL, f === 1 ? CANDIDATES.S3.rule : scaled(CANDIDATES.S3.rule, f), win, COST.primary, { threshold: 0.1 * f, bandOnActual: true, skipInfeasible: true, minUsdBy });
out.post_hoc = { note: "NOT independent validation: illustrations computed after the results were known; no parameter was selected from them", minimum_order_usd_today: Object.fromEntries(Object.entries(minUsdBy).map(([k, v]) => [k, +v.toFixed(2)])), frontier: {} };
for (const f of [1, 0.5, 0.25]) {
  const u = trialRun(f, UNTOUCHED), s = trialRun(f, SEEN);
  out.post_hoc.frontier[`exposure_${f}`] = { untouched: { net: u.net, cagr_pct: u.cagr_pct, mdd_pct: u.mdd_pct, sharpe: u.sharpe, orders: u.orders, skipped_below_minimum: u.orders_infeasible },
    seen_btc_eth: { net: s.net, cagr_pct: s.cagr_pct, mdd_pct: s.mdd_pct, sharpe: s.sharpe, orders: s.orders, skipped_below_minimum: s.orders_infeasible, years: s.years } };
  console.error(`POST-HOC trial config f=${f}: untouched CAGR ${u.cagr_pct}% MDD ${u.mdd_pct}% Sharpe ${u.sharpe} skipped ${u.orders_infeasible}/${u.orders} | seen(BTC+ETH) CAGR ${s.cagr_pct}% MDD ${s.mdd_pct}% Sharpe ${s.sharpe} skipped ${s.orders_infeasible}/${s.orders}`);
}
console.error(`SENSITIVITY S3 actual band: untouched net ${s3u.net} CAGR ${s3u.cagr_pct}% MDD ${s3u.mdd_pct}% Sharpe ${s3u.sharpe} | stress ${s3us.net} | seen ${s3s.net} MDD ${s3s.mdd_pct}% | boot lo ${s3b.lo.toFixed(5)}`);
console.error(`2% corrected: exposure ${f2.toFixed(4)} -> untouched CAGR ${c2u.cagr_pct}% MDD ${c2u.mdd_pct}% | seen CAGR ${c2s.cagr_pct}% MDD ${c2s.mdd_pct}% | feasibility ${JSON.stringify(out.two_pct_drawdown_corrected.kraken_feasibility_at_latest_prices)}`);
writeFileSync(arg("out", "select-results.json"), JSON.stringify(out, null, 1));
console.error(`selected: ${out.selected ?? "NONE"}; lead: ${out.lead}; 2% DD needs exposure ${f.toFixed(3)} -> untouched CAGR ${capped.cagr_pct}% MDD ${capped.mdd_pct}% infeasible orders ${capped.orders_infeasible}/${capped.orders}`);
console.error("secondary:", JSON.stringify(out.secondary));

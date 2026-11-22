// Historical execution-cost backtest across market cycles (research only; strategies FROZEN, nothing is optimised).
// Prices: Kraken's OFFICIAL OHLCVT archive (daily bars for signals and fills; hourly bars for limit-order fill tests).
// Costs per side (labelled by source in the output):
//   Kraken market   OBSERVED walk cost of a C$50 market order (5-level books, Tardis first-of-month), interpolated between
//                   observation dates; before the first observation (Jul 2019) the first observation is CARRIED BACK
//                   (assumption) and a x2 stress variant is reported. BTC/ETH USD books: observed top-of-book half-spread.
//   Kraken limit    post-only at the best bid/ask (observed half-spread); FILLS only if a later Kraken hourly bar of the
//                   same pair trades THROUGH the limit by EPS (no historical queue data exists; trade-through is the
//                   conservative proxy). POST = 24 h then missed; HYBRID = 4 h then market at that hour's price.
//   Ndax market     OBSERVED today only (7-day collector, C$50 walk); applied to all history as an ASSUMPTION (x2 stress).
//                   Ndax did not exist before 2018-03-21; SOL/CAD listed 2021-12-25 (earlier SOL entries are impossible).
//   Fees            Kraken: archived fee pages (0.16/0.26 % until >= 2024-03; 0.25/0.40 % by 2024-07 to >= 2025-10;
//                   0.40/0.80 % by 2026-03) or today's schedule throughout; Ndax 0.20 % flat (archived 2019, 2023, 2024).
//   Conversion      Kraken USD route: CAD->USD at the start and USD->CAD at the end: 2 x (0.20 % FX fee + observed C$100
//                   USD/CAD walk cost). Kraken listed USD/CAD on 2020-03-12; earlier dates use the first observation.
//   node hist-backtest.mjs <hist-costs dir> <cost-study data dir> <spreads-live.json> <out.json>
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { backtest } from "../dd2/bt.mjs";
import { CANDIDATES } from "../phase3/candidates.mjs";

const [DIR, STUDY, LIVE, OUT] = process.argv.slice(2);
const HOUR = 3_600_000, DAY = 86_400_000, EPS = 0.0005;
const readCsv = (f) => readFileSync(join(DIR, "kraken-ohlcvt", f), "utf8").trim().split("\n").map((l) => { const x = l.split(",").map(Number); return { t: x[0] * 1000, o: x[1], h: x[2], l: x[3], c: x[4], v: x[5], n: x[6] }; });
const PAIR = { "BTC/USD": "XBTUSD", "BTC/CAD": "XBTCAD", "ETH/USD": "ETHUSD", "ETH/CAD": "ETHCAD", "SOL/USD": "SOLUSD", "SOL/CAD": "SOLCAD", "USD/CAD": "USDCAD" };
const DAILY = {}, HOURLY = {};
for (const [s, p] of Object.entries(PAIR)) { DAILY[s] = new Map(readCsv(`${p}_1440.csv`).map((b) => [b.t, b])); HOURLY[s] = new Map(readCsv(`${p}_60.csv`).map((b) => [b.t, b])); }
const K = Object.fromEntries(["BTC", "ETH", "SOL"].map((a) => [a, [...DAILY[`${a}/USD`].values()].sort((x, y) => x.t - y.t)]));
const LISTED = { kraken: { "SOL/CAD": Date.parse("2024-11-27"), "USD/CAD": Date.parse("2020-03-12") }, ndax: { BTC: Date.parse("2018-03-21"), ETH: Date.parse("2018-03-21"), SOL: Date.parse("2021-12-25") } };
const norm = (s) => s.replace("XBT", "BTC").replace("-", "/");

// ---- observed cost series ----
const series = (rows, val) => { const m = {}; for (const r of rows) { if (r.error || !(r.minutes > 600)) continue; const v = val(r); if (!(v >= 0)) continue; (m[norm(r.symbol)] ??= []).push({ t: Date.parse(r.date), v }); } for (const k in m) m[k].sort((a, b) => a.t - b.t); return m; };
const depthRows = JSON.parse(readFileSync(join(DIR, "depth-observed.json"), "utf8")).rows;
const quoteRows = JSON.parse(readFileSync(join(DIR, "books-observed.json"), "utf8")).rows;
const WALK50 = series(depthRows, (r) => r.cost_per_side_bps["50"].mean);
const WALK100 = series(depthRows, (r) => r.cost_per_side_bps["100"].mean);
const HALF = series(quoteRows, (r) => r.spread_bps.median / 2); // top-of-book half-spread (limit-order improvement)
const HALF_DEPTH = series(depthRows, (r) => r.spread_bps.median / 2);
function lookup(s, t) { // -> { v (bps), src }
  if (!s?.length) return null;
  if (t < s[0].t) return { v: s[0].v, src: "assumed" };
  if (t >= s.at(-1).t) return { v: s.at(-1).v, src: t - s.at(-1).t < 62 * DAY ? "observed" : "carried" };
  let i = 0; while (s[i + 1].t <= t) i++;
  const a = s[i], b = s[i + 1], w = (t - a.t) / (b.t - a.t);
  return { v: a.v + (b.v - a.v) * w, src: t - a.t < 31 * DAY ? "observed" : "interpolated" };
}
// USD BTC/ETH books are deep: market cost = observed top half-spread + the mean extra walk measured on depth-check dates
const usdImpact = {};
for (const a of ["BTC", "ETH"]) { const w = WALK50[`${a}/USD`] ?? [], h = HALF_DEPTH[`${a}/USD`] ?? []; const d = w.map((x, i) => x.v - (h[i]?.v ?? 0)); usdImpact[a] = d.length ? Math.max(0, d.reduce((p, q) => p + q, 0) / d.length) : 0; }
const krakenSym = (a, quote, t) => (quote === "CAD" && a === "SOL" && t < LISTED.kraken["SOL/CAD"] ? "SOL/USD" : `${a}/${quote}`);
const STATS = { src: {} };
function mktBps(a, quote, t, preMult) {
  const sym = krakenSym(a, quote, t);
  let r;
  if (quote === "USD" && (a === "BTC" || a === "ETH")) { const h = lookup(HALF[sym], t); r = h && { v: h.v + usdImpact[a], src: h.src }; }
  else r = lookup(WALK50[sym], t) ?? (() => { const h = lookup(HALF[sym], t); return h && { v: h.v, src: "top-of-book only" }; })();
  if (!r) throw new Error(`no cost for ${sym}`);
  STATS.src[r.src] = (STATS.src[r.src] ?? 0) + 1;
  return r.src === "assumed" ? r.v * preMult : r.v;
}
const halfBps = (a, quote, t, preMult) => { const sym = krakenSym(a, quote, t); const r = lookup(HALF[sym], t); return r.src === "assumed" ? r.v * preMult : r.v; };
// Ndax: today's observed C$50 walk cost (7-day collector so far); SOL/CAD from the earlier 24-sample live check
const ndaxNow = (() => {
  const S = []; for (const f of readdirSync(STUDY).filter((x) => x.startsWith("samples-"))) for (const l of readFileSync(join(STUDY, f), "utf8").trim().split("\n")) S.push(JSON.parse(l));
  const med = (v) => { const s = v.filter(Number.isFinite).sort((x, y) => x - y); return s[s.length >> 1]; };
  const c = (k) => med(S.map((s) => { const b = s.books[k]; return b?.exec?.[50]?.buy && b.exec[50].sell ? (((b.exec[50].buy / b.mid - 1) + (1 - b.exec[50].sell / b.mid)) / 2) * 1e4 : NaN; }));
  const live = JSON.parse(readFileSync(LIVE, "utf8")).summary["Ndax SOL/CAD"];
  return { BTC: c("Ndax BTC/CAD"), ETH: c("Ndax ETH/CAD"), SOL: (live.buy50_bps_median + live.sell50_bps_median) / 2, samples: S.length, from: new Date(S[0].t).toISOString(), to: new Date(S.at(-1).t).toISOString(),
    kraken_now: { "BTC/CAD": c("Kraken BTC/CAD"), "ETH/CAD": c("Kraken ETH/CAD"), "USD/CAD": c("Kraken USD/CAD") } };
})();
// Ndax premium vs Kraken CAD (sensitivity only): daily close ratio, 3-day median, from 2019 (earlier Ndax trading was too thin)
const ndaxPrem = (() => {
  const out = {};
  for (const [a, f] of [["BTC", "BTCCAD"], ["ETH", "ETHCAD"], ["SOL", "SOLCAD"]]) {
    const rows = JSON.parse(readFileSync(join(DIR, "ndax", `${f}-daily.json`), "utf8")).rows, kc = DAILY[`${a}/CAD`];
    const raw = []; for (const x of rows) { const t = x[9]; if (t < Date.parse("2019-01-01") || !(x[5] > 0)) continue; const k = kc.get(t); if (k) raw.push([t, x[4] / k.c - 1]); }
    const m = new Map(); for (let i = 2; i < raw.length; i++) { const v = [raw[i][1], raw[i - 1][1], raw[i - 2][1]].sort((p, q) => p - q)[1]; m.set(raw[i][0] + DAY, v); } // usable the NEXT day
    out[a] = m;
  }
  return out;
})();
const premAt = (a, t) => { const m = ndaxPrem[a]; for (let d = 0; d < 10; d++) { const v = m.get(t - d * DAY); if (v !== undefined) return v; } return 0; };

// Ndax cost per side: today's level for all history, or (scaled) Kraken CAD's observed history x today's Ndax/Kraken ratio
// measured at the same moments by the collector (SOL: no same-moment Kraken SOL/CAD sample, so today's level)
const ndaxRatio = { BTC: ndaxNow.BTC / ndaxNow.kraken_now["BTC/CAD"], ETH: ndaxNow.ETH / ndaxNow.kraken_now["ETH/CAD"] };
// (the same-moment ratio is reported but NOT used: it is unstable, ~10x for BTC today, and gives implausible history)
// "floor" variant: Ndax never cheaper than its level today nor than Kraken CAD's observed cost at that date (conservative)
function ndaxBps(a, t, r) { if (r.floor) return Math.max(ndaxNow[a], mktBps(a, "CAD", t, 1)) * r.ndaxMult; return ndaxNow[a] * r.ndaxMult; }
// ---- fees ----
const krakenFee = (t, basis) => (basis === "current" ? { maker: 0.004, taker: 0.008 } : t < Date.parse("2024-05-01") ? { maker: 0.0016, taker: 0.0026 } : t < Date.parse("2026-01-01") ? { maker: 0.0025, taker: 0.004 } : { maker: 0.004, taker: 0.008 });

// ---- routes ----
function makeRoute(r) {
  const st = { placed: 0, maker: 0, fallback: 0, missed: 0, notListed: 0 };
  const refs = new Map();
  const exec = (asset, t, side, _o, bar) => {
    refs.set(`${asset}|${t}|${side}`, bar.o);
    const sgn = side === "BUY" ? 1 : -1;
    if (r.venue === "Ndax") {
      if (t < LISTED.ndax[asset]) { st.notListed++; return null; }
      const c = ndaxBps(asset, t, r) / 1e4, p = r.premium ? 1 + premAt(asset, t) : 1;
      return { px: bar.o * p * (1 + sgn * c), fee: 0.002 };
    }
    const fee = krakenFee(t, r.feeBasis), c = mktBps(asset, r.quote, t, r.preMult) / 1e4;
    if (r.method === "MARKET") return { px: bar.o * (1 + sgn * c), fee: fee.taker };
    st.placed++;
    const sym = krakenSym(asset, r.quote, t), H = HOURLY[sym], ref = H.get(t)?.o ?? DAILY[sym].get(t)?.o;
    if (!ref) { if (r.method === "POST") { st.missed++; return null; } st.fallback++; return { px: bar.o * (1 + sgn * c), fee: fee.taker }; }
    const lim = ref * (1 - sgn * halfBps(asset, r.quote, t, r.preMult) / 1e4), W = r.method === "POST" ? 24 : 4;
    for (let h = 0; h < W; h++) { const b = H.get(t + h * HOUR); if (b && (side === "BUY" ? b.l <= lim * (1 - EPS) : b.h >= lim * (1 + EPS))) { st.maker++; return { px: bar.o * (lim / ref), fee: fee.maker }; } }
    if (r.method === "POST") { st.missed++; return null; }
    st.fallback++;
    let P = null; for (let h = W; h < W + 6 && P === null; h++) P = H.get(t + h * HOUR)?.o ?? null;
    if (P === null) for (let h = W - 1; h >= 0 && P === null; h--) P = H.get(t + h * HOUR)?.c ?? null;
    P ??= ref;
    return { px: bar.o * (P / ref) * (1 + sgn * c), fee: fee.taker };
  };
  const stopExec = (asset, t) => r.venue === "Ndax" ? { slip: Math.max(ndaxBps(asset, t, r) / 1e4, 0.001), fee: 0.002 } : { slip: Math.max(mktBps(asset, r.quote, t, r.preMult) / 1e4, 0.001), fee: krakenFee(t, r.feeBasis).taker };
  const conversion = r.quote === "USD" ? (t) => 2 * (0.002 + (r.preMult && t < LISTED.kraken["USD/CAD"] ? lookup(WALK100["USD/CAD"], t).v * r.preMult : lookup(WALK100["USD/CAD"], t).v) / 1e4) : null;
  return { ...r, exec, stopExec, st, refs, conversion };
}
const KR = (quote, method, feeBasis, preMult = 1, histMin = false) => ({ name: `Kraken ${quote} · ${method}${quote === "USD" ? " (+conversion)" : ""} · ${feeBasis} fees${preMult !== 1 ? " · pre-2019 cost x" + preMult : ""}${histMin ? " · HISTORICAL minimums" : ""}`, venue: "Kraken", quote, method, feeBasis, preMult, histMin });
const ROUTES = [
  KR("CAD", "MARKET", "historical"), KR("CAD", "POST", "historical"), KR("CAD", "HYBRID", "historical"), KR("USD", "MARKET", "historical"), KR("USD", "HYBRID", "historical"),
  KR("CAD", "MARKET", "current"), KR("CAD", "POST", "current"), KR("CAD", "HYBRID", "current"), KR("USD", "MARKET", "current"), KR("USD", "HYBRID", "current"),
  KR("CAD", "MARKET", "historical", 2), KR("CAD", "HYBRID", "current", 2), KR("CAD", "MARKET", "historical", 1, true), KR("CAD", "POST", "current", 2),
  { name: "Ndax CAD · MARKET · 0.20 % flat", venue: "Ndax", ndaxMult: 1 },
  { name: "Ndax CAD · MARKET · Ndax spread x2 (stress)", venue: "Ndax", ndaxMult: 2 },
  { name: "Ndax CAD · MARKET · + observed Ndax premium changes", venue: "Ndax", ndaxMult: 1, premium: true },
  { name: "Ndax CAD · MARKET · spread = max(today's Ndax, Kraken CAD history)", venue: "Ndax", ndaxMult: 1, floor: true },
];
const STRATS = { "S3 (frozen)": { uni: ["BTC", "ETH"], spec: { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 } }, ...CANDIDATES };
const MINQ = { Kraken: { BTC: 0.00006, ETH: 0.002, SOL: 0.05 }, Ndax: { BTC: 0.00001, ETH: 0.0001, SOL: 0.01 } };
// Kraken minimum order sizes from archived copies of support article 205893708 (each applies from its snapshot date;
// before the first snapshot, 2020-03-22, the first snapshot is ASSUMED). Today's minimums are from the public API.
const KRAKEN_MIN_HIST = [
  ["2020-03-22", { BTC: 0.002, ETH: 0.02, SOL: 0.02 }], ["2021-05-22", { BTC: 0.0001, ETH: 0.004, SOL: 0.02 }], ["2022-05-17", { BTC: 0.0001, ETH: 0.001, SOL: 0.02 }],
  ["2023-05-29", { BTC: 0.0001, ETH: 0.01, SOL: 0.25 }], ["2024-06-23", { BTC: 0.0001, ETH: 0.002, SOL: 0.05 }], ["2026-11-22", { BTC: 0.00006, ETH: 0.002, SOL: 0.05 }],
].map(([d, v]) => [Date.parse(d), v]);
const krakenMinAt = (a) => (t) => { let v = KRAKEN_MIN_HIST[0][1]; for (const [d, m] of KRAKEN_MIN_HIST) if (t >= d) v = m; return v[a]; };
const CYCLES = [
  ["2017-18 cycle (bull + bear)", "2017-01-01", "2019-01-01"], ["2019 recovery", "2019-01-01", "2020-02-13"], ["Mar 2020 crash", "2020-02-13", "2020-05-01"],
  ["2020-21 bull", "2020-05-01", "2021-11-10"], ["2022 bear", "2021-11-10", "2023-01-01"], ["2023-26", "2023-01-01", "2026-10-01"],
];
const WINDOWS = { "2016-07..2026-09 (Kraken only; Ndax did not exist before 2018-03)": ["2016-07-01", "2026-10-01"], "2018-04..2026-09 (all venues)": ["2018-04-01", "2026-10-01"] };
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);

function cycleStats(bt, audit, refs, from, to) {
  return CYCLES.map(([name, a, b]) => {
    const A = Date.parse(a), B = Date.parse(b);
    if (A < from) return { cycle: name, n_a: "window starts later" };
    const c = bt.curve.filter(([t]) => t >= A && t < B); if (!c.length) return { cycle: name, n_a: "no data" };
    const before = bt.curve.filter(([t]) => t < A).at(-1)?.[1] ?? 100;
    let peak = before, dd = 0; for (const [, v] of c) { peak = Math.max(peak, v); dd = Math.max(dd, 1 - v / peak); }
    const tr = audit.filter((x) => x.t >= A && x.t < B);
    const spreadCost = tr.reduce((s, x) => { const ref = x.kind === "STOP" ? Math.min(x.ref.open, x.ref.stop) : refs.get(`${x.asset}|${x.t}|${x.side}`); return s + (ref ? Math.abs(x.px - ref) * x.qty : 0); }, 0);
    return { cycle: name, ret_pct: r2((c.at(-1)[1] / before - 1) * 100), close_dd_pct: r2(dd * 100), orders: tr.length, fees_usd: r2(tr.reduce((s, x) => s + x.fee, 0)), spread_slippage_usd: r2(spreadCost) };
  });
}
const res = { generated: new Date().toISOString(), method: "see file header", ndax_now: ndaxNow, usd_book_extra_impact_bps: usdImpact, eps_trade_through: EPS, windows: {} };
for (const [wName, [w0, w1]] of Object.entries(WINDOWS)) {
  const from = Date.parse(w0), to = Date.parse(w1), rows = [];
  for (const [sName, s] of Object.entries(STRATS)) {
    // today's minimums unless the route asks for Kraken's historical minimums
    const assets = (venue, histMin = false) => s.uni.map((a) => ({ name: a, K: K[a], minQty: MINQ[venue][a], ...(histMin ? { minQtyAt: krakenMinAt(a) } : {}) }));
    // references: zero cost, and S3's shadow setting
    for (const [label, fee, slip] of [["reference: zero cost (gross)", 0, 0], ["reference: S3 shadow setting 0.20 % + 0.05 %", 0.002, 0.0005]]) {
      const audit = [], bt = backtest(assets("Kraken"), s.spec, { from, to, fee, slip, stopSlip: slip, audit });
      const refs = new Map(); for (const x of audit) refs.set(`${x.asset}|${x.t}|${x.side}`, x.px / (x.side === "BUY" ? 1 + slip : 1 - slip));
      rows.push({ strategy: sName, route: label, final: r2(bt.final), cagr_pct: r2(bt.cagr_pct), max_dd_pct: r2(bt.dd_pct), orders: bt.trades, fees_usd: r2(bt.fees), missed: 0, skipped_min: bt.skipped, meets_2pct: bt.dd_pct < 2, cycles: cycleStats(bt, audit, refs, from, to) });
    }
    for (const rDef of ROUTES) {
      if (rDef.venue === "Ndax" && from < LISTED.ndax.BTC) continue;
      const r = makeRoute(rDef), audit = [];
      const bt = backtest(assets(r.venue, !!r.histMin), s.spec, { from, to, fee: 0, slip: 0, stopSlip: 0, exec: r.exec, stopExec: r.stopExec, audit });
      const conv = r.conversion ? r.conversion(from) : 0, final = bt.final * (1 - conv), yrs = bt.curve.length / 365;
      rows.push({ strategy: sName, route: r.name, final: r2(final), cagr_pct: r2(((final / 100) ** (1 / yrs) - 1) * 100), max_dd_pct: r2(bt.dd_pct), orders: bt.trades, fees_usd: r2(bt.fees), conversion_pct: r2(conv * 100),
        missed: bt.missed, skipped_min: bt.skipped, limit_orders: { ...r.st }, meets_2pct: bt.dd_pct < 2, cycles: cycleStats(bt, audit, r.refs, from, to) });
    }
  }
  res.windows[wName] = rows;
}
res.cost_sources_used = STATS.src; res.ndax_ratio = ndaxRatio;
// per-side total cost (fee + spread/impact) by cycle, BTC and ETH, market orders, for the report's cost table
res.cost_per_side_by_cycle = {};
for (const [name, a, b] of CYCLES) {
  const days = []; for (let t = Date.parse(a); t < Date.parse(b); t += DAY) days.push(t);
  const avg = (f) => r2(days.reduce((s, t) => s + f(t), 0) / days.length);
  res.cost_per_side_by_cycle[name] = Object.fromEntries(["BTC", "ETH"].flatMap((x) => [
    [`${x} Kraken CAD market (historical fee)`, avg((t) => mktBps(x, "CAD", t, 1) + krakenFee(t, "historical").taker * 1e4)],
    [`${x} Kraken CAD market (today's fee)`, avg((t) => mktBps(x, "CAD", t, 1) + 80)],
    [`${x} Kraken USD market (today's fee)`, avg((t) => mktBps(x, "USD", t, 1) + 80)],
    [`${x} Kraken CAD spread/impact only`, avg((t) => mktBps(x, "CAD", t, 1))],
    [`${x} Ndax CAD market (today's spread, 0.20 %)`, r2(ndaxNow[x] + 20)],
    [`${x} Ndax CAD market (max(today, Kraken history), 0.20 %)`, avg((t) => Math.max(ndaxNow[x], mktBps(x, "CAD", t, 1)) + 20)],
  ]));
}
writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
for (const [w, rows] of Object.entries(res.windows)) {
  console.log(`\n######## ${w}`);
  for (const s of Object.keys(STRATS)) { console.log(`== ${s}`); for (const x of rows.filter((y) => y.strategy === s)) console.log(`${x.route.padEnd(72)} $${String(x.final).padStart(8)} ${String(x.cagr_pct).padStart(6)}%/yr DD ${String(x.max_dd_pct).padStart(5)}% orders ${String(x.orders).padStart(4)} fees $${String(x.fees_usd).padStart(6)} missed ${x.missed} skip ${x.skipped_min}`); }
}
console.log("\ncost per side by cycle (bps):", JSON.stringify(res.cost_per_side_by_cycle, null, 1));
console.log("ndax now:", JSON.stringify(ndaxNow), "usd impact", JSON.stringify(usdImpact));

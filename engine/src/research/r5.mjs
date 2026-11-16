#!/usr/bin/env node
// RESEARCH ROUND 5 (docs/research/round5/PREREGISTRATION.md, committed before any run). OTE / Fibonacci on 4h and daily,
// moving averages as FILTERS ONLY, on BTC/SOL/ETH (already examined; continuity) plus seven new markets (confirmatory).
// Same execution as round 4: production fleet backtest, strict acceptance (bar after acceptance; identity side + limit).
//   ALPHA_RESEARCH_DATA=<engine/data/research2> node src/research/r5.mjs --out r5.json
import { readFileSync, writeFileSync } from "node:fs";
import { aggregate, profileInputs, runFleetBacktest } from "../cli/fleet-backtest.mjs";
import { FleetLedgerSim } from "../capital.mjs";
import { getInstrument } from "../instruments.mjs";
import { DATA as R3DATA, MIN as R3MIN, H, simAsset, metrics as r3metrics, bh } from "./r3.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = process.env.ALPHA_RESEARCH_DATA;
const MIN = 60_000, DAY = 86_400_000, D = Date.parse;
const P = { development: [D("2021-07-01"), D("2024-07-01")], validation: [D("2024-07-01"), D("2026-11-15")] };
// Kraken public AssetPairs, fetched 2026-11-16T03:20Z (ordermin, costmin, tick). BTC/SOL/ETH use the production specs.
const KRAKEN = { LTC: [0.08, 0.01], LINK: [0.35, 0.00001], AVAX: [0.5, 0.001], ADA: [20, 0.000001], BCH: [0.018, 0.01], DOGE: [50, 0.0000001], XRP: [4, 0.00001] };
const spec = (a) => ({ ...getInstrument("ETHUSD"), symbol: `${a}USD`, providerSymbol: `${a}USD`, providerPair: `${a}/USD`, tick: KRAKEN[a][1], minQty: KRAKEN[a][0], minNotional: 0.5,
  verified: { source: `Kraken public AssetPairs ${a}/USD: ordermin ${KRAKEN[a][0]}, costmin 0.5, tick ${KRAKEN[a][1]} (research only)`, at: "2026-11-16T03:20:38Z" }, fundedEligible: false });
const OLD = ["BTC", "SOL", "ETH"], NEW = ["LTC", "LINK", "AVAX", "ADA", "BCH", "DOGE", "XRP"];
const A = { BTC: { prod: "BTC-USD", symbol: "BTCUSD", profile: "btcusd-5m" }, SOL: { prod: "SOL-USD", symbol: "SOLUSD", profile: "solusd-5m" }, ETH: { prod: "ETH-USD", symbol: "ETHUSD", profile: "btcusd-5m" } };
const COINBASE = { LTC: "LTC-USD", LINK: "LINK-USD", AVAX: "AVAX-USD", ADA: "ADA-USD", BCH: "BCH-USD", DOGE: "DOGE-USD", XRP: "XRP-USD" };
for (const a of NEW) A[a] = { prod: COINBASE[a], symbol: `${a}USD`, profile: "btcusd-5m", instrument: spec(a) };

const cache = new Map();
const load = (prod, g) => { const k = `${prod}-${g}`; if (!cache.has(k)) cache.set(k, JSON.parse(readFileSync(`${DIR}/${k}.json`, "utf8")).candles.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }))); return cache.get(k); };
const weeklyOf = (Kd) => { const m = new Map(); for (const k of Kd) { const wk = k.t - ((new Date(k.t).getUTCDay() + 6) % 7) * DAY; const w = m.get(wk); if (!w) m.set(wk, { t: wk, o: k.o, h: k.h, l: k.l, c: k.c }); else { w.h = Math.max(w.h, k.h); w.l = Math.min(w.l, k.l); w.c = k.c; } } return [...m.values()].sort((x, y) => x.t - y.t); };
const candles = (a, tf) => { const p = A[a].prod; if (tf === 240) { const k = `${p}-240`; if (!cache.has(k)) cache.set(k, aggregate(load(p, 3600), 240)); return cache.get(k); } if (tf === 1440) return load(p, 86400);
  if (tf === 10080) { const k = `${p}-W`; if (!cache.has(k)) cache.set(k, weeklyOf(load(p, 86400))); return cache.get(k); } throw new Error(`tf ${tf}`); };

// ---- data rule (pre-registered): exclude a market from a period if its daily or hourly candles have a gap > 30 days INSIDE the period (including a late start) ----
function maxGapDays(a, [from, to]) { let g = 0; for (const gr of [86400, 3600]) { const K = load(A[a].prod, gr).filter((k) => k.t >= from && k.t < to); if (!K.length) return Infinity; g = Math.max(g, (K[0].t - (from)) / DAY);
  for (let i = 1; i < K.length; i++) g = Math.max(g, (K[i].t - K[i - 1].t) / DAY); g = Math.max(g, (to - K.at(-1).t) / DAY - 1); } return +g.toFixed(1); }

// ---- filters: completed candles only ----
const emaArr = (xs, n) => { const al = 2 / (n + 1); let e = null; return xs.map((v, i) => (e = e === null ? v : e + al * (v - e), i + 1 < n ? null : e)); };
const smaArr = (xs, n) => { let s = 0; return xs.map((v, i) => { s += v; if (i >= n) s -= xs[i - n]; return i + 1 < n ? null : s / n; }); };
function htfGate(K, M, stepOf) { // last HTF candle completed by the signal bar's close; LONG above M, SHORT below
  const idx = new Map(K.map((k, i) => [k.t, i]));
  return (tf) => (t, dir) => { const close = t + tf * MIN; const i = idx.get(stepOf(close)); if (i === undefined || M[i] === null) return false; return dir === 1 ? K[i].c > M[i] : K[i].c < M[i]; };
}
const dayStart = (close) => Math.floor(close / DAY) * DAY - DAY; // daily candle that ended at or before close
const weekStart = (close) => { const d = Math.floor(close / DAY) * DAY; const mon = d - ((new Date(d).getUTCDay() + 6) % 7) * DAY; return mon - 7 * DAY; };
const dailyEma50 = (a) => { const K = candles(a, 1440); return htfGate(K, emaArr(K.map((k) => k.c), 50), dayStart); };
const weeklyEma20 = (a) => { const K = candles(a, 10080); return htfGate(K, emaArr(K.map((k) => k.c), 20), weekStart); };
const btcSma50 = () => { const K = candles("BTC", 1440); return htfGate(K, smaArr(K.map((k) => k.c), 50), dayStart); };

// ---- one run: production fleet backtest, one bot, one direction ----
const trades = [];
const orig = FleetLedgerSim.prototype.close;
FleetLedgerSim.prototype.close = function (...x) { const r = orig.apply(this, x); if (r?.trade) trades.push(r.trade); return r; };
function run(a, tf, side, variant, gate, period, feePct = 0.2) {
  trades.length = 0;
  const inputs = { ...profileInputs(process.cwd(), A[a].profile), ...variant, allowLong: side === "LONG", allowShort: side === "SHORT" };
  runFleetBacktest({ bots: [{ id: "R5", group: "R5", symbol: A[a].symbol, instrument: A[a].instrument, intervalMin: tf, priority: 1, profile: A[a].profile, candles: candles(a, tf), inputs, riskUSD: 2, gate: gate ? gate(tf) : undefined }],
    main: 100, allocations: [{ group: "R5", amountUsd: 100 }], feePct, fillModel: "strategy", fromMs: period[0], toMs: period[1], slippagePct: 0.05, fill: { entryDelayBars: 1, entryAgeKey: "limit" } });
  return trades.map((t) => ({ side: t.side, openTime: t.openTime, closeTime: t.closeTime, gross: t.gross / 1e6, fees: (t.entryFee + t.exitFee) / 1e6, net: t.net / 1e6, collateral: t.collateral / 1e6 }));
}
function metrics(T) {
  const nets = T.map((t) => t.net), sum = (x) => x.reduce((s, v) => s + v, 0), w = nets.filter((v) => v > 0), l = nets.filter((v) => v <= 0);
  let cum = 0, pk = 0, dd = 0; for (const v of nets) { cum += v; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); }
  const fees = sum(T.map((t) => t.fees)), borrow = sum(T.filter((t) => t.side === "SHORT").map((t) => t.collateral * 0.0002 * Math.ceil(Math.max(1, t.closeTime - t.openTime) / (4 * 3600_000))));
  return { trades: T.length, net: +sum(nets).toFixed(2), fees: +fees.toFixed(2), net_at_0_40: +(sum(nets) - fees).toFixed(2), short_borrow_estimate: +borrow.toFixed(2),
    pf: l.length && sum(l) < 0 ? +(sum(w) / -sum(l)).toFixed(2) : w.length ? 99 : null, win: nets.length ? +(w.length / nets.length).toFixed(2) : null, max_dd: +dd.toFixed(2), nets };
}
function bootstrap(nets) { if (nets.length < 5) return null; let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); const ms = [];
  for (let b = 0; b < 2000; b++) { let s = 0; for (let j = 0; j < nets.length; j++) s += nets[Math.floor(rnd() * nets.length)]; ms.push(s / nets.length); } ms.sort((x, y) => x - y); return [+ms[50].toFixed(3), +ms[1949].toFixed(3)]; }

// ---- hypotheses (frozen; see the pre-registration) ----
const X = -1.618;
const HYP = [
  { id: "F0", tf: 240, gate: null, variant: {}, sides: ["LONG", "SHORT"] },
  { id: "F1", tf: 240, gate: dailyEma50, variant: {}, sides: ["LONG", "SHORT"] },
  { id: "F2", tf: 240, gate: dailyEma50, variant: { tp2Ext: X }, sides: ["LONG", "SHORT"] },
  { id: "F2n-1.0", tf: 240, gate: dailyEma50, variant: { tp2Ext: -1.0 }, sides: ["LONG", "SHORT"] },
  { id: "F2n-2.0", tf: 240, gate: dailyEma50, variant: { tp2Ext: -2.0 }, sides: ["LONG", "SHORT"] },
  { id: "F3", tf: 1440, gate: weeklyEma20, variant: {}, sides: ["LONG", "SHORT"] },
  { id: "F3x", tf: 1440, gate: weeklyEma20, variant: { tp2Ext: X }, sides: ["LONG", "SHORT"] },
  { id: "F4", tf: 240, gate: () => btcSma50(), variant: { tp2Ext: X }, sides: ["LONG", "SHORT"] },
  { id: "F5", tf: 240, gate: dailyEma50, variant: { tp2Ext: X, minScore: 2 }, sides: ["LONG", "SHORT"] },
  { id: "F6", tf: 240, gate: dailyEma50, variant: { tp2Ext: X, slBuf: 1.0, minNetRR: 1.5, researchCostPct: 0.2 }, sides: ["LONG", "SHORT"] },
];
const only = arg("only", null)?.split(",");

const out = { label: "RESEARCH ROUND 5 (OTE on 4h / daily; Coinbase candles; production fleet backtest; strict acceptance; NOT PAPER results)", preregistration: "bac1a9d", periods: P, excluded: {}, results: [], benchmarks: [], verdicts: {} };
const markets = [...OLD, ...NEW];
const ok = {}; // ok[market][period]
for (const a of markets) { ok[a] = {}; for (const [pn, per] of Object.entries(P)) { const g = maxGapDays(a, per); ok[a][pn] = g <= 30; if (g > 30) (out.excluded[a] ??= {})[pn] = `max gap ${g} days`; } }
console.error("excluded:", JSON.stringify(out.excluded));

// benchmarks: cash, buy and hold, simple trend (own SMA50, Candidate B's rule), BTC MA-50
for (const a of markets) { R3DATA[a] ??= load(A[a].prod, 86400); R3MIN[a] ??= { qty: A[a].instrument?.minQty ?? R3MIN[a]?.qty, cost: 0.5 }; }
for (const a of markets) for (const [pn, per] of Object.entries(P)) {
  if (!ok[a][pn]) continue;
  const K = R3DATA[a], r = simAsset(a, K, H.H6.make(K, { trendGate: false, volGate: false }, R3DATA.BTC), { fee: 0.2, slip: 0.05, risk: 2, from: per[0], to: per[1] }), m = r3metrics(r);
  out.benchmarks.push({ asset: a, period: pn, trend_sma50: { net: m.net, trades: m.trades, max_dd_pct: m.max_dd_pct, ret_dd: m.ret_dd }, buy_hold: bh(a, per, { fee: 0.2, slip: 0.05 }), cash: { net: 0 } });
}

for (const h of HYP) {
  if (only && !only.includes(h.id)) continue;
  for (const side of h.sides) {
    for (const a of markets) {
      const res = { hyp: h.id, tf: h.tf, variant: h.variant, asset: a, side, cohort: NEW.includes(a) ? "new" : "examined", periods: {} };
      for (const [pn, per] of Object.entries(P)) { if (!ok[a][pn]) { res.periods[pn] = null; continue; } const g = h.gate ? h.gate(a) : null; res.periods[pn] = metrics(run(a, h.tf, side, h.variant, g, per)); }
      out.results.push(res);
      const d = res.periods.development, v = res.periods.validation;
      console.error(`${h.id} ${a} ${side}: dev ${d?.net ?? "-"} (${d?.trades ?? "-"}) | val ${v?.net ?? "-"} (${v?.trades ?? "-"}, pf ${v?.pf ?? "-"}) @0.4 ${v?.net_at_0_40 ?? "-"}`);
    }
  }
}

// ---- verdicts on the NEW markets per the pre-registered criteria ----
const sum = (xs) => xs.reduce((s, v) => s + v, 0);
const pooled = (hyp, side, pn) => { const rs = out.results.filter((r) => r.hyp === hyp && r.side === side && r.cohort === "new" && r.periods[pn]); return { n: rs.length, net: +sum(rs.map((r) => r.periods[pn].net)).toFixed(2), at040: +sum(rs.map((r) => r.periods[pn].net_at_0_40)).toFixed(2),
  dd: +sum(rs.map((r) => r.periods[pn].max_dd)).toFixed(2), trades: sum(rs.map((r) => r.periods[pn].trades)), positive: rs.filter((r) => r.periods[pn].net > 0).length, nets: rs.flatMap((r) => r.periods[pn].nets) }; };
const benchVal = (() => { const bs = out.benchmarks.filter((b) => NEW.includes(b.asset) && b.period === "validation"); return { net: +sum(bs.map((b) => b.trend_sma50.net)).toFixed(2), dd: +sum(bs.map((b) => b.trend_sma50.max_dd_pct)).toFixed(2) }; })();
out.trend_benchmark_new_validation = { ...benchVal, ret_dd: benchVal.dd > 0 ? +(benchVal.net / benchVal.dd).toFixed(2) : null };
for (const h of HYP) for (const side of h.sides) {
  if (!out.results.some((r) => r.hyp === h.id && r.side === side)) continue;
  const dv = pooled(h.id, side, "development"), vl = pooled(h.id, side, "validation"), ci = bootstrap(vl.nets), retdd = vl.dd > 0 ? vl.net / vl.dd : vl.net > 0 ? Infinity : 0;
  const c = { c1_dev_and_val_positive: dv.net > 0 && vl.net > 0, c2_markets_positive: vl.positive >= Math.min(5, vl.n) && vl.n > 0, c3_30_trades: vl.trades >= 30, c4_ci_above_0: !!ci && ci[0] > 0, c5_positive_at_040: vl.at040 > 0,
    c7_beats_trend_and_cash: vl.net > 0 && retdd > (out.trend_benchmark_new_validation.ret_dd ?? 0) };
  if (h.id === "F2") c.c6_neighbours = ["F2n-1.0", "F2n-2.0"].every((n) => pooled(n, side, "validation").net > 0);
  out.verdicts[`${h.id} ${side}`] = { development: { ...dv, nets: undefined }, validation: { ...vl, nets: undefined, ci, ret_dd: Number.isFinite(retdd) ? +retdd.toFixed(2) : retdd }, criteria: c, pass: Object.values(c).every(Boolean) };
}
for (const r of out.results) for (const p of Object.values(r.periods)) if (p) delete p.nets;
writeFileSync(arg("out", "r5.json"), JSON.stringify(out, null, 1));
console.error(JSON.stringify(Object.fromEntries(Object.entries(out.verdicts).map(([k, v]) => [k, { dev: v.development.net, val: v.validation.net, trades: v.validation.trades, pos: `${v.validation.positive}/${v.validation.n}`, pass: v.pass }]))));

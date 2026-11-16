#!/usr/bin/env node
// RESEARCH ROUND 4: hybrid OTE (docs/research/round4/PREREGISTRATION.md). The OTE / Fibonacci / PD-Array strategy is the
// unchanged production code (ote.mjs) run through the production fleet backtest with strict acceptance timing; moving
// averages and volatility act ONLY as market filters (a research gate on the strategy state).
//   ALPHA_RESEARCH_DATA=<engine/data/research2> node src/research/r4.mjs --only C0 --out r4-C0.json
import { readFileSync, writeFileSync } from "node:fs";
import { aggregate, profileInputs, runFleetBacktest } from "../cli/fleet-backtest.mjs";
import { FleetLedgerSim } from "../capital.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = process.env.ALPHA_RESEARCH_DATA;
const MIN = 60_000, DAY = 86_400_000, D = Date.parse;
const P = { development: [D("2021-07-01"), D("2024-07-01")], validation: [D("2024-07-01"), D("2026-11-15")], all: [D("2021-07-01"), D("2026-11-15")] };
const ASSETS = { BTC: { prod: "BTC-USD", symbol: "BTCUSD", group: "BITCOIN", profile: "btcusd-5m" }, SOL: { prod: "SOL-USD", symbol: "SOLUSD", group: "SOLANA", profile: "solusd-5m" }, ETH: { prod: "ETH-USD", symbol: "ETHUSD", group: "ETHEREUM", profile: "btcusd-5m" } };
const cache = new Map();
const load = (prod, g) => { const k = `${prod}-${g}`; if (!cache.has(k)) cache.set(k, JSON.parse(readFileSync(`${DIR}/${k}.json`, "utf8")).candles.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }))); return cache.get(k); };
const candles = (asset, tfMin) => {
  const p = ASSETS[asset].prod;
  if (tfMin === 5) return load(p, 300); if (tfMin === 15) return load(p, 900); if (tfMin === 60) return load(p, 3600);
  if (tfMin === 240) { const k = `${p}-240`; if (!cache.has(k)) cache.set(k, aggregate(load(p, 3600), 240)); return cache.get(k); }
  if (tfMin === 1440) return load(p, 86400);
  throw new Error(`no data for ${tfMin}m`);
};

// ---- filters (completed data only) ----
function emaArr(xs, n) { const a = 2 / (n + 1); let e = null; return xs.map((v, i) => (e = e === null ? v : e + a * (v - e), i + 1 < n ? null : e)); }
const smaArr = (xs, n) => { let s = 0; return xs.map((v, i) => { s += v; if (i >= n) s -= xs[i - n]; return i + 1 < n ? null : s / n; }); };
function regimeGate() { // R: BTC daily close vs SMA200 and 30-day realised volatility vs its 1-year median
  const K = load("BTC-USD", 86400), S = smaArr(K.map((k) => k.c), 200);
  const rv = K.map((_, i) => { if (i < 30) return null; let m = 0; const r = []; for (let j = i - 29; j <= i; j++) r.push(Math.log(K[j].c / K[j - 1].c)); m = r.reduce((s, v) => s + v, 0) / 30; return Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / 29); });
  const med = rv.map((_, i) => { const xs = rv.slice(Math.max(0, i - 364), i + 1).filter((v) => v !== null).sort((a, b) => a - b); return xs.length ? xs[xs.length >> 1] : null; });
  const idx = new Map(K.map((k, i) => [k.t, i]));
  return (tfMin) => (t, dir) => {
    const close = t + tfMin * MIN, i = idx.get(Math.floor(close / DAY) * DAY - DAY); // last daily candle completed by this bar's close
    if (i === undefined || S[i] === null || rv[i] === null || med[i] === null || !(rv[i] < med[i])) return false;
    return dir === 1 ? K[i].c > S[i] : K[i].c < S[i];
  };
}
function trendGate(asset, htfMin) { // T: higher-timeframe close vs its EMA50 (last HTF candle completed by the bar's close)
  const K = candles(asset, htfMin), E = emaArr(K.map((k) => k.c), 50), idx = new Map(K.map((k, i) => [k.t, i])), step = htfMin * MIN;
  return (tfMin) => (t, dir) => { const close = t + tfMin * MIN, i = idx.get(Math.floor(close / step) * step - step); if (i === undefined || E[i] === null) return false; return dir === 1 ? K[i].c > E[i] : K[i].c < E[i]; };
}

// ---- one run: the production fleet backtest, one bot, one direction ----
const trades = [];
const orig = FleetLedgerSim.prototype.close;
FleetLedgerSim.prototype.close = function (...a) { const r = orig.apply(this, a); if (r?.trade) trades.push(r.trade); return r; };
function run(asset, tfMin, side, variant = {}, gate = null, period = P.all, feePct = 0.2) {
  const A = ASSETS[asset], K = candles(asset, tfMin);
  trades.length = 0;
  const inputs = { ...profileInputs(process.cwd(), A.profile), ...variant, allowLong: side === "LONG", allowShort: side === "SHORT" };
  runFleetBacktest({ bots: [{ id: "R4", group: A.group, symbol: A.symbol, intervalMin: tfMin, priority: 1, profile: A.profile, candles: K, inputs, riskUSD: 2, gate: gate ? gate(tfMin) : undefined }],
    main: 100, allocations: [{ group: A.group, amountUsd: 100 }], feePct, fillModel: "strategy", fromMs: period[0], toMs: period[1], slippagePct: 0.05,
    // Strict acceptance: fillable only from the bar after acceptance; an order is identified by side + limit (a size-only
    // change keeps it and its acceptance, as the ledger fills at most the size it accepted).
    fill: { entryDelayBars: 1, entryAgeKey: "limit" } });
  return trades.map((t) => ({ side: t.side, openTime: t.openTime, closeTime: t.closeTime, gross: t.gross / 1e6, fees: (t.entryFee + t.exitFee) / 1e6, net: t.net / 1e6, collateral: t.collateral / 1e6 }));
}
function metrics(T) {
  const nets = T.map((t) => t.net), sum = (x) => x.reduce((a, b) => a + b, 0), w = nets.filter((v) => v > 0), l = nets.filter((v) => v <= 0);
  let cum = 0, pk = 0, dd = 0; for (const v of nets) { cum += v; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); }
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let ci = null; if (nets.length >= 5) { const ms = []; for (let b = 0; b < 1000; b++) { let s = 0; for (let j = 0; j < nets.length; j++) s += nets[Math.floor(rnd() * nets.length)]; ms.push(s / nets.length); } ms.sort((a, b) => a - b); ci = [+ms[25].toFixed(3), +ms[974].toFixed(3)]; }
  const fees = sum(T.map((t) => t.fees)), borrow = sum(T.filter((t) => t.side === "SHORT").map((t) => t.collateral * 0.0002 * Math.ceil(Math.max(1, (t.closeTime - t.openTime)) / (4 * 3600_000))));
  return { trades: T.length, gross: +sum(T.map((t) => t.gross)).toFixed(2), fees: +fees.toFixed(2), net: +sum(nets).toFixed(2), net_at_0_40: +(sum(nets) - fees).toFixed(2),
    short_borrow_estimate: +borrow.toFixed(2), pf: l.length && sum(l) < 0 ? +(sum(w) / -sum(l)).toFixed(2) : w.length ? 99 : null, win: nets.length ? +(w.length / nets.length).toFixed(2) : null,
    avg: nets.length ? +(sum(nets) / nets.length).toFixed(3) : null, ci, max_dd: +dd.toFixed(2),
    hold_h: T.length ? +(sum(T.map((t) => (t.closeTime - t.openTime) / 3_600_000)) / T.length).toFixed(1) : null };
}
// Each period is its own run with a fresh $100 wallet (earlier history is still used as warm-up), so losses in one period
// can never starve the next of capital.
const byPeriod = (runPeriod) => Object.fromEntries(Object.entries(P).map(([k, per]) => [k, metrics(runPeriod(per))]));

// ---- candidates ----
const R = regimeGate();
const CANDIDATES = {
  C0: [5, 15, 60, 240].map((tf) => ({ tf, variant: {}, gate: null, label: `original OTE ${tf}m` })),
  C1: [{ tf: 5, variant: {}, gate: R, label: "OTE 5m + H6 regime" }],
  C2: [{ tf: 5, variant: {}, gate: "T60", label: "OTE 5m + 1h trend" }],
  C3: [15, 60].map((tf) => ({ tf, variant: {}, gate: "T240", label: `OTE ${tf}m + 4h trend` })),
  C4: [{ tf: 240, variant: {}, gate: "T1440", label: "OTE 4h + daily trend" }],
};
// C5-C7 use the C3/C4 configuration with the best DEVELOPMENT net (BTC+SOL), per side, chosen in the script
const VARIATIONS = {
  C5: [-0.618, -1.0, -1.618].map((tp2Ext) => ({ tp2Ext })),
  C6: [0.5, 1.0].flatMap((slBuf) => [1.0, 1.5].map((minNetRR) => ({ slBuf, minNetRR, researchCostPct: 0.2 }))),
  C7: [2, 3].map((minScore) => ({ minScore })),
};
const gateFor = (g, asset) => (g === null ? null : typeof g === "function" ? g : trendGate(asset, Number(g.slice(1))));

const only = (arg("only", "C0,C1,C2,C3,C4,C5,C6,C7")).split(",");
const out = { label: "RESEARCH ROUND 4 (hybrid OTE; Coinbase candles; production fleet backtest; strict acceptance; NOT PAPER results)", periods: P, results: [] };
const doRun = (cand, c, asset, side) => { const t0 = Date.now(); const g = gateFor(c.gate, asset); const res = { candidate: cand, label: c.label, tf: c.tf, variant: c.variant, asset, side, periods: byPeriod((per) => run(asset, c.tf, side, c.variant, g, per)), seconds: Math.round((Date.now() - t0) / 1000) };
  out.results.push(res); const d = res.periods.development, v = res.periods.validation, a = res.periods.all;
  console.error(`${cand} ${c.label} ${JSON.stringify(c.variant)} ${asset} ${side}: dev ${d.net} (${d.trades}) | val ${v.net} (${v.trades}, pf ${v.pf}) | all@0.4 ${a.net_at_0_40} | ${res.seconds}s`); return res; };
for (const cand of ["C0", "C1", "C2", "C3", "C4"]) if (only.includes(cand)) for (const c of CANDIDATES[cand]) for (const asset of Object.keys(ASSETS)) for (const side of ["LONG", "SHORT"]) doRun(cand, c, asset, side);
if (["C5", "C6", "C7"].some((x) => only.includes(x))) {
  // base per side: the C3/C4 configuration with the best development net over BTC + SOL (requires C3 and C4 results in this run or a --base file)
  const prior = arg("base", null) ? JSON.parse(readFileSync(arg("base"), "utf8")).results : out.results;
  for (const side of ["LONG", "SHORT"]) {
    const opts = [...CANDIDATES.C3, ...CANDIDATES.C4].map((c) => ({ c, dev: ["BTC", "SOL"].reduce((s, a) => s + (prior.find((r) => r.label === c.label && r.asset === a && r.side === side)?.periods.development.net ?? -Infinity), 0) }));
    const base = opts.sort((x, y) => y.dev - x.dev)[0].c;
    out[`base_${side}`] = base.label;
    for (const cand of ["C5", "C6", "C7"]) if (only.includes(cand)) for (const v of VARIATIONS[cand]) for (const asset of Object.keys(ASSETS)) doRun(cand, { ...base, variant: v, label: `${base.label} ${cand}` }, asset, side);
  }
}
writeFileSync(arg("out", "r4.json"), JSON.stringify(out, null, 1));

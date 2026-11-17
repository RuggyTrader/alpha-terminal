#!/usr/bin/env node
// RESEARCH ROUND 6 (docs/research/round6/PREREGISTRATION.md, committed before any run): fee-aware OTE variants on the
// live 5m profiles, sized like the live bots ($20 wallet, $10 risk target capped by the wallet), strict acceptance.
//   ALPHA_RESEARCH_DATA=<engine/data/research2> node src/research/r6.mjs --out r6.json
import { readFileSync, writeFileSync } from "node:fs";
import { profileInputs, runFleetBacktest } from "../cli/fleet-backtest.mjs";
import { FleetLedgerSim } from "../capital.mjs";
import { getInstrument } from "../instruments.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = process.env.ALPHA_RESEARCH_DATA, D = Date.parse;
const P = { development: [D("2021-07-01"), D("2024-07-01")], validation: [D("2024-07-01"), D("2026-11-15")] };
// Kraken public AssetPairs (fetched 2026-11-16T03:20Z): ordermin, tick
const KRAKEN = { LTC: [0.08, 0.01], LINK: [0.35, 0.00001], ADA: [20, 0.000001], DOGE: [50, 0.0000001] };
const A = { BTC: { prod: "BTC-USD", symbol: "BTCUSD", profile: "btcusd-5m" }, SOL: { prod: "SOL-USD", symbol: "SOLUSD", profile: "solusd-5m" }, ETH: { prod: "ETH-USD", symbol: "ETHUSD", profile: "btcusd-5m" } };
for (const [a, [min, tick]] of Object.entries(KRAKEN)) A[a] = { prod: `${a}-USD`, symbol: `${a}USD`, profile: "btcusd-5m",
  instrument: { ...getInstrument("ETHUSD"), symbol: `${a}USD`, providerSymbol: `${a}USD`, providerPair: `${a}/USD`, tick, minQty: min, minNotional: 0.5,
    verified: { source: `Kraken public AssetPairs ${a}/USD (research only)`, at: "2026-11-16T03:20:38Z" }, fundedEligible: false },
  symProps: { mintick: tick, pointValue: 1, usdRate: 1, type: "crypto" } };
const EXAMINED = ["BTC", "SOL", "ETH"], INDEPENDENT = ["LTC", "LINK", "ADA", "DOGE"];

const cache = new Map();
const candles = (a) => { if (!cache.has(a)) cache.set(a, JSON.parse(readFileSync(`${DIR}/${A[a].prod}-300.json`, "utf8")).candles.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }))); return cache.get(a); };

const trades = [];
const orig = FleetLedgerSim.prototype.close;
FleetLedgerSim.prototype.close = function (...x) { const r = orig.apply(this, x); if (r?.trade) trades.push(r.trade); return r; };
function run(a, variant, period, { feePct = 0.2, slip = 0.05 } = {}) {
  trades.length = 0;
  const inputs = { ...profileInputs(process.cwd(), A[a].profile), ...variant };
  runFleetBacktest({ bots: [{ id: "R6", group: "R6", symbol: A[a].symbol, instrument: A[a].instrument, symProps: A[a].symProps, intervalMin: 5, priority: 1, profile: A[a].profile, candles: candles(a), inputs, riskUSD: 10 }],
    main: 20, allocations: [{ group: "R6", amountUsd: 20 }], feePct, fillModel: "strategy", fromMs: period[0], toMs: period[1], slippagePct: slip, fill: { entryDelayBars: 1, entryAgeKey: "limit" } });
  return trades.map((t) => ({ side: t.side, gross: t.gross / 1e6, fees: (t.entryFee + t.exitFee) / 1e6, net: t.net / 1e6 }));
}
const sum = (x) => x.reduce((a, b) => a + b, 0);
function m(T) {
  const n = T.map((t) => t.net), w = n.filter((v) => v > 0), l = n.filter((v) => v <= 0);
  return { trades: T.length, gross: +sum(T.map((t) => t.gross)).toFixed(3), fees: +sum(T.map((t) => t.fees)).toFixed(3), net: +sum(n).toFixed(3),
    net_at_0_40: +(sum(n) - sum(T.map((t) => t.fees))).toFixed(3), pf: l.length && sum(l) < 0 ? +(sum(w) / -sum(l)).toFixed(2) : null, win: T.length ? +(w.length / T.length).toFixed(2) : null,
    long: +sum(T.filter((t) => t.side === "LONG").map((t) => t.net)).toFixed(3), short: +sum(T.filter((t) => t.side === "SHORT").map((t) => t.net)).toFixed(3), nets: n };
}
function ci(nets) { if (nets.length < 5) return null; let s = 13; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); const ms = [];
  for (let b = 0; b < 2000; b++) { let t = 0; for (let j = 0; j < nets.length; j++) t += nets[Math.floor(rnd() * nets.length)]; ms.push(t / nets.length); } ms.sort((x, y) => x - y); return [+ms[50].toFixed(4), +ms[1949].toFixed(4)]; }

const V = {
  V0: {}, V1a: { minNetRR: 1.0, researchCostPct: 0.2 }, V1b: { minNetRR: 2.0, researchCostPct: 0.2 }, V2: { beFeeOffsetPct: 0.45 },
  V3: { tp2Ext: -1.0 }, V4: { minStopPct: 0.8 }, V5: { minScore: 2 },
  V6: { minNetRR: 1.0, researchCostPct: 0.2, beFeeOffsetPct: 0.45, tp2Ext: -1.0, minStopPct: 0.8 },
};
const only = arg("only", null)?.split(",");
const out = { label: "RESEARCH ROUND 6 (fee-aware OTE, live 5m profiles, $20 wallet / $10 risk capped, strict acceptance; NOT PAPER results)", preregistration: "f9506dc", results: {}, verdicts: {} };
for (const [id, variant] of Object.entries(V)) {
  if (only && !only.includes(id)) continue;
  const r = { variant, development: {}, validation: {}, independent: {}, independent_slip015: {} };
  for (const a of EXAMINED) { r.development[a] = m(run(a, variant, P.development)); r.validation[a] = m(run(a, variant, P.validation)); }
  for (const a of INDEPENDENT) { r.independent[a] = m(run(a, variant, P.validation)); r.independent_slip015[a] = m(run(a, variant, P.validation, { slip: 0.15 })); }
  const pool = (o) => { const xs = Object.values(o); return { trades: sum(xs.map((x) => x.trades)), net: +sum(xs.map((x) => x.net)).toFixed(3), fees: +sum(xs.map((x) => x.fees)).toFixed(3), gross: +sum(xs.map((x) => x.gross)).toFixed(3),
    net_at_0_40: +sum(xs.map((x) => x.net_at_0_40)).toFixed(3), positive: xs.filter((x) => x.net > 0).length, nets: xs.flatMap((x) => x.nets) }; };
  const dv = pool(r.development), vl = pool(r.validation), ind = pool(r.independent), sl = pool(r.independent_slip015), c = ci(ind.nets);
  const crit = { c1_all_three_positive: dv.net > 0 && vl.net > 0 && ind.net > 0, c2_30_independent_trades: ind.trades >= 30, c3_ci_above_0: !!c && c[0] > 0, c4_positive_at_slip_015: sl.net > 0, c5_3_of_4_markets: ind.positive >= 3 };
  out.verdicts[id] = { development: { ...dv, nets: undefined }, validation: { ...vl, nets: undefined }, independent: { ...ind, nets: undefined, ci: c }, independent_slip015: { ...sl, nets: undefined },
    criteria: crit, pass: Object.values(crit).every(Boolean) };
  for (const k of ["development", "validation", "independent", "independent_slip015"]) for (const a of Object.keys(r[k])) delete r[k][a].nets;
  out.results[id] = r;
  console.error(`${id}: dev ${dv.net} (${dv.trades}) | val ${vl.net} (${vl.trades}) | indep ${ind.net} (${ind.trades}, ${ind.positive}/4 +, CI ${JSON.stringify(c)}) | slip.15 ${sl.net} | pass ${out.verdicts[id].pass}`);
  writeFileSync(arg("out", "r6.json"), JSON.stringify(out, null, 1));
}

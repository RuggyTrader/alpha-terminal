// Phase 3 realism checks (research only): Kraken vs Coinbase prices; the strategies on Kraken's own candles; stop fills
// re-priced with hourly candles; stop-slippage sensitivity.
//   node src/research/phase3/checks.mjs --data <engine/data> --kraken <dir with XBTUSD-1d.json ...> --out <json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COSTS, MIN_QTY, backtest } from "../dd2/bt.mjs";
import { CANDIDATES } from "./candidates.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DATA = arg("--data"), KR = arg("--kraken"), OUT = arg("--out");
const load = (a) => { const m = new Map(); for (const f of [`strategy-select/${a}-USD-86400-pre2021.json`, `research2/${a}-USD-86400.json`]) { try { for (const k of JSON.parse(readFileSync(join(DATA, f))).candles) m.set(k.t, k); } catch { /* absent */ } } return [...m.values()].sort((x, y) => x.t - y.t); };
const K = { BTC: load("BTC"), ETH: load("ETH"), SOL: load("SOL") };
const H = Object.fromEntries(["BTC", "ETH", "SOL"].map((a) => [a, JSON.parse(readFileSync(join(DATA, "research2", `${a}-USD-3600.json`))).candles]));
const kr = (p) => { const j = JSON.parse(readFileSync(join(KR, `${p}-1d.json`))); const rows = Object.entries(j.result).find(([k]) => k !== "last")[1]; return rows.map((x) => ({ t: x[0] * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4] })).slice(0, -1); };
const KK = { BTC: kr("XBTUSD"), ETH: kr("ETHUSD"), SOL: kr("SOLUSD") };
const out = { prices: {}, kraken_vs_coinbase: {}, hourly_stops: {}, stop_slippage: {} };
const r2 = (v) => Math.round(v * 100) / 100;

for (const a of ["BTC", "ETH", "SOL"]) {
  const cb = new Map(K[a].map((k) => [k.t, k])), d = [];
  for (const k of KK[a]) { const c = cb.get(k.t); if (c) d.push(Math.abs(k.c / c.c - 1) * 100); }
  d.sort((x, y) => x - y);
  out.prices[a] = { common_days: d.length, from: new Date(KK[a][0].t).toISOString().slice(0, 10), median_close_diff_pct: +d[d.length >> 1].toFixed(4), max_close_diff_pct: +d.at(-1).toFixed(4) };
}
const w0 = KK.BTC[0].t + 120 * 864e5, w1 = KK.BTC.at(-1).t + 864e5;
for (const [n, c] of Object.entries(CANDIDATES)) {
  const run = (src) => backtest(c.uni.map((a) => ({ name: a, K: src[a], minQty: MIN_QTY[a] })), c.spec, { from: w0, to: w1, ...COSTS.base });
  const a = run(K), b = run(KK);
  out.kraken_vs_coinbase[n] = { window: [new Date(w0).toISOString().slice(0, 10), new Date(w1 - 864e5).toISOString().slice(0, 10)], coinbase: { final: r2(a.final), dd_pct: r2(a.dd_pct), trades: a.trades }, kraken: { final: r2(b.final), dd_pct: r2(b.dd_pct), trades: b.trades } };
  const audit = [];
  backtest(c.uni.map((x) => ({ name: x, K: K[x], minQty: MIN_QTY[x] })), c.spec, { from: Date.parse("2021-07-01"), to: Date.parse("2026-11-15"), ...COSTS.base, audit });
  let n0 = 0, worse = 0, better = 0, usd = 0;
  for (const f of audit.filter((x) => x.kind === "STOP")) {
    const h = H[f.asset].filter((x) => x.t >= f.t && x.t < f.t + 864e5).find((x) => x.l <= f.ref.stop);
    if (!h) continue;
    const pxH = Math.min(h.o, f.ref.stop) * (1 - COSTS.base.stopSlip); n0++;
    if (pxH < f.px - 1e-9) worse++; else if (pxH > f.px + 1e-9) better++;
    usd += (pxH - f.px) * f.qty * (1 - COSTS.base.fee);
  }
  out.hourly_stops[n] = { stops_repriced: n0, worse_than_daily_model: worse, better: better, pnl_effect_usd: +usd.toFixed(4) };
  out.stop_slippage[n] = Object.fromEntries([0.001, 0.0025, 0.005, 0.01].map((ss) => { const r = backtest(c.uni.map((x) => ({ name: x, K: K[x], minQty: MIN_QTY[x] })), c.spec, { from: Date.parse("2016-01-01"), to: Date.parse("2026-11-15"), ...COSTS.base, stopSlip: ss }); return [`${(ss * 100).toFixed(2)}%`, { final: r2(r.final), dd_pct: r2(r.dd_pct) }]; }));
}
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1));

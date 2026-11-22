// Phase 3 out-of-sample check on DIFFERENT MARKETS: the four frozen candidates applied, unchanged, to every other coin in
// the free Coinbase data set. None of these coins was ever used to choose a setting. Research only.
//   node src/research/phase3/generalize.mjs --data <engine/data> --pairs <Kraken AssetPairs json> --out <json>
// Single-asset rule A runs on each coin alone. The 3-asset rules B, C, D run on fixed alphabetical triplets of the
// other coins (no choice involved). Minimum order: Kraken's current minimum quantity x its current price, applied as a
// USD minimum at every date (Kraken re-sets minimums to roughly $5 over time), and $0.50.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { COSTS, backtest } from "../dd2/bt.mjs";
import { CANDIDATES } from "./candidates.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DATA = arg("--data"), PAIRS = arg("--pairs"), OUT = arg("--out");
const pairs = Object.values(JSON.parse(readFileSync(PAIRS, "utf8")).result).filter((v) => v.quote === "ZUSD" || v.quote === "USD");
const ordermin = Object.fromEntries(pairs.map((v) => [(v.wsname ?? v.altname).split("/")[0].replace(/^XBT$/, "BTC").replace(/^XDG$/, "DOGE"), Number(v.ordermin)]));
const coins = readdirSync(join(DATA, "research2")).filter((f) => f.endsWith("-USD-86400.json")).map((f) => f.split("-")[0]).filter((c) => !["BTC", "ETH", "SOL"].includes(c)).sort();
function load(a) { const m = new Map(); for (const f of [`strategy-select/${a}-USD-86400-pre2021.json`, `research2/${a}-USD-86400.json`]) { try { for (const k of JSON.parse(readFileSync(join(DATA, f))).candles) m.set(k.t, k); } catch { /* absent */ } } return [...m.values()].sort((x, y) => x.t - y.t); }
const assets = {};
for (const c of coins) { const K = load(c); if (K.length < 400 || !ordermin[c]) continue; assets[c] = { name: c, K, minQty: 0, minUsd: ordermin[c] * K.at(-1).c }; }
const names = Object.keys(assets);
const END = Date.parse("2026-11-15");
const start = (list) => Math.max(...list.map((a) => assets[a].K[0].t)) + 120 * 864e5; // indicators warm up first
const r2 = (v) => Math.round(v * 100) / 100;
// results are reported per $100 of starting capital for both account sizes
const res = { coins: names.length, minimum_usd: Object.fromEntries(names.map((c) => [c, r2(assets[c].minUsd)])), rules: {}, rules_at_10000_usd: {} };
for (const CAP of [100, 10000]) for (const [rule, c] of Object.entries(CANDIDATES)) {
  const groups = c.uni.length === 1 ? names.map((n) => [n]) : Array.from({ length: Math.floor(names.length / 3) }, (_, g) => names.slice(g * 3, g * 3 + 3));
  const rows = groups.map((g) => {
    const from = start(g), r = backtest(g.map((n) => assets[n]), c.spec, { from, to: END, capital: CAP, ...COSTS.base });
    const bh = g.reduce((s, n) => { const K = assets[n].K.filter((k) => k.t >= from && k.t < END); return s + (CAP / g.length) * (K.at(-1).c / K[0].o) * (1 - 0.0045) ** 2; }, 0);
    return { coins: g.join("+"), from: new Date(from).toISOString().slice(0, 10), years: r2((END - from) / 864e5 / 365), final: r2(r.final * 100 / CAP), cagr_pct: r2(r.cagr_pct), dd_pct: r2(r.dd_pct), trades: r.trades, skipped: r.skipped, fees: r2(r.fees), buy_hold_final: r2(bh * 100 / CAP) };
  });
  const n = rows.length, pos = rows.filter((x) => x.final > 100).length, dd2 = rows.filter((x) => x.dd_pct < 2).length, both = rows.filter((x) => x.final > 100 && x.dd_pct < 2).length;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  (CAP === 100 ? res.rules : res.rules_at_10000_usd)[rule] = { markets: n, profitable: pos, dd_below_2pct: dd2, profitable_and_dd_below_2pct: both, median_cagr_pct: med(rows.map((x) => x.cagr_pct)), median_dd_pct: med(rows.map((x) => x.dd_pct)), median_trades: med(rows.map((x) => x.trades)), rows };
}
writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
for (const [cap, set] of [["$100", res.rules], ["$10,000 (per $100)", res.rules_at_10000_usd]]) for (const [k, v] of Object.entries(set)) console.log(`${cap} ` + `${k}: ${v.markets} markets | profitable ${v.profitable} | DD<2% ${v.dd_below_2pct} | both ${v.profitable_and_dd_below_2pct} | median ${v.median_cagr_pct}%/yr, DD ${v.median_dd_pct}%, ${v.median_trades} trades`);

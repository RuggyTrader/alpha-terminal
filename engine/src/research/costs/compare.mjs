// Execution-cost comparison (research only). Frozen strategies (S3 and the DD2/Phase 3 candidates; NO parameter changes)
// re-run with each venue's VERIFIED fee schedule and three execution methods, on real hourly prices for fills:
//   MARKET    taker fee; fill at the daily open +/- the venue's measured $50 market-order cost (half-spread + impact)
//   MAKER     post-only limit at the best bid (buy) / best ask (sell) at the open; fills only if a later hourly candle
//             trades THROUGH the limit by eps within 24 h; otherwise the order is MISSED (the strategy re-decides at the
//             next close). Maker fee.
//   HYBRID    the same limit for 4 h; if unfilled, a market order at the next hourly open (taker fee + market cost).
// Stops are always market (taker fee + max(market cost, 0.10 %)). Hourly data: Coinbase public, 2021-06 onward.
//   node src/research/costs/compare.mjs --data <engine/data> --spreads <spreads-live.json> --out <json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_QTY, backtest } from "../dd2/bt.mjs";
import { CANDIDATES } from "../phase3/candidates.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DATA = arg("--data"), SPREADS = JSON.parse(readFileSync(arg("--spreads"), "utf8")).summary, OUT = arg("--out");
const EPS = Number(arg("--eps") ?? 0.0005);
const load = (a) => { const m = new Map(); for (const f of [`strategy-select/${a}-USD-86400-pre2021.json`, `research2/${a}-USD-86400.json`]) { try { for (const k of JSON.parse(readFileSync(join(DATA, f))).candles) m.set(k.t, k); } catch { /* absent */ } } return [...m.values()].sort((x, y) => x.t - y.t); };
const K = { BTC: load("BTC"), ETH: load("ETH"), SOL: load("SOL") };
const H = Object.fromEntries(["BTC", "ETH", "SOL"].map((a) => { const c = JSON.parse(readFileSync(join(DATA, "research2", `${a}-USD-3600.json`))).candles; return [a, { c, at: new Map(c.map((h, i) => [h.t, i])) }]; }));
const FROM = Date.parse("2021-07-01"), TO = Date.parse("2026-11-15"), HOUR = 3_600_000;

// VERIFIED fee schedules (official pages, read 2026-11-22); spread costs MEASURED live (public order books)
const sp = (v, a) => SPREADS[`${v.book} ${a}/${v.quote}`];
const VENUES = {
  "Kraken Pro, CAD pairs": { maker: 0.004, taker: 0.008, book: "Kraken", quote: "CAD", verified: "kraken.com/ca/pro/fees" },
  "Kraken Pro, USD pairs (after a one-time CAD->USD conversion)": { maker: 0.004, taker: 0.008, book: "Kraken", quote: "USD", verified: "kraken.com/ca/pro/fees" },
  "Ndax, CAD pairs (flat)": { maker: 0.002, taker: 0.002, book: "Ndax", quote: "CAD", verified: "ndax.io/en/fees" },
  "Crypto.com Exchange, USD (Level 1, no CRO)": { maker: 0.0025, taker: 0.005, book: "Crypto.com", quote: "USD", verified: "crypto.com/exchange/document/fees-limits (Canadian access to the Exchange not verified)" },
};
const STRATS = { "S3 (frozen)": { uni: ["BTC", "ETH"], spec: { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 } }, ...CANDIDATES };

function makeExec(v, method) {
  const cost = (a, side) => { const s = sp(v, a); return ((side === "BUY" ? s.buy50_bps_median : s.sell50_bps_median) ?? s.spread_bps_median) / 1e4; };
  const half = (a) => sp(v, a).spread_bps_median / 2 / 1e4;
  return (asset, t, side, _o, bar) => {
    const mkt = (px) => ({ px: px * (side === "BUY" ? 1 + cost(asset, side) : 1 - cost(asset, side)), fee: v.taker });
    if (method === "MARKET") return mkt(bar.o);
    const lim = side === "BUY" ? bar.o * (1 - half(asset)) : bar.o * (1 + half(asset));
    const W = method === "MAKER" ? 24 : 4, h = H[asset], i0 = h.at.get(t);
    if (i0 === undefined) return method === "MAKER" ? null : mkt(bar.o);
    for (let i = i0; i < i0 + W && i < h.c.length; i++) {
      const c = h.c[i];
      if (side === "BUY" ? c.l <= lim * (1 - EPS) : c.h >= lim * (1 + EPS)) return { px: lim, fee: v.maker };
    }
    if (method === "MAKER") return null;
    const nxt = h.c[i0 + W]; return mkt(nxt ? nxt.o : bar.c);
  };
}
const r2 = (x) => Math.round(x * 100) / 100;
const rows = [];
for (const [sName, s] of Object.entries(STRATS)) {
  const assets = s.uni.map((a) => ({ name: a, K: K[a], minQty: 0 })); // venue minimums applied below per venue
  // reference: the old research cost model (0.40 % + 0.05 %) and S3's current shadow setting (0.20 % + 0.05 %)
  for (const [label, fee, slip] of [["reference: research model 0.40 % + 0.05 %", 0.004, 0.0005], ["reference: S3 shadow setting 0.20 % + 0.05 %", 0.002, 0.0005]]) {
    const r = backtest(s.uni.map((a) => ({ name: a, K: K[a], minQty: MIN_QTY[a] })), s.spec, { from: FROM, to: TO, fee, slip, stopSlip: 0.001 });
    rows.push({ strategy: sName, venue: label, method: "MARKET", final: r2(r.final), cagr_pct: r2(r.cagr_pct), dd_pct: r2(r.dd_pct), trades: r.trades, missed: 0, skipped_min: r.skipped, fees_usd: r2(r.fees), meets_2pct: r.dd_pct < 2 });
  }
  for (const [vName, v] of Object.entries(VENUES)) {
    const minQ = vName.startsWith("Ndax") ? { BTC: 0.00001, ETH: 0.0001, SOL: 0.01 } : MIN_QTY; // Ndax instrument minimums (public API); others Kraken-like
    for (const method of ["MARKET", "MAKER", "HYBRID"]) {
      const stopCost = Math.max(...s.uni.map((a) => (sp(v, a).sell50_bps_median ?? 10) / 1e4), 0.001);
      const r = backtest(s.uni.map((a) => ({ name: a, K: K[a], minQty: minQ[a] })), s.spec, { from: FROM, to: TO, fee: v.taker, slip: 0, stopSlip: stopCost, exec: makeExec(v, method) });
      rows.push({ strategy: sName, venue: vName, method, final: r2(r.final), cagr_pct: r2(r.cagr_pct), dd_pct: r2(r.dd_pct), trades: r.trades, missed: r.missed, skipped_min: r.skipped, fees_usd: r2(r.fees), meets_2pct: r.dd_pct < 2 });
    }
  }
}
writeFileSync(OUT, JSON.stringify({ window: ["2021-07-01", "2026-11-14"], eps_trade_through: EPS, venues: VENUES, spreads_used: SPREADS, rows }, null, 1) + "\n");
for (const s of Object.keys(STRATS)) { console.log(`\n== ${s}`); for (const x of rows.filter((y) => y.strategy === s)) console.log(`${(x.venue + " · " + x.method).padEnd(62)} $${x.final.toFixed(2).padStart(7)} ${String(x.cagr_pct).padStart(6)}%/yr DD ${String(x.dd_pct).padStart(5)}% trades ${String(x.trades).padStart(3)} missed ${String(x.missed).padStart(3)} skipped ${String(x.skipped_min).padStart(4)} fees $${x.fees_usd} ${x.meets_2pct ? "MEETS 2%" : ""}`); }

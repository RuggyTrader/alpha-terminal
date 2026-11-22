// S3 (frozen: 200-day SMA x 40 % vol target, BTC + ETH, equal halves) recalculated with the MEASURED per-side costs from
// the 7-day study (analyze.mjs output). Research only; S3's running shadow is not touched.
//   node s3-recalc.mjs <analysis.json> <engine/data dir> <out.json>
// Assumptions (labelled): the measured mean cost per side (spread + impact + fee) applies to every historical fill;
// stops are not used by S3; the Kraken USD route pays a one-time CAD->USD->CAD conversion on the whole account.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backtest } from "./bt.mjs";

const [AN, DATA, OUT] = process.argv.slice(2);
const A = JSON.parse(readFileSync(AN, "utf8"));
const load = (a) => { const m = new Map(); for (const f of [`strategy-select/${a}-USD-86400-pre2021.json`, `research2/${a}-USD-86400.json`]) { try { for (const k of JSON.parse(readFileSync(join(DATA, f))).candles) m.set(k.t, k); } catch { /* absent */ } } return [...m.values()].sort((x, y) => x.t - y.t); };
const K = { BTC: load("BTC"), ETH: load("ETH") };
const S3 = { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 };
const MIN = { Kraken: { BTC: 0.00006, ETH: 0.002 }, Ndax: { BTC: 0.00001, ETH: 0.0001 } };
const side = (book, which) => { const m = A.market[book]; return (which === "BUY" ? m.buy_side_total.mean_pct : m.sell_side_total.mean_pct) / 100; };
const hyb = (book) => A.post_only[book]?.hybrid_4h_then_market_per_side?.mean_pct;
const ROUTES = {
  "Ndax CAD, market": { venue: "Ndax", fee: 0.002, cost: (a, s) => side(`Ndax ${a}/CAD`, s) },
  "Ndax CAD, hybrid (post-only 4 h, then market)": { venue: "Ndax", fee: 0.002, cost: (a) => (hyb(`Ndax ${a}/CAD`) ?? NaN) / 100 },
  "Kraken CAD, market (taker)": { venue: "Kraken", fee: 0.008, cost: (a, s) => side(`Kraken ${a}/CAD`, s) },
  "Kraken CAD, hybrid (post-only 4 h, then market)": { venue: "Kraken", fee: 0.004, cost: (a) => (hyb(`Kraken ${a}/CAD`) ?? NaN) / 100 },
  "Kraken USD, market (+ one-time conversion)": { venue: "Kraken", fee: 0.008, cost: (a, s) => side(`Kraken ${a}/USD`, s), conversion: (Object.values(A.conversion)[0]?.mean_pct ?? NaN) / 100 },
};
const r2 = (x) => Math.round(x * 100) / 100;
const res = { assumptions: "measured mean cost per side applied to every historical fill; constant over time; one-time FX conversion for the USD route; 2 % drawdown target compared on the strict (intraday-low) drawdown", windows: {} };
for (const [w0, w1] of [["2021-07-01", "2026-11-15"], ["2023-07-01", "2026-11-15"]]) {
  const rows = {};
  for (const [name, r] of Object.entries(ROUTES)) {
    if (["BTC", "ETH"].some((a) => !Number.isFinite(r.cost(a, "BUY")) || !Number.isFinite(r.cost(a, "SELL")))) { rows[name] = { unavailable: "not enough measured data" }; continue; }
    // the per-side total cost is applied as a price adjustment with zero separate fee (so it is counted exactly once)
    const exec = (asset, _t, s, _o, bar) => ({ px: bar.o * (s === "BUY" ? 1 + r.cost(asset, "BUY") : 1 - r.cost(asset, "SELL")), fee: 0 });
    const bt = backtest(["BTC", "ETH"].map((a) => ({ name: a, K: K[a], minQty: MIN[r.venue][a] })), S3, { from: Date.parse(w0), to: Date.parse(w1), fee: 0, slip: 0, stopSlip: 0, exec });
    const final = bt.final * (r.conversion ? 1 - r.conversion : 1);
    const yrs = bt.curve.length / 365;
    rows[name] = { final: r2(final), cagr_pct: r2(((final / 100) ** (1 / yrs) - 1) * 100), max_dd_pct: r2(bt.dd_pct), orders: bt.trades, skipped_below_min: bt.skipped,
      cost_per_side_pct: { BTC: r2(r.cost("BTC", "BUY") * 100), ETH: r2(r.cost("ETH", "BUY") * 100) }, meets_2pct: bt.dd_pct < 2 };
  }
  res.windows[`${w0}..${w1}`] = rows;
}
writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
for (const [w, rows] of Object.entries(res.windows)) { console.log(`== ${w}`); for (const [k, v] of Object.entries(rows)) console.log(k.padEnd(52), JSON.stringify(v)); }

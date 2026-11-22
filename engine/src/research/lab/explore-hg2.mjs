// EXPLORATORY (H-G2), run AFTER H-G1 and the efficiency table were seen: NOT evidence, only a feasibility estimate.
// Multiplier from S3's DESIGN rather than from the data: its 40 % annual volatility target gives a daily sigma of
// 0.40 / sqrt(365) = 2.1 %; a 5-sigma day is 10.5 %, so the gap-safe multiplier is m = 1 / 0.105 = 9.5. m = 5 is shown as a
// safer neighbour. Same simulator, costs (Ndax) and window as H-G1.
//   node explore-hg2.mjs <kraken-ohlcvt dir> <out.json>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY } from "./data.mjs";
import { signals } from "../dd2/bt.mjs";
import { backtestGZ } from "./gz.mjs";

const [DIR, OUT] = process.argv.slice(2);
const S3 = { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 };
const assets = [["BTC", "XBTUSD"], ["ETH", "ETHUSD"]].map(([name, f]) => { const K = loadKraken(join(DIR, `${f}_1440.csv`), DAY).bars, s = signals(K, S3); return { name, K, target: (i) => { const w = s.target(i); return w === null ? null : w * 0.5; } }; });
const NDAX = { fee: 0.002, spread: 0.0025, minUsd: 1 };
const r2 = (x) => Math.round(x * 100) / 100;
const rows = [];
for (const [w0, w1] of [["2018-04-01", "2026-10-01"], ["2018-04-01", "2022-01-01"], ["2022-01-01", "2026-10-01"]]) for (const m of [5, 9.5]) {
  const r = backtestGZ(assets, { m }, NDAX, { from: Date.parse(w0), to: Date.parse(w1) });
  const lockedFrom = (() => { let p = 0; for (const [t, v] of r.curve) { p = Math.max(p, v); } return null; })();
  rows.push({ window: `${w0}..${w1}`, m, final: r2(r.final), cagr_pct: r2(r.cagr_pct), dd_pct: r2(r.dd_pct), fees: r2(r.fees), orders: r.orders, skipped_min: r.skipped, mean_exposure_k_pct: r2(r.mean_k * 100) });
}
writeFileSync(OUT, JSON.stringify({ status: "EXPLORATORY - chosen after seeing results; not evidence", rows }, null, 1) + "\n");
for (const x of rows) console.log(JSON.stringify(x));

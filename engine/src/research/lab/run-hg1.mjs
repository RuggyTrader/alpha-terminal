// H-G1 runner: docs/research/ddsize/PREREGISTRATION.md. Frozen S3 signal + Grossman-Zhou overlay, m in {1, 2, 3}.
//   node run-hg1.mjs <kraken-ohlcvt dir> <out.json>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY } from "./data.mjs";
import { signals } from "../dd2/bt.mjs";
import { backtestGZ } from "./gz.mjs";

const [DIR, OUT] = process.argv.slice(2);
const S3 = { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 };
const assets = [["BTC", "XBTUSD"], ["ETH", "ETHUSD"]].map(([name, f]) => {
  const { bars: K, sha256 } = loadKraken(join(DIR, `${f}_1440.csv`), DAY);
  const s = signals(K, S3);
  return { name, K, sha256, target: (i) => { const w = s.target(i); return w === null ? null : w * 0.5; } };
});
const NDAX = { fee: 0.002, spread: 0.0025, minUsd: 1 };
const from = Date.parse("2018-04-01"), to = Date.parse("2026-10-01");
const r2 = (x) => Math.round(x * 100) / 100;
const rows = [];
for (const m of [1, 2, 3]) {
  const r = backtestGZ(assets, { m }, NDAX, { from, to });
  rows.push({ m, final: r2(r.final), cagr_pct: r2(r.cagr_pct), dd_pct: r2(r.dd_pct), dd_close_pct: r2(r.dd_close_pct), fees: r2(r.fees), orders: r.orders, skipped: r.skipped, mean_k: r2(r.mean_k * 100) });
}
// reference: S3 unscaled (k = 1 always) through the same simulator and costs
const ref = backtestGZ(assets, { m: 0, fixedK: 1 }, NDAX, { from, to });
rows.push({ m: "reference: S3 unscaled", final: r2(ref.final), cagr_pct: r2(ref.cagr_pct), dd_pct: r2(ref.dd_pct), fees: r2(ref.fees), orders: ref.orders });
writeFileSync(OUT, JSON.stringify({ prereg: "docs/research/ddsize/PREREGISTRATION.md", data: assets.map((a) => ({ name: a.name, sha256: a.sha256 })), window: ["2018-04-01", "2026-09-30"], cost: NDAX, rows }, null, 1) + "\n");
for (const x of rows) console.log(JSON.stringify(x));

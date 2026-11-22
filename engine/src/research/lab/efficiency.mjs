// Drawdown efficiency of a return stream (research only). Under a hard trailing drawdown limit alpha, exposure can never
// exceed (cushion / worst single-period loss), so the attainable growth is bounded by roughly
//     g_max ~= alpha x mu / G
// mu = the stream's annual return at its native size; G = its worst single-day loss (open-to-low, strict) at native size.
// The ratio mu / G is scale-invariant, so it compares strategies of any size. Reported for frozen strategies only.
//   node efficiency.mjs <kraken-ohlcvt dir> <out.json>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY } from "./data.mjs";
import { backtest } from "../dd2/bt.mjs";
import { CANDIDATES } from "../phase3/candidates.mjs";

const [DIR, OUT] = process.argv.slice(2);
const K = Object.fromEntries([["BTC", "XBTUSD"], ["ETH", "ETHUSD"], ["SOL", "SOLUSD"]].map(([a, f]) => [a, loadKraken(join(DIR, `${f}_1440.csv`), DAY).bars]));
const from = Date.parse("2018-04-01"), to = Date.parse("2026-10-01"), yrs = (to - from) / (365.25 * DAY);
const STRATS = { "S3 (frozen)": { uni: ["BTC", "ETH"], spec: { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 } }, ...CANDIDATES };
const r2 = (x) => Math.round(x * 100) / 100;
const rows = [];
// worst single-day loss of equity, marked at the day's low against the previous close
const worstDay = (curve, lowEq) => { let w = 0; for (let i = 1; i < curve.length; i++) w = Math.max(w, 1 - lowEq[i] / curve[i - 1][1]); return w; };
for (const [name, s] of Object.entries(STRATS)) {
  const audit = [];
  const r = backtest(s.uni.map((a) => ({ name: a, K: K[a], minQty: 0 })), s.spec, { from, to, fee: 0.002, slip: 0.0025, stopSlip: 0.0025, audit, minCost: 0 });
  // reconstruct the low-marked equity per day from the curve and positions is not exposed; use the strict max drawdown
  // as a conservative proxy for G when a single-day figure is not available: G = max(dd over one day) <= dd_pct
  const mu = ((r.final / 100) ** (1 / yrs) - 1);
  const daily = []; for (let i = 1; i < r.curve.length; i++) daily.push(r.curve[i][1] / r.curve[i - 1][1] - 1);
  const worstClose = -Math.min(...daily);
  rows.push({ stream: name, native_cagr_pct: r2(mu * 100), worst_day_close_to_close_pct: r2(worstClose * 100), max_dd_pct: r2(r.dd_pct), mu_over_G: r2(mu / worstClose), g_max_at_2pct_dd_pct: r2(0.02 * (mu / worstClose) * 100) });
}
for (const a of ["BTC", "ETH"]) {
  const k = K[a].filter((b) => b.t >= from && b.t < to); const mu = (k.at(-1).c / k[0].o) ** (1 / yrs) - 1;
  let w = 0; for (let i = 1; i < k.length; i++) w = Math.max(w, 1 - k[i].l / k[i - 1].c);
  rows.push({ stream: `${a} buy-and-hold`, native_cagr_pct: r2(mu * 100), worst_day_close_to_low_pct: r2(w * 100), mu_over_G: r2(mu / w), g_max_at_2pct_dd_pct: r2(0.02 * (mu / w) * 100) });
}
writeFileSync(OUT, JSON.stringify({ window: ["2018-04-01", "2026-09-30"], costs: "0.20 % fee + 0.25 % spread per side (Ndax)", note: "no minimum order sizes (scale-free ratio); bound is approximate", rows }, null, 1) + "\n");
for (const x of rows) console.log(JSON.stringify(x));

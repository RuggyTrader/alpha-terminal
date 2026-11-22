// Official drawdown of frozen strategies B, A and S3: conservative daily-candle bound vs time-ordered 5-minute
// reconstruction (same fills). Research only; frozen rules; prices and periods REUSED from earlier rounds.
//   node run-reconstruct.mjs <kraken-ohlcvt dir> <out.json>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY } from "./data.mjs";
import { backtest, MIN_QTY } from "../dd2/bt.mjs";
import { CANDIDATES } from "../phase3/candidates.mjs";
import { reconstructOfficialDD } from "./reconstruct.mjs";

const [DIR, OUT] = process.argv.slice(2);
const F = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD" };
const K = Object.fromEntries(Object.entries(F).map(([a, f]) => [a, loadKraken(join(DIR, `${f}_1440.csv`), DAY).bars]));
const B5 = Object.fromEntries(Object.entries(F).map(([a, f]) => [a, loadKraken(join(DIR, `${f}_5.csv`), 300_000).bars]));
const NDAX_MIN = { BTC: 0.00001, ETH: 0.0001, SOL: 0.01 };
const COSTS = {
  "Kraken USD market, today's fees (0.80 % taker)": { fee: 0.008, slip: 0.0005, stopSlip: 0.001, min: MIN_QTY },
  "Ndax-like market (0.20 % + 0.25 %)": { fee: 0.002, slip: 0.0025, stopSlip: 0.0025, min: NDAX_MIN },
};
const STRATS = { "B 3-asset momentum 0.10%": CANDIDATES["B 3-asset momentum 0.10%"], "A BTC momentum 0.25%": CANDIDATES["A BTC momentum 0.25%"], "S3 (frozen)": { uni: ["BTC", "ETH"], spec: { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 } } };
const r2 = (x) => Math.round(x * 100) / 100;
const rows = [];
for (const [w0, w1] of [["2018-04-01", "2026-10-01"], ["2021-07-01", "2026-10-01"]]) for (const [sn, s] of Object.entries(STRATS)) for (const [cn, c] of Object.entries(COSTS)) {
  const from = Date.parse(w0), to = Date.parse(w1), audit = [];
  const bt = backtest(s.uni.map((a) => ({ name: a, K: K[a], minQty: c.min[a] })), s.spec, { from, to, fee: c.fee, slip: c.slip, stopSlip: c.stopSlip, audit });
  const rc = reconstructOfficialDD(audit, Object.fromEntries(s.uni.map((a) => [a, B5[a]])), { capital: 100, from, to });
  rows.push({ window: `${w0}..${w1}`, strategy: sn, cost: cn, final: r2(bt.final), cagr_pct: r2(bt.cagr_pct), orders: bt.trades,
    dd_official_candle_bound_pct: r2(bt.dd_official_pct), dd_official_5m_reconstructed_pct: r2(rc.dd_official_5m_pct),
    meets_2pct_candle_bound: bt.dd_official_pct < 2, meets_2pct_5m: rc.dd_official_5m_pct < 2,
    check_final_5m_vs_daily: r2(rc.final_marked - bt.final), unresolved_stops: rc.unresolved_stops, old_strict_pct: r2(bt.dd_pct) });
}
writeFileSync(OUT, JSON.stringify({ note: "SOL starts 2021-06-17 (Kraken listing); 2018 window uses BTC+ETH data only until then", rows }, null, 1) + "\n");
for (const x of rows) console.log(`${x.window} ${x.strategy.padEnd(26)} ${x.cost.padEnd(46)} $${x.final} ${x.cagr_pct}%/yr | official: candle ${x.dd_official_candle_bound_pct}% vs 5m ${x.dd_official_5m_reconstructed_pct}% | check ${x.check_final_5m_vs_daily} unresolved ${x.unresolved_stops}`);

// DIAGNOSTIC ONLY (run after H-L1 was rejected): does any edge exist before costs, and does the conservative same-hour
// stop rule drive the loss? Nothing here can rescue H-L1; it only explains the result.
//   node diag-hl1.mjs <kraken-ohlcvt dir>
import { join } from "node:path";
import { loadKraken, makeDailyVol, HOUR, DAY } from "./data.mjs";
import { backtestWick, tradeStats } from "./wick.mjs";

const DIR = process.argv[2];
const ld = (name, f) => ({ name, H: loadKraken(join(DIR, `${f}_60.csv`), HOUR).bars, vol: makeDailyVol(loadKraken(join(DIR, `${f}_1440.csv`), DAY).bars, 30) });
const A = { BTC: ld("BTC", "XBTUSD"), ETH: ld("ETH", "ETHUSD"), SOL: ld("SOL", "SOLUSD") };
const zero = { fee: () => ({ maker: 0, taker: 0 }), minUsd: 0, exitSlip: () => 0 };
for (const [set, as, f, t] of [["D", ["BTC", "ETH"], "2016-01-01", "2021-01-01"], ["C1", ["BTC", "ETH", "SOL"], "2021-01-01", "2026-10-01"]])
  for (const z of [1.5, 2, 3]) for (const sameHourStop of [true, false]) {
    const bt = backtestWick(as.map((a) => A[a]), { z, m: 0.5, holdH: 72, r: 0.25, cap: 1 / as.length }, zero, { from: Date.parse(f), to: Date.parse(t), eps: 0, sameHourStop });
    const st = tradeStats(bt.trades);
    console.log(`${set} z${z} zero cost, eps 0, sameHourStop=${sameHourStop}: n ${st.n} meanR ${st.mean_R?.toFixed(3)} CI [${st.ci90_R?.map((v) => v.toFixed(2))}] win ${((st.win_rate ?? 0) * 100).toFixed(0)}% final $${bt.final.toFixed(2)}`);
  }

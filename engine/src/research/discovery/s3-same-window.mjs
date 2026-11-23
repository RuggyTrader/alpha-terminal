// S3 benchmark on the discovery confirmation window (2023-01..2026-09), Ndax measured costs, 25 % and 50 % size.
//   node s3-same-window.mjs <kraken-ohlcvt dir>
import { join } from "node:path";
import { loadKraken, DAY } from "../lab/data.mjs";
import { backtest } from "../dd2/bt.mjs";

const KR = process.argv[2];
const K = { BTC: loadKraken(join(KR, "XBTUSD_1440.csv"), DAY).bars, ETH: loadKraken(join(KR, "ETHUSD_1440.csv"), DAY).bars };
const C = { BTC: 0.0024891, ETH: 0.0018971 }; // measured Ndax C$50 cost per side (2026-11-22)
const exec = (a, _t, s, _o, b) => ({ px: b.o * (s === "BUY" ? 1 + C[a] : 1 - C[a]), fee: 0.002 });
for (const scale of [0.25, 0.5]) {
  const from = Date.parse("2023-01-01"), to = Date.parse("2026-10-01");
  const r = backtest(["BTC", "ETH"].map((a) => ({ name: a, K: K[a], minQty: a === "BTC" ? 0.00001 : 0.0001 })), { family: "V", p: { n: 200, tv: 0.4 }, cb: 0, scale }, { from, to, fee: 0.002, slip: 0, stopSlip: 0, exec });
  const y = (to - from) / (365.25 * DAY), by = {};
  for (const yr of [2023, 2024, 2025, 2026]) { const a = r.curve.filter(([t]) => new Date(t).getUTCFullYear() < yr).at(-1)?.[1] ?? 100, b = r.curve.filter(([t]) => new Date(t).getUTCFullYear() <= yr).at(-1)?.[1]; by[yr] = Math.round((b / a - 1) * 1e4) / 100; }
  console.log(`S3 ${scale * 100}% 2023-01..2026-09: $${r.final.toFixed(2)} ${(((r.final / 100) ** (1 / y) - 1) * 100).toFixed(2)}%/yr DD ${r.dd_official_pct.toFixed(2)}% by year ${JSON.stringify(by)}`);
}

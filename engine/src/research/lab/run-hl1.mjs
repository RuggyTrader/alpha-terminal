// H-L1 runner: executes docs/research/liquidity/PREREGISTRATION.md exactly (6 settings x sets D, C1, C2 x cost models).
//   node run-hl1.mjs <kraken-ohlcvt dir> <out.json>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, makeDailyVol, HOUR, DAY } from "./data.mjs";
import { venue } from "./costs.mjs";
import { backtestWick, tradeStats } from "./wick.mjs";

const [DIR, OUT] = process.argv.slice(2);
const FILE = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", XRP: "XRPUSD", XLM: "XLMUSD", LTC: "LTCUSD", XMR: "XMRUSD", ETC: "ETCUSD", ADA: "ADAUSD", BCH: "BCHUSD", ZEC: "ZECUSD", DASH: "DASHUSD", DOGE: "XDGUSD" };
const data = {}, provenance = {};
for (const [a, f] of Object.entries(FILE)) {
  const h = loadKraken(join(DIR, `${f}_60.csv`), HOUR), d = loadKraken(join(DIR, `${f}_1440.csv`), DAY);
  data[a] = { name: a, H: h.bars, vol: makeDailyVol(d.bars, 30) };
  provenance[a] = { hourly: { sha256: h.sha256, bars: h.report.bars, missing: h.report.missing_bars }, daily: { sha256: d.sha256, bars: d.report.bars, missing: d.report.missing_bars } };
}
const SETTINGS = { a: { z: 1.5, holdH: 24 }, b: { z: 1.5, holdH: 72 }, c: { z: 2, holdH: 24 }, d: { z: 2, holdH: 72 }, e: { z: 3, holdH: 24 }, f: { z: 3, holdH: 72 } };
const COSTS = {
  primary: { v: venue("kraken"), eps: 0.0005, conv: 0.0093 },
  kraken_historical_fees: { v: venue("kraken", { basis: "historical" }), eps: 0.0005, conv: 0.0093 },
  ndax_hypothetical: { v: venue("ndax"), eps: 0.0005, conv: 0 },
  stress: { v: venue("kraken", { stress: 2 }), eps: 0.0025, conv: 0.0093 },
};
const SETS = {
  D: [{ assets: ["BTC", "ETH"], from: "2016-01-01", to: "2021-01-01" }],
  C1: [{ assets: ["BTC", "ETH", "SOL"], from: "2021-01-01", to: "2026-10-01" }],
  C2: ["XRP", "XLM", "LTC", "XMR", "ETC", "ADA", "BCH", "ZEC", "DASH", "DOGE"].map((a) => ({ assets: [a], from: "2018-01-01", to: "2026-10-01" })),
};
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const res = { prereg: "docs/research/liquidity/PREREGISTRATION.md (commit 90c25d7)", provenance, runs: [] };
for (const [set, runs] of Object.entries(SETS)) for (const run of runs) for (const [sid, s] of Object.entries(SETTINGS)) for (const [cid, c] of Object.entries(COSTS)) {
  const from = Date.parse(run.from), to = Date.parse(run.to);
  const bt = backtestWick(run.assets.map((a) => data[a]), { ...s, m: 0.5, r: 0.25, cap: 1 / run.assets.length }, c.v, { from, to, eps: c.eps });
  const final = bt.final * (1 - c.conv), years = (to - from) / (365.25 * DAY);
  const byYear = {}; for (const t of bt.trades) { const y = new Date(t.exitT).getUTCFullYear(); byYear[y] = r2((byYear[y] ?? 0) + t.net); }
  res.runs.push({ set, assets: run.assets.join("+"), setting: sid, ...s, cost: cid, final: r2(final), cagr_pct: r2(((final / 100) ** (1 / years) - 1) * 100), dd_pct: r2(bt.dd_pct),
    trades: bt.n_trades, skipped_min: bt.skipped_min, fees: r2(bt.fees), stats: tradeStats(bt.trades), net_by_exit_year: byYear, R: bt.trades.map((t) => r2(t.R)) });
}
writeFileSync(OUT, JSON.stringify(res) + "\n");
for (const set of Object.keys(SETS)) {
  console.log(`\n=== ${set}`);
  for (const x of res.runs.filter((y) => y.set === set && (set !== "C2" || y.cost === "primary")))
    console.log(`${x.assets.padEnd(12)} ${x.setting} z${x.z} h${String(x.holdH).padEnd(3)} ${x.cost.padEnd(23)} $${String(x.final).padStart(7)} ${String(x.cagr_pct).padStart(6)}%/yr DD ${String(x.dd_pct).padStart(5)}% n ${String(x.trades).padStart(4)} skip ${String(x.skipped_min).padStart(3)} meanR ${x.stats.n ? x.stats.mean_R.toFixed(3) : "-"} CI [${x.stats.n ? x.stats.ci90_R.map((v) => v.toFixed(2)).join(", ") : ""}] win ${x.stats.n ? (x.stats.win_rate * 100).toFixed(0) : "-"}% exits ${JSON.stringify(x.stats.exits ?? {})}`);
}

// S3 at predetermined smaller sizes under the owner's 15 % maximum-drawdown limit (research only; signals unchanged).
// PREDECLARED (committed before the first run):
//   sizes: S3 weights x {1.00, 0.75, 0.50, 0.35, 0.25, 0.15}, rest in cash; the rebalance band scales with size
//   costs: NDAX MEASURED (main) and NDAX CONSERVATIVE (sensitivity), as in s3-backtest.mjs; Ndax minimum orders
//   windows: 2016-07-01..2026-09-30 and 2018-04-01..2026-09-30 (Ndax era)
//   drawdown: official (high-water mark incl. unrealized and intraday; candle bound) + 5-minute time-ordered check
//   PASS: max drawdown < 15 % AND net >= 5 %/yr ("meaningfully profitable") in BOTH windows, main cost set
//   risk-adjusted measures: Sharpe (daily, annualized) and Calmar (net annual / max drawdown)
//   Choosing the best size afterwards is an IN-SAMPLE choice on reused data, not evidence of future results.
//   node s3-sizes.mjs <kraken-ohlcvt dir> <cost-study data dir> <hist-costs dir> <out.json>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY } from "../lab/data.mjs";
import { backtest } from "../dd2/bt.mjs";
import { reconstructOfficialDD } from "../lab/reconstruct.mjs";

const [KR, STUDY, HC, OUT] = process.argv.slice(2);
const K = { BTC: loadKraken(join(KR, "XBTUSD_1440.csv"), DAY).bars, ETH: loadKraken(join(KR, "ETHUSD_1440.csv"), DAY).bars };
const B5 = { BTC: loadKraken(join(KR, "XBTUSD_5.csv"), 300_000).bars, ETH: loadKraken(join(KR, "ETHUSD_5.csv"), 300_000).bars };
const samples = []; for (const f of readdirSync(STUDY).filter((x) => x.startsWith("samples-"))) for (const l of readFileSync(join(STUDY, f), "utf8").trim().split("\n")) samples.push(JSON.parse(l));
const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s[s.length >> 1]; };
const walk = (k) => med(samples.map((s) => { const b = s.books[k]; return b?.exec?.[50]?.buy && b.exec[50].sell ? ((b.exec[50].buy / b.mid - 1) + (1 - b.exec[50].sell / b.mid)) / 2 : NaN; }));
const NDAX = { BTC: walk("Ndax BTC/CAD"), ETH: walk("Ndax ETH/CAD") };
const depth = JSON.parse(readFileSync(join(HC, "depth-observed.json"), "utf8")).rows.filter((r) => !r.error && r.minutes > 600);
const krk = {}; for (const r of depth) { const s = r.symbol.replace("XBT", "BTC"); if (!/CAD/.test(s) || /USD-CAD/.test(s)) continue; (krk[s.split("-")[0]] ??= []).push([Date.parse(r.date), r.cost_per_side_bps["50"].mean / 1e4]); }
for (const a in krk) krk[a].sort((x, y) => x[0] - y[0]);
const krkAt = (a, t) => { const s = krk[a]; if (t <= s[0][0]) return s[0][1]; if (t >= s.at(-1)[0]) return s.at(-1)[1]; let i = 0; while (s[i + 1][0] <= t) i++; const w = (t - s[i][0]) / (s[i + 1][0] - s[i][0]); return s[i][1] + (s[i + 1][1] - s[i][1]) * w; };
const NDAX_MIN = { BTC: 0.00001, ETH: 0.0001 };
const COSTS = {
  "NDAX MEASURED": (a, t, side, _o, bar) => ({ px: bar.o * (side === "BUY" ? 1 + NDAX[a] : 1 - NDAX[a]), fee: 0.002 }),
  "NDAX CONSERVATIVE": (a, t, side, _o, bar) => { const c = Math.max(NDAX[a], krkAt(a, t)); return { px: bar.o * (side === "BUY" ? 1 + c : 1 - c), fee: 0.002 }; },
};
const SIZES = [1, 0.75, 0.5, 0.35, 0.25, 0.15];
const WINDOWS = [["2016-07-01", "2026-10-01"], ["2018-04-01", "2026-10-01"]];
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const rows = [];
for (const [w0, w1] of WINDOWS) for (const [cn, exec] of Object.entries(COSTS)) for (const k of SIZES) {
  const from = Date.parse(w0), to = Date.parse(w1), audit = [];
  const bt = backtest(["BTC", "ETH"].map((a) => ({ name: a, K: K[a], minQty: NDAX_MIN[a] })), { family: "V", p: { n: 200, tv: 0.4 }, cb: 0, scale: k }, { from, to, fee: 0.002, slip: 0, stopSlip: 0, exec, audit });
  const rc = reconstructOfficialDD(audit, B5, { capital: 100, from, to });
  const yrs = (to - from) / (365.25 * DAY), cagr = ((bt.final / 100) ** (1 / yrs) - 1) * 100;
  const dr = bt.curve.slice(1).map(([, v], i) => v / bt.curve[i][1] - 1), m = dr.reduce((a, b) => a + b, 0) / dr.length, sd = Math.sqrt(dr.reduce((a, b) => a + (b - m) ** 2, 0) / dr.length);
  rows.push({ window: `${w0}..2026-09-30`, costs: cn, size_pct: k * 100, final: r2(bt.final), cagr_pct: r2(cagr), max_dd_official_pct: r2(bt.dd_official_pct), max_dd_5min_pct: r2(rc.dd_official_5m_pct), check: r2(rc.final_marked - bt.final),
    sharpe: r2((m / sd) * Math.sqrt(365)), calmar: r2(cagr / bt.dd_official_pct), orders: bt.trades, fees: r2(bt.fees), skipped_min: bt.skipped, below_15pct: bt.dd_official_pct < 15, at_least_5pct_yr: cagr >= 5 });
}
const pass = SIZES.filter((k) => WINDOWS.every(([w0]) => { const r = rows.find((x) => x.window.startsWith(w0) && x.costs === "NDAX MEASURED" && x.size_pct === k * 100); return r.below_15pct && r.at_least_5pct_yr; })).map((k) => k * 100);
writeFileSync(OUT, JSON.stringify({ predeclared: "see file header", ndax_measured_cost_per_side: NDAX, passing_sizes_pct: pass, rows }, null, 1) + "\n");
for (const r of rows) console.log(`${r.window.slice(0, 10)} ${r.costs.padEnd(17)} ${String(r.size_pct).padStart(3)}% | $${String(r.final).padStart(8)} ${String(r.cagr_pct).padStart(6)}%/yr | DD ${r.max_dd_official_pct}% (5m ${r.max_dd_5min_pct}%) | Sharpe ${r.sharpe} Calmar ${r.calmar} | orders ${r.orders} fees $${r.fees} | <15% ${r.below_15pct} >=5% ${r.at_least_5pct_yr}`);
console.log("PASSING SIZES (main costs, both windows):", JSON.stringify(pass));

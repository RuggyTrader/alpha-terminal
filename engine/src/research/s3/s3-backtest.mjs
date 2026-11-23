// S3 (frozen: 200-day SMA x 40 % volatility target, BTC + ETH, equal halves) on Kraken's official daily candles, with the
// original S3 cost assumption vs realistic Ndax costs. Research only; rules unchanged; historical data only.
//   node s3-backtest.mjs <kraken-ohlcvt dir> <cost-study data dir> <hist-costs dir> <out.json>
// Cost sets:
//   ORIGINAL           0.20 % fee + 0.05 % slippage per side (S3 shadow setting), Kraken minimums
//   NDAX MEASURED      0.20 % fee (VERIFIED, ndax.io) + MEASURED Ndax C$50 cost per side (7-day collector, 2026-11-22:
//                      today's level, applied to all history as an ESTIMATE), Ndax minimums
//   NDAX CONSERVATIVE  0.20 % fee + max(measured Ndax, OBSERVED Kraken CAD cost at that date) (ESTIMATE)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY } from "../lab/data.mjs";
import { backtest } from "../dd2/bt.mjs";
import { reconstructOfficialDD } from "../lab/reconstruct.mjs";

const [KR, STUDY, HC, OUT] = process.argv.slice(2);
const K = { BTC: loadKraken(join(KR, "XBTUSD_1440.csv"), DAY), ETH: loadKraken(join(KR, "ETHUSD_1440.csv"), DAY) };
const B5 = { BTC: loadKraken(join(KR, "XBTUSD_5.csv"), 300_000).bars, ETH: loadKraken(join(KR, "ETHUSD_5.csv"), 300_000).bars };
const S3 = { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 };
// measured Ndax C$50 cost per side (median over collector samples)
const samples = []; for (const f of readdirSync(STUDY).filter((x) => x.startsWith("samples-"))) for (const l of readFileSync(join(STUDY, f), "utf8").trim().split("\n")) samples.push(JSON.parse(l));
const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s[s.length >> 1]; };
const walk = (k) => med(samples.map((s) => { const b = s.books[k]; return b?.exec?.[50]?.buy && b.exec[50].sell ? ((b.exec[50].buy / b.mid - 1) + (1 - b.exec[50].sell / b.mid)) / 2 : NaN; }));
const NDAX = { BTC: walk("Ndax BTC/CAD"), ETH: walk("Ndax ETH/CAD") };
// observed Kraken CAD C$50 cost history (Tardis book_snapshot_5 days), interpolated between observation dates
const depth = JSON.parse(readFileSync(join(HC, "depth-observed.json"), "utf8")).rows.filter((r) => !r.error && r.minutes > 600);
const krk = {}; for (const r of depth) { const s = r.symbol.replace("XBT", "BTC"); if (!/CAD/.test(s) || /USD-CAD/.test(s)) continue; (krk[s.split("-")[0]] ??= []).push([Date.parse(r.date), r.cost_per_side_bps["50"].mean / 1e4]); }
for (const a in krk) krk[a].sort((x, y) => x[0] - y[0]);
const krkAt = (a, t) => { const s = krk[a]; if (t <= s[0][0]) return s[0][1]; if (t >= s.at(-1)[0]) return s.at(-1)[1]; let i = 0; while (s[i + 1][0] <= t) i++; const w = (t - s[i][0]) / (s[i + 1][0] - s[i][0]); return s[i][1] + (s[i + 1][1] - s[i][1]) * w; };
const KRAKEN_MIN = { BTC: 0.00006, ETH: 0.002 }, NDAX_MIN = { BTC: 0.00001, ETH: 0.0001 };
const SETS = {
  "ORIGINAL (0.20 % + 0.05 %)": { min: KRAKEN_MIN, opt: { fee: 0.002, slip: 0.0005, stopSlip: 0.0005 } },
  "NDAX MEASURED (0.20 % + measured spread)": { min: NDAX_MIN, opt: { fee: 0.002, slip: 0, stopSlip: 0, exec: (a, t, side, _o, bar) => ({ px: bar.o * (side === "BUY" ? 1 + NDAX[a] : 1 - NDAX[a]), fee: 0.002 }) } },
  "NDAX CONSERVATIVE (0.20 % + max(Ndax, Kraken CAD hist.))": { min: NDAX_MIN, opt: { fee: 0.002, slip: 0, stopSlip: 0, exec: (a, t, side, _o, bar) => { const c = Math.max(NDAX[a], krkAt(a, t)); return { px: bar.o * (side === "BUY" ? 1 + c : 1 - c), fee: 0.002 }; } } },
};
const PERIODS = [
  ["2016-17 bull", "2016-07-01", "2017-12-17", "bull"], ["2018 bear", "2017-12-17", "2018-12-15", "bear"], ["2019 recovery", "2018-12-15", "2019-08-01", "bull"],
  ["sideways 2019-20", "2019-08-01", "2020-02-13", "sideways"], ["Mar 2020 crash", "2020-02-13", "2020-05-01", "crash"], ["2020-21 bull", "2020-05-01", "2021-11-10", "bull"],
  ["2022 bear", "2021-11-10", "2022-12-31", "bear"], ["2023 sideways", "2023-03-01", "2023-10-01", "sideways"], ["2023-24 bull", "2023-10-01", "2024-04-01", "bull"],
  ["2024 sideways", "2024-04-01", "2024-10-01", "sideways"], ["2024-25 bull", "2024-10-01", "2025-10-06", "bull"], ["2025-26 decline", "2025-10-06", "2026-10-01", "bear"],
];
const WINDOWS = [["2016-07-01", "2026-10-01"], ["2018-04-01", "2026-10-01"]];
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const rows = [];
for (const [w0, w1] of WINDOWS) for (const [name, set] of Object.entries(SETS)) {
  const from = Date.parse(w0), to = Date.parse(w1), audit = [];
  const bt = backtest(["BTC", "ETH"].map((a) => ({ name: a, K: K[a].bars, minQty: set.min[a] })), S3, { from, to, ...set.opt, audit });
  const rc = reconstructOfficialDD(audit, B5, { capital: 100, from, to });
  const nets = bt.trade_list.map((t) => t.net), wins = nets.filter((x) => x > 0), losses = nets.filter((x) => x <= 0);
  const yrs = (to - from) / (365.25 * DAY);
  const periods = PERIODS.filter(([, a]) => Date.parse(a) >= from).map(([p, a, b, kind]) => { const c = bt.curve.filter(([t]) => t >= Date.parse(a) && t < Date.parse(b)); if (c.length < 2) return { period: p }; const before = bt.curve.filter(([t]) => t < Date.parse(a)).at(-1)?.[1] ?? 100; let pk = before, md = 0; for (const [, v] of c) { pk = Math.max(pk, v); md = Math.max(md, 1 - v / pk); } return { period: p, market: kind, return_pct: r2((c.at(-1)[1] / before - 1) * 100), close_dd_pct: r2(md * 100) }; });
  rows.push({ window: `${w0}..2026-09-30`, costs: name, final: r2(bt.final), cagr_pct: r2(((bt.final / 100) ** (1 / yrs) - 1) * 100),
    max_dd_official_candle_pct: r2(bt.dd_official_pct), max_dd_official_5min_pct: r2(rc.dd_official_5m_pct), five_min_check_final_diff: r2(rc.final_marked - bt.final),
    orders: bt.trades, round_trips: nets.length, win_rate_pct: r2((100 * wins.length) / (nets.length || 1)), profit_factor: r2(wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0) || 1)),
    fees_usd: r2(bt.fees), skipped_min: bt.skipped, open_at_end: bt.open_at_end, passes_2pct: bt.dd_official_pct < 2, periods });
}
writeFileSync(OUT, JSON.stringify({ rules: "S3 frozen (V n200 tv0.4, BTC+ETH halves, 0.10 band)", data: "Kraken official OHLCVT daily (signals/fills), 5-minute (drawdown reconstruction)", ndax_measured_cost_per_side: NDAX, ndax_samples: samples.length, rows }, null, 1) + "\n");
console.log("Ndax measured cost/side:", JSON.stringify(NDAX), "samples", samples.length);
for (const r of rows) { console.log(`\n${r.window} | ${r.costs}\n  final $${r.final} | ${r.cagr_pct}%/yr | max DD official: candle ${r.max_dd_official_candle_pct}% / 5-min ${r.max_dd_official_5min_pct}% (check ${r.five_min_check_final_diff}) | orders ${r.orders} | round trips ${r.round_trips} | win ${r.win_rate_pct}% | PF ${r.profit_factor} | fees $${r.fees_usd} | 2% ${r.passes_2pct ? "PASS" : "FAIL"}`); console.log("  " + r.periods.map((p) => `${p.period}: ${p.return_pct}% (dd ${p.close_dd_pct}%)`).join(" | ")); }

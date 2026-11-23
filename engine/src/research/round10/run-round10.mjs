// Round 10 runner: N1-N3 and benchmarks, exactly as docs/research/round10/PREREGISTRATION.md (ebc43ce). Research only.
//   node run-round10.mjs <kraken-ohlcvt dir> <cost-study data dir> <hist-costs dir> <out.json>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY } from "../lab/data.mjs";
import { backtest } from "../dd2/bt.mjs";
import { reconstructOfficialDD } from "../lab/reconstruct.mjs";
import { floorOverlay, rolling } from "./round10-lib.mjs";

const [KR, STUDY, HC, OUT] = process.argv.slice(2);
const load = (f, step) => loadKraken(join(KR, f), step).bars;
const K = { BTC: load("XBTUSD_1440.csv", DAY), ETH: load("ETHUSD_1440.csv", DAY), LTC: load("LTCUSD_1440.csv", DAY), XRP: load("XRPUSD_1440.csv", DAY) };
const B5 = { BTC: load("XBTUSD_5.csv", 300_000), ETH: load("ETHUSD_5.csv", 300_000) };
// costs exactly as s3-backtest.mjs / s3-sizes.mjs (measured Ndax C$50 spread per side + 0.20 % fee)
const samples = []; for (const f of readdirSync(STUDY).filter((x) => x.startsWith("samples-"))) for (const l of readFileSync(join(STUDY, f), "utf8").trim().split("\n")) samples.push(JSON.parse(l));
const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s[s.length >> 1]; };
const walk = (k) => med(samples.map((s) => { const b = s.books[k]; return b?.exec?.[50]?.buy && b.exec[50].sell ? ((b.exec[50].buy / b.mid - 1) + (1 - b.exec[50].sell / b.mid)) / 2 : NaN; }));
const NDAX = { BTC: walk("Ndax BTC/CAD"), ETH: walk("Ndax ETH/CAD"), XRP: 0.0024, LTC: 0.0035 };
const depth = JSON.parse(readFileSync(join(HC, "depth-observed.json"), "utf8")).rows.filter((r) => !r.error && r.minutes > 600);
const krk = {}; for (const r of depth) { const s = r.symbol.replace("XBT", "BTC"); if (!/CAD/.test(s) || /USD-CAD/.test(s)) continue; (krk[s.split("-")[0]] ??= []).push([Date.parse(r.date), r.cost_per_side_bps["50"].mean / 1e4]); }
for (const a in krk) krk[a].sort((x, y) => x[0] - y[0]);
const krkAt = (a, t) => { const s = krk[a]; if (!s) return 2 * NDAX[a]; if (t <= s[0][0]) return s[0][1]; if (t >= s.at(-1)[0]) return s.at(-1)[1]; let i = 0; while (s[i + 1][0] <= t) i++; const w = (t - s[i][0]) / (s[i + 1][0] - s[i][0]); return s[i][1] + (s[i + 1][1] - s[i][1]) * w; };
const COSTS = {
  "NDAX MEASURED": (a, t, side, _o, bar) => ({ px: bar.o * (side === "BUY" ? 1 + NDAX[a] : 1 - NDAX[a]), fee: 0.002 }),
  "NDAX CONSERVATIVE": (a, t, side, _o, bar) => { const c = Math.max(NDAX[a], krkAt(a, t)); return { px: bar.o * (side === "BUY" ? 1 + c : 1 - c), fee: 0.002 }; },
};
const MIN = { BTC: 0.00001, ETH: 0.0001, LTC: 0, XRP: 0 };
const V = { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 }, H = { family: "H", p: {}, cb: 0 };
const STRATS = {
  "S3-25 (benchmark)": { ...V, scale: 0.25 }, "S3-30 (benchmark)": { ...V, scale: 0.3 }, "Buy-and-hold": { ...H },
  "N1 constant mix 7 %": { ...H, scale: 0.07 },
  "N2 floor buy-and-hold D15": { ...H, overlay: floorOverlay(0.15, 2) }, "N2 floor buy-and-hold D10": { ...H, overlay: floorOverlay(0.10, 2) },
  "N3 floor S3 D15": { ...V, overlay: floorOverlay(0.15, 2) }, "N3 floor S3 D10": { ...V, overlay: floorOverlay(0.10, 2) },
};
const WINDOWS = [
  ["DEV-A", ["BTC", "ETH"], "2016-07-01", "2026-10-01", "reused (selected S3)"], ["DEV-B", ["BTC", "ETH"], "2018-04-01", "2026-10-01", "reused (Ndax era)"],
  ["HOLDOUT-1", ["BTC"], "2014-05-01", "2016-07-01", "never used by S3-type or overlay tests"], ["HOLDOUT-2", ["LTC", "XRP"], "2018-04-01", "2026-10-01", "coins seen in other rounds; not independent"],
];
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const rows = [];
for (const [win, assets, w0, w1, status] of WINDOWS) for (const [cname, exec] of Object.entries(COSTS)) for (const [sname, spec] of Object.entries(STRATS)) {
  const from = Date.parse(w0), to = Date.parse(w1), audit = [];
  const bt = backtest(assets.map((a) => ({ name: a, K: K[a], minQty: MIN[a], minUsd: 1 })), spec, { from, to, fee: 0.002, slip: 0, stopSlip: 0, exec, audit });
  const b5 = Object.fromEntries(assets.filter((a) => B5[a]).map((a) => [a, B5[a]]));
  const rc = Object.keys(b5).length === assets.length ? reconstructOfficialDD(audit, b5, { capital: 100, from, to }) : null;
  const yrs = (to - from) / (365.25 * DAY), years = {};
  for (let y = new Date(from).getUTCFullYear(); y <= new Date(to - 1).getUTCFullYear(); y++) { const a = Date.parse(`${y}-01-01`), b = Date.parse(`${y + 1}-01-01`); const c = bt.curve.filter(([t]) => t >= a && t < b); if (!c.length) continue; const before = bt.curve.filter(([t]) => t < a).at(-1)?.[1] ?? 100; years[y] = r2((c.at(-1)[1] / before - 1) * 100); }
  rows.push({ window: win, data_status: status, assets: assets.join("+"), period: `${w0}..${w1}`, costs: cname, strategy: sname,
    final: r2(bt.final), cagr_pct: r2(((bt.final / 100) ** (1 / yrs) - 1) * 100), dd_official_pct: r2(bt.dd_official_pct), dd_official_5min_pct: rc ? r2(rc.dd_official_5m_pct) : null,
    orders: bt.trades, fees: r2(bt.fees), skipped_min: bt.skipped, exposure_days_pct: r2(bt.exposure_pct), years,
    rolling: Object.fromEntries([7, 14, 30, 90].map((h) => [`${h}d`, Object.fromEntries(Object.entries(rolling(bt.curve, h)).map(([k, v]) => [k, r2(v)]))])) });
}
// pre-registered decision (main costs for 2, 3, 4; both cost sets for 1)
const get = (w, c, s) => rows.find((r) => r.window === w && r.costs === c && r.strategy === s);
const M = "NDAX MEASURED", decisions = {};
for (const s of Object.keys(STRATS).filter((x) => x.startsWith("N"))) {
  const dd = Math.max(...rows.filter((r) => r.strategy === s).map((r) => Math.max(r.dd_official_pct, r.dd_official_5min_pct ?? 0)));
  const c1 = rows.filter((r) => r.strategy === s).every((r) => r.dd_official_pct < 15);
  const c2 = ["DEV-A", "DEV-B"].every((w) => get(w, M, s).cagr_pct > get(w, M, "S3-25 (benchmark)").cagr_pct);
  const h1 = get("HOLDOUT-1", M, s), c3 = h1.final > 100 && h1.final > get("HOLDOUT-1", M, "S3-25 (benchmark)").final;
  const h2 = get("HOLDOUT-2", M, s), c4 = h2.dd_official_pct < 15 && h2.final >= 100;
  const beats30 = s.startsWith("N3") ? ["DEV-A", "DEV-B", "HOLDOUT-1"].every((w) => get(w, M, s).final > get(w, M, "S3-30 (benchmark)").final) : null;
  decisions[s] = { c1_dd_below_15_all: c1, c2_beats_S3_25_dev: c2, c3_holdout1_positive_and_beats_S3_25: c3, c4_holdout2_consistent: c4, beats_S3_30: beats30,
    under_10_all: rows.filter((r) => r.strategy === s).every((r) => r.dd_official_pct < 10), worst_dd_any_pct: r2(dd),
    verdict: c1 && c2 && c3 ? (c4 ? (beats30 === false ? "ADVANCE (equivalent to a larger fixed S3 only)" : "ADVANCE") : "INCONCLUSIVE") : "REJECTED" };
}
writeFileSync(OUT, JSON.stringify({ prereg: "docs/research/round10/PREREGISTRATION.md (ebc43ce)", ndax_cost_per_side: NDAX, decisions, rows }, null, 1) + "\n");
console.log(JSON.stringify(decisions, null, 1));
for (const r of rows.filter((x) => x.costs === M)) console.log(`${r.window.padEnd(10)} ${r.strategy.padEnd(28)} CAGR ${String(r.cagr_pct).padStart(7)} DD ${String(r.dd_official_pct).padStart(6)} 5m ${String(r.dd_official_5min_pct).padStart(6)} orders ${r.orders} 30d worst ${r.rolling["30d"].worst_pct} 90d med ${r.rolling["90d"].median_pct}`);

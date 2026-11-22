// Historical spread model (research only). Separates OBSERVED from ESTIMATED spreads:
//   OBSERVED   Tardis.dev free first-of-month Kraken top-of-book (median of 1-minute samples over that UTC day)
//   ESTIMATED  (a) Abdi-Ranaldo close-high-low estimator on Kraken's official hourly OHLC, month by month
//              (b) buyer- vs seller-initiated first-fill price gap from Kraken's official public trades
// The estimators are calibrated against the observed spreads on months where both exist; the better-calibrated one is
// used ONLY where no observation exists (before July 2019), and is labelled as an estimate everywhere.
//   node hist-spreads.mjs <hist-costs dir> <out.json>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [DIR, OUT] = process.argv.slice(2);
const SYMS = { "BTC/USD": "XBTUSD", "BTC/CAD": "XBTCAD", "ETH/USD": "ETHUSD", "ETH/CAD": "ETHCAD", "SOL/USD": "SOLUSD", "SOL/CAD": "SOLCAD", "USD/CAD": "USDCAD" };
const month = (ms) => new Date(ms).toISOString().slice(0, 7);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const readCsv = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => { const x = l.split(",").map(Number); return { t: x[0] * 1000, o: x[1], h: x[2], l: x[3], c: x[4], v: x[5], n: x[6] }; });

// observed
const books = JSON.parse(readFileSync(join(DIR, "books-observed.json"), "utf8")).rows.filter((r) => !r.error && r.minutes > 600);
const norm = (s) => s.replace("XBT", "BTC").replace("-", "/");
const observed = {}; // sym -> month -> {median, p90, cover50}
for (const r of books) { const s = norm(r.symbol); (observed[s] ??= {})[r.date.slice(0, 7)] = { median: r.spread_bps.median, p90: r.spread_bps.p90, top_covers_50: r.top_level_covers_pct["50"], date: r.date }; }
// (a) CHL from hourly bars
const chl = {}, activity = {};
for (const [s, k] of Object.entries(SYMS)) {
  const f = join(DIR, "kraken-ohlcvt", `${k}_60.csv`); if (!existsSync(f)) continue;
  const H = readCsv(f), acc = {};
  for (let i = 0; i + 1 < H.length; i++) {
    if (H[i + 1].t - H[i].t !== 3_600_000) continue;
    const c = Math.log(H[i].c), e0 = (Math.log(H[i].h) + Math.log(H[i].l)) / 2, e1 = (Math.log(H[i + 1].h) + Math.log(H[i + 1].l)) / 2;
    const m = month(H[i].t); (acc[m] ??= []).push(4 * (c - e0) * (c - e1));
  }
  chl[s] = Object.fromEntries(Object.entries(acc).map(([m, a]) => [m, Math.sqrt(Math.max(0, a.reduce((x, y) => x + y, 0) / a.length)) * 1e4]));
  const act = {}; for (const b of H) { const m = month(b.t); act[m] ??= { hours: 0, trades: 0 }; act[m].hours++; act[m].trades += b.n; }
  activity[s] = act;
}
// (b) trade-gap from sampled days
const trades = existsSync(join(DIR, "trades-kraken.json")) ? JSON.parse(readFileSync(join(DIR, "trades-kraken.json"), "utf8")).rows.filter((r) => !r.error && r.trades) : [];
const gap = {};
for (const r of trades) { const s = Object.entries(SYMS).find(([, k]) => k === r.pair)?.[0]; if (!s || !(r.buy_sell_gap_bps?.pairs >= 30)) continue; (gap[s] ??= {})[r.date.slice(0, 7)] = { median: r.buy_sell_gap_bps.median, pairs: r.buy_sell_gap_bps.pairs, date: r.date }; }

// calibration: log-ratio observed / estimate on overlapping months (per symbol and pooled)
function calib(est) {
  const pts = [];
  for (const [s, obs] of Object.entries(observed)) for (const [m, o] of Object.entries(obs)) { const e = est[s]?.[m]; const ev = typeof e === "object" ? e?.median : e; if (ev > 0 && o.median > 0) pts.push({ s, m, obs: o.median, est: ev }); }
  if (pts.length < 5) return { n: pts.length };
  const lr = pts.map((p) => Math.log(p.obs / p.est)), mu = lr.reduce((a, b) => a + b, 0) / lr.length;
  const xs = pts.map((p) => Math.log(p.est)), ys = pts.map((p) => Math.log(p.obs));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0), vx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), vy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  const resid = lr.map((v) => v - mu), rmse = Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / resid.length);
  const within2x = lr.filter((v) => Math.abs(v - mu) <= Math.log(2)).length / lr.length;
  return { n: pts.length, factor: Math.exp(mu), corr_log: cov / Math.sqrt(vx * vy), rmse_log: rmse, within_2x_after_scaling: within2x, points: pts };
}
const calCHL = calib(chl), calGap = calib(gap);
const pick = (calCHL.corr_log ?? -1) >= (calGap.corr_log ?? -1) ? "CHL" : "trade-gap";
// final monthly series per symbol: observed (exact month), interpolated between observations, estimated before the first observation
const series = {};
for (const s of Object.keys(SYMS)) {
  const obsM = Object.keys(observed[s] ?? {}).sort();
  const months = Object.keys(activity[s] ?? {}).sort();
  const out = {};
  for (const m of months) {
    if (observed[s]?.[m]) { out[m] = { spread_bps: observed[s][m].median, p90_bps: observed[s][m].p90, source: "observed" }; continue; }
    const prev = obsM.filter((x) => x < m).at(-1), next = obsM.find((x) => x > m);
    if (prev && next) { const a = observed[s][prev].median, b = observed[s][next].median; out[m] = { spread_bps: Math.sqrt(a * b), source: `interpolated (observed ${prev} and ${next})` }; continue; }
    if (prev) { out[m] = { spread_bps: observed[s][prev].median, source: `carried forward (observed ${prev})` }; continue; }
    // before the first observation: the estimators calibrate too poorly to be used as numbers (see calibration), so the
    // first OBSERVED month is carried back as an ASSUMPTION; the calibrated estimate is kept beside it for reference only
    const cal = pick === "CHL" ? calCHL : calGap;
    const raw = pick === "CHL" ? chl[s]?.[m] : gap[s]?.[m]?.median;
    if (next) out[m] = { spread_bps: observed[s][next].median, source: `ASSUMED: carried back from first observation ${next}`, estimate_bps_reference_only: raw > 0 && cal.factor ? raw * cal.factor : null };
  }
  series[s] = out;
}
const strip = (c) => ({ ...c, points: undefined });
writeFileSync(OUT, JSON.stringify({ calibration: { CHL: strip(calCHL), trade_gap: strip(calGap), chosen_for_pre_2019: pick, points_CHL: calCHL.points, points_gap: calGap.points }, observed, chl, gap, activity, series }, null, 1) + "\n");
console.log("calibration CHL", JSON.stringify(strip(calCHL)));
console.log("calibration gap", JSON.stringify(strip(calGap)));
console.log("chosen:", pick);
for (const s of Object.keys(SYMS)) { const ys = {}; for (const [m, v] of Object.entries(series[s])) { const y = m.slice(0, 4); (ys[y] ??= []).push(v.spread_bps); } console.log(s.padEnd(8), Object.entries(ys).map(([y, a]) => `${y}:${median(a.filter((x) => x != null))?.toFixed(1)}`).join(" ")); }

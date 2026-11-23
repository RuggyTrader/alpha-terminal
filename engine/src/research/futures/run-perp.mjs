// Runner for docs/research/futures/PERP-PREREGISTRATION.md (THEORETICAL PAPER ONLY).
//   node run-perp.mjs <kraken-ohlcvt dir> <signals dir> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken } from "../lab/data.mjs";
import { sma } from "../dd2/bt.mjs";
import { simulatePerp, periodStats, longestRecoveryDays, HOUR, DAY } from "./perp.mjs";

const [KR, SIG, OUT] = process.argv.slice(2);
const A = { BTC: ["XBTUSD", "BTCUSDT"], ETH: ["ETHUSD", "ETHUSDT"] };
const PROXY_FUNDING_BASE = 0.0001 / 8; // 0.01 % per 8 h, ASSUMED before 2019-09
const data = {};
for (const [a, [k, b]] of Object.entries(A)) {
  const D = loadKraken(join(KR, `${k}_1440.csv`), DAY).bars, H = loadKraken(join(KR, `${k}_60.csv`), HOUR).bars;
  const f = JSON.parse(readFileSync(join(SIG, `binance-funding-${b}.json`), "utf8")).data.sort((x, y) => x[0] - y[0]);
  const first = f[0][0];
  // funding at hour t = the most recent 8-hourly rate with fundingTime <= t, spread over 8 hours
  const funding = (t) => { if (t < first) return PROXY_FUNDING_BASE; let lo = 0, hi = f.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (f[m][0] <= t) lo = m; else hi = m - 1; } return f[lo][1] / 8; };
  const idx = new Map(D.map((x, i) => [x.t, i])), c = D.map((x) => x.c), S = sma(c, 200);
  const vol = c.map((_, i) => { if (i < 31) return null; const r = []; for (let j = i - 29; j <= i; j++) r.push(Math.log(c[j] / c[j - 1])); const m = r.reduce((p, q) => p + q, 0) / 30; return Math.sqrt(r.reduce((p, q) => p + (q - m) ** 2, 0) / 29) * Math.sqrt(365); });
  data[a] = { name: a, H, funding, D, idx, c, S, vol };
}
const prev = (a, d) => data[a].idx.get(d - DAY); // decision for day d uses the close of day d-1
const trend = (a, d, longShort) => { const i = prev(a, d); if (i === undefined || data[a].S[i] === null) return null; return data[a].c[i] > data[a].S[i] ? 1 : longShort ? -1 : 0; };
const ret28 = (a, d) => { const i = prev(a, d); return i === undefined || i < 28 ? null : data[a].c[i] / data[a].c[i - 28] - 1; };
const SIGNALS = {
  "H1 trend long-only": (d) => ({ BTC: trend("BTC", d, false), ETH: trend("ETH", d, false) }),
  "H2 trend long/short": (d) => ({ BTC: trend("BTC", d, true), ETH: trend("ETH", d, true) }),
  "H3 relative momentum (market-neutral)": (d) => { if (new Date(d).getUTCDay() !== 1) return null; const b = ret28("BTC", d), e = ret28("ETH", d); if (b === null || e === null) return null; return b > e ? { BTC: 1, ETH: -1 } : { BTC: -1, ETH: 1 }; },
};
const SIZING = {
  "1x": () => 0.5, "2x": () => 1, "3x": () => 1.5,
  "vol-target 15%": (a, d) => { const i = prev(a, d), v = i === undefined ? null : data[a].vol[i]; return v ? Math.min(1.5, 0.106 / v) : 0; },
  "EXPLORATORY 5x": () => 2.5,
};
const COSTS = {
  ideal: { fee: { mode: "ideal", pct: { BTC: 0.00082, ETH: 0.0029 }, perContract: { BTC: 0.5, ETH: 0.5 }, contract: { BTC: 0.01, ETH: 0.1 } }, spread: { BTC: 0.00008, ETH: 0.00029 }, slip: 0.0002, liqSlip: 0.003, missProb: 0, liqFee: { pct: 0.005, perContract: 10 } },
  conservative: { fee: { mode: "conservative", pct: { BTC: 0.00082, ETH: 0.0029 }, perContract: { BTC: 0.5, ETH: 0.5 }, contract: { BTC: 0.01, ETH: 0.1 } }, spread: { BTC: 0.00016, ETH: 0.00058 }, slip: 0.0005, liqSlip: 0.003, missProb: 0.02, liqFee: { pct: 0.005, perContract: 10 } },
};
const MARGIN = { init: { BTC: 0.1, ETH: 0.1 }, maint: { BTC: 0.05, ETH: 0.05 } };
const NT = { contractUnits: { BTC: 0.01, ETH: 0.1 }, overnight: { BTC: 260, ETH: 170 }, price: { BTC: 61176, ETH: 1723.2 } }; // NinjaTrader perp-style, 2026-11-22
const WINDOWS = [["2017-01-01", "2026-10-01"], ["2018-04-01", "2026-10-01"], ["2022-01-01", "2026-10-01"]];
const CYCLES = [["2017-18 bull+bear", "2017-01-01", "2019-01-01"], ["2019 recovery", "2019-01-01", "2020-02-13"], ["Mar 2020 crash", "2020-02-13", "2020-05-01"], ["2020-21 bull", "2020-05-01", "2021-11-10"], ["2022 bear", "2021-11-10", "2023-01-01"], ["2023-26", "2023-01-01", "2026-10-01"]];
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const rows = [];
for (const [hn, sig] of Object.entries(SIGNALS)) for (const [sn, size] of Object.entries(SIZING)) for (const [cn, cost] of Object.entries(COSTS)) for (const compound of [true, false]) {
  if (!compound && (sn.startsWith("EXPL") || cn === "ideal")) continue;
  const weightsSeen = { BTC: [], ETH: [] };
  let held = null;
  const decide = (d) => { const s = sig(d); if (s === null) return null; held = s; const w = {}; for (const a of ["BTC", "ETH"]) { const x = s[a]; w[a] = x === null || x === undefined ? 0 : x * size(a, d); if (w[a]) weightsSeen[a].push(Math.abs(w[a])); } return w; };
  for (const [w0, w1] of WINDOWS) {
    const from = Date.parse(w0), to = Date.parse(w1);
    const r = simulatePerp([data.BTC, data.ETH], decide, { capital: 100, compound, margin: MARGIN, band: 0.25, ...cost }, { from, to });
    const row = { hypothesis: hn, sizing: sn, cost: cn, compound, window: `${w0}..${w1}`, final: r2(r.final), cagr_pct: r2(r.cagr_pct), dd_pct: r2(r.dd_pct), liquidations: r.liquidations, ruined: r.ruined, fees: r2(r.fees), funding: r2(r.funding), slippage: r2(r.slipCost), missed: r.missed, trades: r.trades,
      p14: periodStats(r.daily, 14), p30: periodStats(r.daily, 30), p91: periodStats(r.daily, 91), p365: periodStats(r.daily, 365), longest_recovery_days: r2(longestRecoveryDays(r.daily)),
      worst_day_pct: r2(Math.min(...r.daily.slice(1).map((x, i) => (x[1] / r.daily[i][1] - 1) * 100))), status: "THEORETICAL PAPER ONLY" };
    if (w0 === "2017-01-01") row.cycles = CYCLES.map(([n, a, b]) => { const s = r.daily.filter(([t]) => t >= Date.parse(a) && t < Date.parse(b)); if (s.length < 2) return { cycle: n }; let pk = s[0][1], md = 0; for (const [, v] of s) { pk = Math.max(pk, v); md = Math.max(md, 1 - v / pk); } return { cycle: n, ret_pct: r2((s.at(-1)[1] / s[0][1] - 1) * 100), close_dd_pct: r2(md * 100) }; });
    rows.push(row);
  }
  // minimum executable capital (whole NinjaTrader perp-style contracts, overnight margin, 15 % buffer)
  const ex = {};
  for (const a of ["BTC", "ETH"]) {
    const ws = weightsSeen[a].sort((x, y) => x - y); if (!ws.length) continue;
    const typical = ws[ws.length >> 1], cn = NT.contractUnits[a] * NT.price[a];
    const one = cn / typical, five = 5 * one;
    const marginNeed = (C) => { const k = Math.max(1, Math.round((typical * C) / cn)); return (k * NT.overnight[a]) / 0.85; };
    ex[a] = { typical_weight: r2(typical), contract_notional: r2(cn), capital_for_1_contract: r2(Math.max(one, marginNeed(one))), capital_for_5_contracts: r2(Math.max(five, marginNeed(five))), leverage_allowed_by_NT_overnight_margin: r2(cn / NT.overnight[a]), this_leverage_allowed: typical <= cn / NT.overnight[a] };
  }
  for (const row of rows.filter((x) => x.hypothesis === hn && x.sizing === sn && x.cost === cn && x.compound === compound)) row.executable = ex;
}
const cand = [...new Set(rows.map((r) => `${r.hypothesis}|${r.sizing}`))].filter((k) => { const rs = rows.filter((r) => `${r.hypothesis}|${r.sizing}` === k && r.cost === "conservative" && r.compound && !r.sizing.startsWith("EXPL")); return rs.length === 3 && rs.every((r) => r.dd_pct <= 15) && rs[0].cagr_pct >= 15 && rs[2].final > 100; });
writeFileSync(OUT, JSON.stringify({ status: "THEORETICAL PAPER ONLY", prereg: "docs/research/futures/PERP-PREREGISTRATION.md", candidates: cand, rows }, null, 1) + "\n");
for (const r of rows) console.log(`${r.hypothesis.slice(0, 26).padEnd(26)} ${r.sizing.padEnd(15)} ${r.cost.slice(0, 5)} ${r.compound ? "cmp" : "fix"} ${r.window.slice(0, 7)} $${String(r.final).padStart(9)} ${String(r.cagr_pct).padStart(7)}%/yr DD ${String(r.dd_pct).padStart(6)}% liq ${r.liquidations} rec ${r.longest_recovery_days}d`);
console.log("CANDIDATES:", JSON.stringify(cand));

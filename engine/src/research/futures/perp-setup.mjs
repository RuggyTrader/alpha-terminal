// Shared setup (data, proxy funding, signals, sizing, costs) for run-perp.mjs and the audit. Moved verbatim from
// run-perp.mjs; behaviour unchanged (verified: identical results file before/after).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken } from "../lab/data.mjs";
import { sma } from "../dd2/bt.mjs";
import { HOUR, DAY } from "./perp.mjs";

export function setup(KR, SIG) {
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
  return { data, prev, SIGNALS, SIZING, COSTS, MARGIN, NT, WINDOWS, CYCLES };
}

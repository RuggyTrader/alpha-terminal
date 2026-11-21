// INDEPENDENT reproduction of the corrected S3 results (actual-weight rebalancing band). This file deliberately shares
// NO code with src/research/select/: its own data merge, indicators, execution and accounting, written separately,
// then compared with docs/research/strategy-select/select-results.json. Skips when the (git-ignored) data is absent.
//   ALPHA_DATA=<engine/data> node --test test/select-s3-independent.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.ALPHA_DATA ?? null; // the git-ignored research data folder (engine/data); no default path
const RESULTS = JSON.parse(readFileSync(join(HERE, "..", "..", "docs", "research", "strategy-select", "select-results.json"), "utf8"));
const ONE_DAY = 864e5;

function candles(asset) {
  const files = [join(DATA, "strategy-select", `${asset}-USD-86400-pre2021.json`), join(DATA, "research2", `${asset}-USD-86400.json`)];
  const byDay = {};
  for (const f of files) if (existsSync(f)) for (const k of JSON.parse(readFileSync(f, "utf8")).candles) byDay[k.t] = k;
  return Object.keys(byDay).map(Number).sort((a, b) => a - b).map((t) => byDay[t]);
}

/** One sleeve of S3, written independently: decide at close i, trade at open i+1, re-size when |target - actual| >= band. */
function sleeve(K, startMs, endMs, capital, { fee = 0.002, slip = 0.0005, band = 0.1, target = 0.4, n = 200 } = {}) {
  let cash = capital, coins = 0, wanted = null, lastTarget = 0;
  const marks = new Map();
  for (let i = 0; i < K.length; i++) {
    const k = K[i];
    if (k.t >= endMs) break;
    const live = k.t >= startMs;
    if (wanted !== null && live) {
      const valueAtOpen = cash + coins * k.o, change = wanted * valueAtOpen - coins * k.o;
      if (change > 0) { const p = k.o * (1 + slip), q = Math.min(change / p, cash / (p * (1 + fee))); if (q > 0) { cash -= q * p * (1 + fee); coins += q; lastTarget = wanted; } }
      else if (change < 0) { const p = k.o * (1 - slip), q = Math.min(-change / p, coins); if (q > 0) { cash += q * p * (1 - fee); coins -= q; if (coins < 1e-12) coins = 0; lastTarget = wanted; } }
      wanted = null;
    }
    if (live) marks.set(k.t, cash + coins * k.c);
    if (i < n - 1 || i < 31 || !live || i + 1 >= K.length) continue;
    let sum = 0; for (let j = i - n + 1; j <= i; j++) sum += K[j].c;
    let tw = 0;
    if (k.c > sum / n) {
      const r = []; for (let j = i - 29; j <= i; j++) r.push(Math.log(K[j].c / K[j - 1].c));
      const m = r.reduce((a, b) => a + b, 0) / 30, sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / 29) * Math.sqrt(365);
      tw = sd > 0 ? Math.min(1, target / sd) : 1;
    }
    const value = cash + coins * k.c, actual = value > 0 ? (coins * k.c) / value : 0;
    const enterOrLeave = (lastTarget === 0) !== (tw === 0);
    if ((enterOrLeave || Math.abs(tw - actual) >= band) && (tw !== lastTarget || Math.abs(tw - actual) >= band)) wanted = tw;
  }
  return marks;
}

function book(assets, startMs, endMs, opts) {
  const each = 100 / assets.length, sleeves = assets.map((a) => sleeve(candles(a), startMs, endMs, each, opts));
  const last = sleeves.map(() => each), curve = [];
  for (let t = Math.ceil(startMs / ONE_DAY) * ONE_DAY; t < endMs; t += ONE_DAY) { sleeves.forEach((s, j) => { if (s.has(t)) last[j] = s.get(t); }); curve.push(last.reduce((a, b) => a + b, 0)); }
  let hi = 0, dd = 0; for (const v of curve) { hi = Math.max(hi, v); dd = Math.max(dd, 1 - v / hi); }
  const rets = curve.slice(1).map((v, j) => v / curve[j] - 1), mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  return { net: curve.at(-1) - 100, mdd_pct: dd * 100, sharpe: (mean / sd) * Math.sqrt(365) };
}

const have = !!DATA && existsSync(join(DATA, "strategy-select", "BTC-USD-86400-pre2021.json"));
describe("corrected S3: independent reproduction of the reported results", { skip: !have && "set ALPHA_DATA to the research data folder (engine/data) to run this reproduction" }, () => {
  const close = (a, b, rel, label) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${label}: independent ${a.toFixed(3)} vs reported ${b}`);
  it("untouched period 2016-01-01..2021-05-31, BTC + ETH: net, max drawdown and Sharpe match", () => {
    const r = book(["BTC", "ETH"], Date.parse("2016-01-01"), Date.parse("2021-06-01")), rep = RESULTS.sensitivity_S3_actual_weight_band.untouched;
    close(r.net, rep.net, 0.01, "net"); close(r.mdd_pct, rep.mdd_pct, 0.01, "max drawdown"); close(r.sharpe, rep.sharpe, 0.01, "Sharpe");
  });
  it("seen period 2021-06-01..2026-11-14, BTC + ETH + SOL: net, max drawdown and Sharpe match", () => {
    const r = book(["BTC", "ETH", "SOL"], Date.parse("2021-06-01"), Date.parse("2026-11-15")), rep = RESULTS.sensitivity_S3_actual_weight_band.seen;
    close(r.net, rep.net, 0.01, "net"); close(r.mdd_pct, rep.mdd_pct, 0.01, "max drawdown"); close(r.sharpe, rep.sharpe, 0.01, "Sharpe");
  });
  it("stress costs (0.40% + 0.10%) on the untouched period match", () => {
    const r = book(["BTC", "ETH"], Date.parse("2016-01-01"), Date.parse("2021-06-01"), { fee: 0.004, slip: 0.001 });
    close(r.net, RESULTS.sensitivity_S3_actual_weight_band.untouched_stress.net, 0.01, "stress net");
  });
});

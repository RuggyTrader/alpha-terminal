// The owner's OFFICIAL 2 % drawdown definition (docs/research/OFFICIAL-DRAWDOWN.md): measured from the high-water mark of
// TOTAL equity (cash + positions incl. unrealized P&L, after fees and slippage), including intraday highs and lows, with
// the worst-case intrabar order (a bar's high before its low). Every research backtester reports it as dd_official_pct.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backtestGZ } from "../src/research/lab/gz.mjs";
import { backtestWick } from "../src/research/lab/wick.mjs";
import { backtest } from "../src/research/dd2/bt.mjs";

const DAYMS = 86_400_000, HOURMS = 3_600_000, T0 = Date.parse("2024-01-01");
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("official drawdown: an intraday high raises the high-water mark (exact case)", () => {
  // full exposure from day 1's open at 100; day 1 trades up to 120 and back to 100 within the bar
  const K = [
    { t: T0, o: 100, h: 100, l: 100, c: 100 },
    { t: T0 + DAYMS, o: 100, h: 120, l: 100, c: 101 },
    { t: T0 + 2 * DAYMS, o: 101, h: 101, l: 101, c: 101 },
  ];
  const r = backtestGZ([{ name: "X", K, target: () => 1 }], { m: 0, fixedK: 1 }, { fee: 0, spread: 0, minUsd: 0 }, { from: T0, to: T0 + 3 * DAYMS });
  close(r.dd_official_pct, (1 - 100 / 120) * 100, 1e-9); // official: 16.67 %
  close(r.dd_pct, (1 - 100 / 101) * 100, 1e-9);           // close-peak measure: only 0.99 % (misses the 120 high)
});

test("official drawdown is never smaller than the close-peak strict measure (all three backtesters)", () => {
  // deterministic pseudo-random walk
  let s = 7; const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const daily = [], hourly = []; let p = 100;
  for (let i = 0; i < 600; i++) { const o = p; p *= Math.exp((rnd() - 0.48) * 0.06); const h = Math.max(o, p) * (1 + rnd() * 0.02), l = Math.min(o, p) * (1 - rnd() * 0.02); daily.push({ t: T0 + i * DAYMS, o, h, l, c: p }); }
  p = 100;
  for (let i = 0; i < 3000; i++) { const o = p; p *= Math.exp((rnd() - 0.5) * 0.02); const h = Math.max(o, p) * (1 + rnd() * 0.01), l = Math.min(o, p) * (1 - rnd() * 0.03); hourly.push({ t: T0 + i * HOURMS, o, h, l, c: p }); }
  const bt = backtest([{ name: "X", K: daily, minQty: 0 }], { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 }, { from: T0, to: T0 + 600 * DAYMS, fee: 0.002, slip: 0.0025, stopSlip: 0.0025, minCost: 0 });
  assert.ok(bt.dd_official_pct >= bt.dd_pct - 1e-12, `bt ${bt.dd_official_pct} < ${bt.dd_pct}`);
  const gz = backtestGZ([{ name: "X", K: daily, target: () => 1 }], { m: 0, fixedK: 1 }, { fee: 0.002, spread: 0.0025, minUsd: 0 }, { from: T0, to: T0 + 600 * DAYMS });
  assert.ok(gz.dd_official_pct >= gz.dd_pct - 1e-12);
  const w = backtestWick([{ name: "X", H: hourly, vol: () => 0.02 }], { z: 1, m: 0.5, holdH: 24, r: 1, cap: 1 }, { fee: () => ({ maker: 0.002, taker: 0.002 }), minUsd: 0, exitSlip: () => 0.001 }, { from: T0, to: T0 + 3000 * HOURMS });
  assert.ok(w.n_trades > 0); assert.ok(w.dd_official_pct >= w.dd_pct - 1e-12);
});

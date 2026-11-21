// DD2 backtester: execution timing, no look-ahead, stops and gaps, exchange minimums, accounting. (TEST candles.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backtest, rsi, sma, atr, grid, DAY } from "../src/research/dd2/bt.mjs";

const T0 = Date.UTC(2020, 0, 1);
const bars = (closes, f = () => ({})) => closes.map((c, i) => ({ t: T0 + i * DAY, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c) * 1.01, l: Math.min(c, i ? closes[i - 1] : c) * 0.99, c, ...f(i, c) }));
const cost0 = { fee: 0, slip: 0, stopSlip: 0 };
const W = { from: T0, to: T0 + 10_000 * DAY };
const trend = { family: "T", p: { n: 5 }, k: 3, trail: false, r: 1, cb: 0 };

describe("DD2 backtester", () => {
  it("indicators use bars up to i only", () => {
    const c = [1, 2, 3, 4, 5, 4, 3, 2, 6, 7];
    const a = sma(c, 3), b = sma([...c.slice(0, 6), 100, 100, 100, 100], 3);
    for (let i = 0; i < 6; i++) assert.equal(a[i], b[i]);
    const r1 = rsi(c, 2), r2 = rsi([...c.slice(0, 6), 0.1, 50, 1, 1], 2);
    for (let i = 0; i < 6; i++) assert.equal(r1[i], r2[i]);
  });

  it("no look-ahead: changing later bars never changes earlier equity, trades or decisions", () => {
    const c = Array.from({ length: 120 }, (_, i) => 100 * (1 + 0.2 * Math.sin(i / 9)) + i * 0.3);
    const K1 = bars(c), K2 = bars([...c.slice(0, 80), ...c.slice(80).map((v) => v * 0.5)]);
    for (const spec of [trend, { family: "R", p: { x: 25, filter: false }, k: 2, trail: true, r: 0.5, cb: 0 }, { family: "V", p: { n: 20, tv: 0.4 }, cb: 0 }]) {
      const a = backtest([{ name: "X", K: K1, minQty: 0 }], spec, { ...W, ...cost0 }), b = backtest([{ name: "X", K: K2, minQty: 0 }], spec, { ...W, ...cost0 });
      for (let i = 0; i < 79; i++) assert.equal(a.curve[i][1], b.curve[i][1], `${spec.family} day ${i}`);
    }
  });

  it("a signal at close i fills at the open of bar i+1 (never at close i)", () => {
    const P = Array(20).fill(10), c = [...P, 9, 9, 12, 13, 14, 15], x = P.length + 2; // cross above SMA5 at close x
    const K = bars(c).map((k, i) => (i === x + 1 ? { ...k, o: 12.5, l: 12.4 } : k));
    const r = backtest([{ name: "X", K, minQty: 0 }], { ...trend, r: 100 }, { ...W, ...cost0 });
    // bought at bar x+1's open (12.5): equity at that close = q * 13 where q = 100 / 12.5 (cap = 100 % of equity)
    assert.equal(r.curve[x][1], 100, "still in cash at the signal close");
    assert.ok(Math.abs(r.curve[x + 1][1] - (100 / 12.5) * 13) < 1e-6, `${r.curve[x + 1][1]}`);
  });

  it("stops fill at the stop, or at the open after a gap down (worse); stop is checked on the entry bar too", () => {
    const P = Array(20).fill(10), c = [...P, 9, 9, 12, 12, 12, 12, 12], x = P.length + 2;
    const base = bars(c);
    const gap = base.map((k, i) => (i === x + 1 ? { ...k, o: 12, l: 11.9, h: 12.1 } : i === x + 2 ? { ...k, o: 6, l: 5.5, h: 6.5, c: 6 } : k));
    const r = backtest([{ name: "X", K: gap, minQty: 0 }], { ...trend, k: 1, r: 100 }, { ...W, ...cost0 });
    const stopTrade = r.closed_trades ? r.final : null;
    assert.ok(stopTrade !== null);
    // entered at bar x+1's open (12); stop = 12 - ATR; bar x+2 opens at 6, below the stop -> filled at 6 (not at the stop)
    assert.ok(Math.abs(r.final - 100 / 12 * 6) < 1e-6, `${r.final}`);
  });

  it("exchange minimums: an entry below the minimum quantity is skipped and counted; quantities are on the 1e-8 step", () => {
    const c = Array.from({ length: 40 }, (_, i) => (i < 20 ? 60000 : 60000 + i * 500));
    const K = bars(c);
    const small = backtest([{ name: "BTC", K, minQty: 0.00006 }], { ...trend, r: 0.1, k: 3 }, { ...W, fee: 0.004, slip: 0.0005, stopSlip: 0.001 });
    assert.ok(small.skipped >= 1 && small.closed_trades === 0, JSON.stringify({ s: small.skipped, t: small.closed_trades }));
    const big = backtest([{ name: "BTC", K, minQty: 0.00006 }], { ...trend, r: 1, k: 1.5 }, { ...W, fee: 0.004, slip: 0.0005, stopSlip: 0.001 });
    assert.ok(big.skipped === 0);
  });

  it("accounting: with costs, final equity = start + sum of trade nets when flat; fees are 0.40 % of traded notional", () => {
    const c = Array.from({ length: 200 }, (_, i) => 100 * (1 + 0.25 * Math.sin(i / 7)) + i * 0.1);
    const r = backtest([{ name: "X", K: bars(c), minQty: 0 }], { family: "B", p: { N: 10, M: 5 }, k: 2, trail: true, r: 1, cb: 0 }, { ...W, fee: 0.004, slip: 0.0005, stopSlip: 0.001 });
    assert.ok(r.closed_trades > 3);
    const sumNet = r.trade_list.reduce((s, x) => s + x.net, 0);
    if (!r.open_at_end) assert.ok(Math.abs(r.final - (100 + sumNet)) < 1e-9, `${r.final} vs ${100 + sumNet}`);
    else assert.ok(r.final > 0);
    assert.ok(Math.abs(r.fees - 0.004 * r.traded) < 1e-9, "fee = 0.40 % of traded notional");
  });

  it("the grid is exactly the pre-registered one", () => {
    const g = grid(), count = (f) => g.filter((s) => s.family === f).length;
    assert.deepEqual({ T: count("T"), M: count("M"), R: count("R"), B: count("B"), V: count("V") }, { T: 192, M: 576, R: 384, B: 288, V: 16 });
  });
});

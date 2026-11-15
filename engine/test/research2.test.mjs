// Research round 2 execution model: no lookahead, next-bar-open entries, gap-through stops, fees on both fills, venue minimums.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, metrics, buyHold, to4h } from "../src/research/r2.mjs";

const H = 3_600_000;
const PAD = 20; // flat history first, so the 14-bar ATR exists
const bars = (cl, { gapAt = null, gapTo = null } = {}) => [...Array(PAD).fill(100), ...cl].map((c, i, closes) => {
  const prev = i ? closes[i - 1] : c;
  const o = gapAt !== null && i === gapAt + PAD ? gapTo : prev;
  return { t: i * H, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c };
});
const run = (K, { p = {}, ...o } = {}) => simulate({ K, barMs: H, family: "donchian", capital: 100, asset: "BTC", fee: 0.2, slip: 0.1, riskPct: 2, fromMs: 0, toMs: Infinity, ...o, p: { n: 3, m: 2, k: 2, trail: 0, short: false, ...p } });

test("a breakout on bar i is entered at bar i+1's open (plus slippage), never at bar i's close", () => {
  const closes = [100, 100, 100, 100, 104, 110, 111, 112, 113, 114];
  const K = bars(closes, { gapAt: 5, gapTo: 108 });
  const r = run(K);
  assert.ok(r.trades.length >= 1);
  const t = r.trades[0];
  assert.equal(t.entryT, K[5 + PAD].t, "entered at the bar after the signal bar (4)");
  assert.ok(Math.abs(t.entry - 108 * 1.001) < 1e-9, "at that bar's open + 0.1 % slippage");
});

test("a stop gapped through fills at the (worse) open, then slippage; fees on entry and exit", () => {
  const closes = [100, 100, 100, 100, 104, 105, 106, 90, 90, 90];
  const K = bars(closes, { gapAt: 7, gapTo: 91 });
  const r = run(K, { p: { k: 1 } });
  const t = r.trades.find((x) => x.reason === "stop");
  assert.ok(t, "stopped out");
  assert.ok(t.exit <= 91 * (1 - 0.001) + 1e-9, "no better than the gap open");
  const expectedFees = t.entry * t.qty * 0.002 + t.exit * t.qty * 0.002;
  assert.ok(Math.abs(t.fees - expectedFees) < 1e-9);
  assert.ok(Math.abs(t.net - (t.gross - t.fees)) < 1e-9);
  const m = metrics(r, 100);
  assert.ok(Math.abs(m.net - (r.end - 100)) < 0.01, "net = equity change");
});

test("position risk follows the stop distance (riskPct of equity) and never exceeds cash; tiny orders are skipped", () => {
  const closes = [100, 100, 100, 100, 104, 105, 106, 107, 108, 109];
  const K = bars(closes);
  const r = run(K, { p: { k: 1 } });
  const t = r.trades[0];
  assert.ok(t.notional <= 100, "fully paid, no leverage");
  const tiny = run(K, { capital: 0.5 });
  assert.equal(tiny.trades.length, 0); assert.ok(tiny.skipped.min > 0, "below the venue minimum: skipped and counted");
});

test("buy and hold pays one entry and one exit fill; 4h aggregation keeps real hours and counts partial buckets", () => {
  const K = bars([100, 110, 120, 130]);
  const b = buyHold(K, { capital: 100, fee: 0.2, slip: 0, fromMs: 0, toMs: Infinity });
  assert.ok(Math.abs(b.net - (100 / (100 * 1.002) * 130 * 0.998 - 100)) < 0.01);
  const { candles, partial } = to4h([0, 1, 2, 3, 5, 6, 7].map((i) => ({ t: i * H, o: i, h: i + 1, l: i - 0.5, c: i + 0.5, v: 1 })));
  assert.equal(candles.length, 2); assert.equal(partial, 1, "the bucket missing hour 4 is reported");
  assert.deepEqual([candles[0].o, candles[0].c, candles[0].h], [0, 3.5, 4]);
});

// Round 10 hooks in dd2/bt.mjs: family H (constant target) and spec.overlay (drawdown-floor multiplier). Hand-computed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backtest } from "../src/research/dd2/bt.mjs";
import { floorOverlay, rolling } from "../src/research/round10/round10-lib.mjs";

const D = 86_400_000, T0 = Date.parse("2020-01-01");
const bars = (closes) => closes.map((c, i) => ({ t: T0 + i * D, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c), l: Math.min(c, i ? closes[i - 1] : c), c, v: 1 }));
const opt = { from: T0, to: T0 + 100 * D, fee: 0, slip: 0, stopSlip: 0, minCost: 0 };
const asset = (closes) => [{ name: "X", K: bars(closes), minQty: 0 }];

test("family H at scale 0.07: buys 7 % at the next open and holds it", () => {
  const r = backtest(asset([100, 100, 100, 100]), { family: "H", p: {}, cb: 0, scale: 0.07 }, opt);
  assert.equal(r.trades, 1); assert.ok(Math.abs(r.final - 100) < 1e-9);
  const r2 = backtest(asset([100, 100, 200, 200]), { family: "H", p: {}, cb: 0, scale: 0.07 }, opt);
  assert.ok(Math.abs(r2.final - (93 + 7 * 2)) < 1e-6, String(r2.final)); // 7 bought at 100 on day 1, doubled
});

test("overlay 0 keeps the account in cash; overlay 0.5 halves the position", () => {
  assert.equal(backtest(asset([100, 100, 200]), { family: "H", p: {}, cb: 0, overlay: () => 0 }, opt).final, 100);
  const r = backtest(asset([100, 100, 200, 200]), { family: "H", p: {}, cb: 0, overlay: () => 0.5 }, opt);
  assert.ok(Math.abs(r.final - 150) < 1e-6, String(r.final));
});

test("floorOverlay: m x cushion, cushion = (E - (1-D) HWM) / E, clamped to [0, 1]", () => {
  const o = floorOverlay(0.15, 2);
  assert.ok(Math.abs(o({ eqC: 100, hwm: 100 }) - 0.3) < 1e-12);
  assert.ok(Math.abs(o({ eqC: 90, hwm: 100 }) - 2 * (90 - 85) / 90) < 1e-12);
  assert.equal(o({ eqC: 84, hwm: 100 }), 0);
  assert.equal(floorOverlay(0.9, 2)({ eqC: 100, hwm: 100 }), 1);
});

test("rolling h-day returns: median, 5th percentile and worst", () => {
  const curve = [100, 110, 99, 121, 121].map((v, i) => [i * D, v]);
  const r = rolling(curve, 1);
  assert.equal(r.n, 4); assert.ok(Math.abs(r.worst_pct - -10) < 1e-9); assert.ok(Math.abs(r.median_pct - 10) < 1e-9); // returns -10, 0, +10, +22.2 -> upper median +10
});

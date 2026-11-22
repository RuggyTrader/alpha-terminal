// Tests for the Grossman-Zhou drawdown-budget overlay (research lab).
import { test } from "node:test";
import assert from "node:assert/strict";
import { backtestGZ } from "../src/research/lab/gz.mjs";

const D = 86_400_000, T0 = Date.parse("2024-01-01");
const mk = (closes, lows) => closes.map((c, i) => ({ t: T0 + i * D, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c), l: lows?.[i] ?? Math.min(c, i ? closes[i - 1] : c), c }));
const zero = { fee: 0, spread: 0, minUsd: 0 };
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("gz: initial exposure is m x alpha of equity, bought at the next open with fee and spread", () => {
  const K = mk([100, 100, 100]);
  const r = backtestGZ([{ name: "X", K, target: () => 1 }], { m: 2 }, { fee: 0.002, spread: 0.0025, minUsd: 0 }, { from: T0, to: T0 + 3 * D });
  // day 0 close: k = 2 x 0.02 = 0.04 -> buy $4 notional at day-1 open 100 x 1.0025, fee 0.2 %
  const px = 100 * 1.0025, q = Math.floor((4 / px) / 1e-8 + 1e-9) * 1e-8;
  assert.equal(r.orders, 1); close(r.fees, q * px * 0.002, 1e-12);
  close(r.final, 100 - q * px * 1.002 + q * 100, 1e-9);
});

test("gz: exposure falls to zero as equity reaches the floor (98 % of peak)", () => {
  // exposure 100 % (m large) so the price path drives equity straight to the floor
  const K = mk([100, 100, 99, 98, 97, 96]);
  const r = backtestGZ([{ name: "X", K, target: () => 1 }], { m: 50, band: 0 }, zero, { from: T0, to: T0 + 6 * D });
  assert.ok(r.dd_close_pct <= 2.0 + 1e-9, `close drawdown ${r.dd_close_pct}`);
});

test("gz: with exposure capped by the cushion, a 1-day fall smaller than 1/m cannot breach the floor", () => {
  const K = mk([100, 100, 100, 70, 70], [100, 100, 100, 70, 70]); // a 30 % one-day fall; m = 2 -> loss <= 2 x 2 % x 30 % = 1.2 %
  const r = backtestGZ([{ name: "X", K, target: () => 1 }], { m: 2 }, zero, { from: T0, to: T0 + 5 * D });
  assert.ok(r.dd_pct < 2, `strict drawdown ${r.dd_pct}`); assert.ok(r.dd_pct > 1.0);
});

test("gz: no look-ahead (results up to T do not depend on later bars)", () => {
  const base = [100, 101, 103, 102, 104, 106];
  const a = backtestGZ([{ name: "X", K: mk(base), target: () => 1 }], { m: 2 }, zero, { from: T0, to: T0 + 6 * D });
  const b = backtestGZ([{ name: "X", K: mk([...base, 10, 1]), target: () => 1 }], { m: 2 }, zero, { from: T0, to: T0 + 6 * D });
  assert.equal(a.final, b.final); assert.equal(a.dd_pct, b.dd_pct);
});

test("gz: orders below the minimum are skipped", () => {
  const r = backtestGZ([{ name: "X", K: mk([100, 100, 100]), target: () => 1 }], { m: 2 }, { fee: 0, spread: 0, minUsd: 5 }, { from: T0, to: T0 + 3 * D });
  assert.equal(r.orders, 0); assert.ok(r.skipped >= 1); assert.equal(r.final, 100);
});

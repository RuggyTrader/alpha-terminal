// Gap-reversion backtester: hand-computed cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backtestGap } from "../src/research/discovery/gap.mjs";

const D = 86_400_000, T0 = Date.parse("2024-01-01");
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
// global price 100 USD, fx 1 -> fair CAD price 100; Ndax premium normally 0
function market(ndaxCloses, ndaxOpens, extra = {}) {
  const bars = ndaxCloses.map((c, i) => ({ t: T0 + i * D, o: ndaxOpens[i], h: Math.max(c, ndaxOpens[i]), l: Math.min(c, ndaxOpens[i]), c, v: 1000 }));
  const ref = new Map(bars.map((b) => [b.t, { o: 100, c: 100 }])), fx = new Map(bars.map((b) => [b.t, { o: 1, c: 1 }]));
  return { name: "X", bars, ref, fx, cSide: 0.001, cost: 0.01, ...extra };
}
const base = Array(5).fill(100);

test("cheap close (-2 %) still cheap at next open -> buy; reverts -> sell at the following open; exact P&L", () => {
  const closes = [...base, 98, 100, 100], opens = [...base, 100, 98.5, 100];
  const r = backtestGap([market(closes, opens)], { f: 1, slots: 1, win: 5, minVol: 0, fee: 0.002 }, { from: T0, to: T0 + 8 * D });
  assert.equal(r.trades.length, 1);
  const buyPx = 98.5 * 1.001, notional = 100 / 1.002, qty = notional / buyPx, sellPx = 100 * 0.999; // fee must fit in cash
  close(r.trades[0].net, qty * sellPx * 0.998 - notional * 1.002, 1e-9);
  assert.equal(r.trades[0].reason, "REVERTED");
});

test("stale-print guard: a cheap close that is NOT cheap at the next open is missed", () => {
  const closes = [...base, 98, 100, 100], opens = [...base, 100, 100, 100];
  const r = backtestGap([market(closes, opens)], { f: 1, slots: 1, win: 5, minVol: 0 }, { from: T0, to: T0 + 8 * D });
  assert.equal(r.trades.length, 0); assert.equal(r.missed, 1);
});

test("time stop: exits after `hold` bars if the gap never closes", () => {
  const closes = [...base, 97, 97, 97, 97, 97], opens = [...base, 100, 97, 97, 97, 97];
  const r = backtestGap([market(closes, opens)], { f: 1, slots: 1, win: 5, minVol: 0, hold: 2 }, { from: T0, to: T0 + 10 * D });
  assert.equal(r.trades[0].reason, "TIME");
});

test("volume filter and sizing: f/slots of equity; low-volume signal ignored", () => {
  const closes = [...base, 98, 100, 100], opens = [...base, 100, 98.5, 100];
  const m = market(closes, opens); m.bars[5].v = 1; // C$98 traded: below a C$10k filter
  assert.equal(backtestGap([m], { f: 1, slots: 1, win: 5, minVol: 10_000 }, { from: T0, to: T0 + 8 * D }).trades.length, 0);
  const r = backtestGap([market(closes, opens)], { f: 0.5, slots: 1, win: 5, minVol: 0 }, { from: T0, to: T0 + 8 * D });
  close(r.trades[0].net + 50 * 1.002, (50 / (98.5 * 1.001)) * 100 * 0.999 * 0.998, 1e-9); // $50 position
});

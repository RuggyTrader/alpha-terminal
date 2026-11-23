// One-contract Micro Ether simulator: hand-computed cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateMET, cmeOpen, HOUR, DAY } from "../src/research/futures/met.mjs";

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
const NOCOST = { fee: 0, spread: 0, stopSlip: 0, basisAnnual: 0, hours: "247" };

test("CME session calendar: weekends closed before 2026-05-29, open 24/7 after (except Sat maintenance)", () => {
  assert.equal(cmeOpen(Date.parse("2025-03-08T12:00:00Z")), false); // Saturday
  assert.equal(cmeOpen(Date.parse("2025-03-09T22:00:00Z")), false); // Sunday before reopen
  assert.equal(cmeOpen(Date.parse("2025-03-09T23:00:00Z")), true);  // Sunday reopen
  assert.equal(cmeOpen(Date.parse("2025-03-11T22:00:00Z")), false); // daily maintenance hour
  assert.equal(cmeOpen(Date.parse("2026-06-06T12:00:00Z")), true);  // Saturday after 24/7 launch
  assert.equal(cmeOpen(Date.parse("2026-06-06T08:00:00Z")), false); // Saturday maintenance window
});

test("long one contract: P&L is 0.1 x price change, fees per side", () => {
  const t0 = Date.parse("2026-07-01T00:00:00Z");
  const H = [bar(t0, 1000, 1010, 990, 1005), bar(t0 + HOUR, 1005, 1020, 1000, 1015), bar(t0 + DAY, 1050, 1060, 1040, 1055)];
  const r = simulateMET(H, (d) => ({ pos: d === t0 ? 1 : 0 }), { ...NOCOST, fee: 0.69 }, { from: t0, to: t0 + 2 * DAY });
  close(r.final, 100 + 0.1 * (1050 - 1000) - 2 * 0.69); assert.equal(r.trades, 1);
});

test("short one contract gains when price falls", () => {
  const t0 = Date.parse("2026-07-01T00:00:00Z");
  const H = [bar(t0, 1000, 1001, 990, 995), bar(t0 + DAY, 900, 905, 895, 900)];
  const r = simulateMET(H, (d) => ({ pos: d === t0 ? -1 : 0 }), NOCOST, { from: t0, to: t0 + 2 * DAY });
  close(r.final, 110);
});

test("weekend gap (pre-24/7): a stop is filled at the Sunday reopen price, not at the stop", () => {
  const fri = Date.parse("2025-03-07T00:00:00Z"); // Friday
  const H = [bar(fri, 1000, 1000, 1000, 1000), bar(Date.parse("2025-03-08T12:00:00Z"), 1000, 1000, 700, 800), bar(Date.parse("2025-03-09T23:00:00Z"), 850, 860, 840, 850)];
  const r = simulateMET(H, () => ({ pos: 1, stopPct: 0.05 }), { ...NOCOST, hours: "cme" }, { from: fri, to: fri + 3 * DAY });
  assert.equal(r.log[0].why, "STOP"); close(r.log[0].exit, 850); // the Saturday bar is invisible to the futures
  close(r.final, 100 + 0.1 * (850 - 1000));
});

test("liquidation when equity at the bar's worst price falls below the threshold (fee charged)", () => {
  const t0 = Date.parse("2026-07-01T00:00:00Z");
  const H = [bar(t0, 1000, 1000, 1000, 1000), bar(t0 + HOUR, 1000, 1000, 400, 450)];
  const r = simulateMET(H, () => ({ pos: 1 }), { ...NOCOST, liqThreshold: 50 }, { from: t0, to: t0 + 2 * HOUR });
  assert.equal(r.liquidations, 1); close(r.final, 100 + 0.1 * (400 - 1000) - 25); // equity 40 < 50 -> liquidated, $25 fee
});

test("the 2x reading (threshold $100) liquidates a $100 account on the first adverse move", () => {
  const t0 = Date.parse("2026-07-01T00:00:00Z");
  const H = [bar(t0, 1000, 1000, 999, 1000)];
  const r = simulateMET(H, () => ({ pos: 1 }), { ...NOCOST, liqThreshold: 100, openMin: 100 }, { from: t0, to: t0 + HOUR });
  assert.equal(r.liquidations, 1);
});

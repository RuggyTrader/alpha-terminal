// 10x "+100 % / -100 %" trade simulator: take-profit, liquidation (adverse first), costs and sequential account logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tradeOnce, runAccount } from "../src/research/candles/ten-x.mjs";

const C = { openBps: 6, closeBps: 6, imbalanceBpsPerSide: 0, borrowHourly: { SOL: 1.5e-5, USDC: 6e-6 }, borrowMultiplier: 1, networkUsdPerTx: 0, delaySlipBps: 0, stopSlipBps: 0, longCollateralSwapBps: 0 };
const bars = (rows) => ({ t: Float64Array.from(rows.map((_, i) => i * 300_000)), o: Float64Array.from(rows.map((r) => r[0])), h: Float64Array.from(rows.map((r) => r[1])), l: Float64Array.from(rows.map((r) => r[2])), c: Float64Array.from(rows.map((r) => r[3])) });

test("a +10 % move at 10x roughly doubles $10; fees and borrow are deducted", () => {
  const b = bars([[100, 100, 100, 100], [100, 111, 99.5, 110]]);
  const r = tradeOnce(b, 0, 1, { collateral: 10, lev: 10, tpMove: 0.1, c: C });
  assert.equal(r.reason, "TAKE_PROFIT"); assert.ok(r.net > 9.8 && r.net < 10, String(r.net)); // +$10 minus ~$0.12 fees and borrow
});

test("a -10 % move liquidates the whole $10, and the adverse extreme is checked first in the same bar", () => {
  const b = bars([[100, 100, 100, 100], [100, 111, 89, 100]]); // both TP and liquidation touched: liquidation assumed first
  const r = tradeOnce(b, 0, 1, { collateral: 10, lev: 10, tpMove: 0.1, c: C });
  assert.equal(r.reason, "LIQUIDATED"); assert.equal(r.net, -10);
  const s = tradeOnce(bars([[100, 100, 100, 100], [100, 100.5, 89, 90]]), 0, -1, { collateral: 10, lev: 10, tpMove: 0.1, c: C });
  assert.equal(s.reason, "TAKE_PROFIT"); // a short wins on the drop
});

test("account: one position at a time; 10 % sizing compounds; ruin when equity cannot fund $10", () => {
  const rows = []; for (let i = 0; i < 40; i++) rows.push(i % 2 ? [100, 100, 89, 90] : [100, 100, 100, 100]);
  const b = bars(rows), sig = Array.from({ length: 20 }, (_, i) => ({ k: 2 * i, side: 1 }));
  const r = runAccount(b, sig, { sizing: "fixed10", lev: 10, tpMove: 0.1, c: C });
  assert.ok(r.trades <= 10 && r.liquidations === r.trades); assert.ok(r.final < 11); assert.ok(r.hit75);
});

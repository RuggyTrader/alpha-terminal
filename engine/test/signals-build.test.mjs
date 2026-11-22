// Round S signal construction: no look-ahead, correct arithmetic, and statistics checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DAY, fundingSignal, mean7, netflowSignal, growth30, forwardReturn, spearman, quintiles, blockBootstrap } from "../src/research/signals/build.mjs";

const d = Date.parse("2021-06-15T00:00:00Z");
test("funding signal uses only fundingTime < d and the last 7 days", () => {
  const rows = []; for (let t = d - 10 * DAY; t <= d + 2 * DAY; t += DAY / 3) rows.push([t, t < d ? 0.0001 : 0.5]);
  assert.ok(Math.abs(fundingSignal(rows)(d) - 0.0001) < 1e-15); // values at or after d (0.5) never enter
  assert.equal(fundingSignal(rows.filter(([t]) => t < d - 6 * DAY))(d), null); // too few observations
});
test("daily-window signals use days d-7..d-1 only", () => {
  const m = new Map(); for (let k = -40; k <= 5; k++) m.set(d + k * DAY, k >= 0 ? 1e9 : k);
  assert.equal(mean7(m)(d), (-1 - 2 - 3 - 4 - 5 - 6 - 7) / 7);
  const sup = new Map([[d - DAY, 110], [d - 31 * DAY, 100], [d, 1e9]]);
  assert.ok(Math.abs(growth30(sup)(d) - 0.1) < 1e-12);
  const inM = new Map(), outM = new Map(); for (let k = 1; k <= 7; k++) { inM.set(d - k * DAY, 3); outM.set(d - k * DAY, 1); } inM.set(d, 1e9);
  assert.equal(netflowSignal(inM, outM, new Map([[d - DAY, 1400]]))(d), 14 / 1400);
});
test("forward return runs from the open of d to the open of d+7", () => {
  const bars = new Map([[d, { o: 100 }], [d + 7 * DAY, { o: 110 }]]);
  assert.ok(Math.abs(forwardReturn(bars)(d) - Math.log(1.1)) < 1e-12);
});
test("statistics: Spearman, quintiles and bootstrap behave as expected", () => {
  const x = Array.from({ length: 100 }, (_, i) => i), y = x.map((v) => v * 2 + 1);
  assert.equal(spearman(x, y), 1); assert.equal(spearman(x, y.map((v) => -v)), -1);
  const q = quintiles(x, y); assert.ok(q.top_minus_bottom > 0);
  const b = blockBootstrap(x, y, spearman, { reps: 200 }); assert.ok(b.lo99 > 0.99);
});

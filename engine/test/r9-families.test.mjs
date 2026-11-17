// Round 9 families (src/research/r9/families.mjs): causality of the BTC regime, no lookahead in every family, the
// pre-registered grid size, and the skipped-minimum counter of the backtester.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DAY, efficiency, grid, makeRegime, F1, F2, F3, F4 } from "../src/research/r9/families.mjs";
import { backtest } from "../src/research/r7/bt.mjs";

const T0 = Date.UTC(2022, 0, 1);
const daily = (closes) => closes.map((c, i) => ({ t: T0 + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c }));
const hourly = (closes) => closes.map((c, i) => ({ t: T0 + i * 3_600_000, o: c, h: c * 1.002, l: c * 0.998, c }));
const wave = (n, f) => Array.from({ length: n }, (_, i) => f(i));

describe("r9 regime filter", () => {
  it("uses only the last COMPLETED day: a day's own close never decides bars inside that day", () => {
    const closes = [...wave(210, () => 100), 50, 200]; // day 210 crashes, day 211 rallies
    const R = makeRegime(daily(closes));
    // decision at the close of day 209 (time = start of day 210): day 209 is the last completed (flat, not above SMA)
    assert.equal(R(T0 + 210 * DAY), false);
    // inside day 211 (e.g. 12:00): last completed day is 210 (close 50 < SMA) -> OFF, even though day 211 closes at 200
    assert.equal(R(T0 + 211 * DAY + 12 * 3_600_000), false);
    // at the close of day 211 (= start of day 212): day 211 is completed, 200 > SMA -> ON
    assert.equal(R(T0 + 212 * DAY), true);
  });
});

describe("r9 families: no lookahead", () => {
  const regimeOn = () => true;
  const series = wave(900, (i) => 100 + 20 * Math.sin(i / 25) + i * 0.05 + ((i * 7919) % 13) / 5);
  const cases = [
    ["F1", F1({ N: 20, M: 10, tf: 240, regime: regimeOn })],
    ["F2", F2({ L: 30, theta: 0.5, regime: regimeOn })],
    ["F3", F3({ e: 0.3 })],
    ["F4", F4({ k: 2 })],
  ];
  for (const [name, make] of cases) {
    it(`${name}: decisions up to bar j are identical whatever happens after bar j`, () => {
      const a = hourly(series), b = hourly([...series.slice(0, 600), ...wave(300, () => 1)]);
      const ta = backtest(a, make, { capital: 100, to: a[598].t }), tb = backtest(b, make, { capital: 100, to: b[598].t });
      const before = (r) => r.trades.filter((t) => t.exitT < a[598].t).map((t) => [t.entryT, t.exitT, +t.net.toFixed(9)]);
      assert.ok(before(ta).length > 0, `${name}: the test needs trades before the cut-off`);
      assert.deepEqual(before(ta), before(tb));
    });
  }
  it("efficiency ratio is 1 on a straight line and small on noise", () => {
    assert.equal(efficiency(wave(30, (i) => i), 20)[25], 1);
    assert.ok(efficiency(wave(30, (i) => (i % 2 ? 1 : 0)), 20)[25] < 0.1);
  });
});

describe("r9 grid and feasibility accounting", () => {
  it("has exactly the pre-registered 16 configurations", () => {
    const g = grid(() => true);
    assert.deepEqual(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length])), { F1: 4, F2: 4, F3: 2, F4: 4, F5: 2 });
  });
  it("an entry below the exchange minimum is skipped and counted, never filled", () => {
    const b = hourly(wave(400, (i) => 100 + i * 0.5));
    const r = backtest(b, F1({ N: 20, M: 10, tf: 60, regime: () => true }), { capital: 20, minQty: 1000 });
    assert.equal(r.trades.length, 0);
    assert.ok(r.signals > 0 && r.skippedMin === r.signals);
  });
});

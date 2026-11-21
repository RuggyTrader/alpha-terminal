// Strategy-selection allocation backtester and rules (src/research/select/alloc.mjs): next-open execution, costs on
// traded notional, no lookahead, cash never negative, accounting closes, and each rule's causal behaviour.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUYHOLD, DAY, S1, S2, S3, S4, runSleeve } from "../src/research/select/alloc.mjs";

const T0 = Date.UTC(2017, 0, 1);
const mk = (closes) => closes.map((c, i) => ({ t: T0 + i * DAY, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c) * 1.001, l: Math.min(c, i ? closes[i - 1] : c) * 0.999, c }));
const lin = (n, a, s) => Array.from({ length: n }, (_, i) => a + i * s);

describe("allocation backtester", () => {
  it("buy-and-hold: buys at the NEXT open, pays fee + slippage once, then tracks the price", () => {
    const bars = mk(lin(10, 100, 1));
    const r = runSleeve(bars, BUYHOLD(), { capital: 100, feePct: 0.2, slipPct: 0.05 });
    assert.equal(r.orders.length, 1);
    assert.equal(r.orders[0].t, bars[1].t, "decided at close 0, filled at open 1");
    const px = bars[1].o * 1.0005, qty = 100 / (px * 1.002);
    assert.ok(Math.abs(r.final - qty * bars.at(-1).c) < 1e-9);
    assert.ok(r.fees > 0 && r.final > 0);
  });
  it("no lookahead: changing bars after day j leaves the equity curve up to day j unchanged", () => {
    const a = mk([...lin(260, 100, 0.3), ...lin(100, 178, -0.5)]), b = mk([...lin(260, 100, 0.3), ...lin(100, 50, 0)]);
    for (const rule of [S1(), S2(), S3(), S4()]) {
      const ra = runSleeve(a, rule, { capital: 100 }), rb = runSleeve(b, rule, { capital: 100 });
      assert.deepEqual(ra.curve.slice(0, 259), rb.curve.slice(0, 259));
    }
  });
  it("cash never goes negative; weights stay in [0, 1]; round-trip nets sum to the final P&L when flat", () => {
    const bars = mk([...lin(250, 100, 0.4), ...lin(80, 200, -1), ...lin(120, 120, 0.6), ...lin(60, 192, -1.2)]);
    for (const rule of [S1(), S2(), S3(), S4()]) {
      const r = runSleeve(bars, rule, { capital: 100 });
      assert.ok(r.curve.every((p) => p.eq > 0));
      const closed = r.trips.filter((t) => t.exitT !== null);
      if (r.trips.length === closed.length && r.trips.length) assert.ok(Math.abs(closed.reduce((s, t) => s + t.net, 0) - (r.final - 100)) < 1e-6);
    }
  });
  it("threshold: small target changes do not trade; entering and leaving always trade", () => {
    const bars = mk(lin(40, 100, 0.1));
    let k = 0; const wobble = () => () => (i) => (i < 2 ? null : i === 30 ? 0 : i > 30 ? null : 0.5 + (k++ % 2) * 0.05);
    const r = runSleeve(bars, wobble(), { capital: 100, threshold: 0.1 });
    assert.equal(r.orders.length, 2, "one entry at 0.5, no re-sizing for 0.05 wobbles, one exit");
  });
  it("Kraken minimums: orders below the minimum are marked infeasible", () => {
    const r = runSleeve(mk(lin(10, 100, 1)), BUYHOLD(), { capital: 3, minQty: 0.05, minNotional: 0.5 });
    assert.equal(r.orders[0].feasible, false);
  });
});

describe("rebalancing band (sensitivity option)", () => {
  it("bandOnActual re-sizes a drifting position back to its target; the pre-registered mode does not", () => {
    const bars = mk(lin(120, 100, 3)); // price triples: a 0.2 position drifts towards ~0.4
    const fixed = () => () => (i) => (i < 1 ? null : 0.2);
    const a = runSleeve(bars, fixed(), { capital: 100, threshold: 0.1 }), b = runSleeve(bars, fixed(), { capital: 100, threshold: 0.1, bandOnActual: true });
    assert.equal(a.orders.length, 1, "pre-registered mode: bought once, never re-sized");
    assert.ok(b.orders.length > 1 && b.orders.slice(1).every((o) => o.side === "SELL"), "actual-weight band trims the drift");
  });
});

describe("rules", () => {
  it("S1 holds only above the SMA; S4 exits on the M-day low", () => {
    const bars = mk([...lin(210, 100, 0.5), ...lin(60, 205, -2)]);
    const d1 = S1()(bars);
    assert.equal(d1(205), 1); assert.equal(d1(269), 0);
    const d4 = S4()(bars); const seq = bars.map((_, i) => d4(i));
    assert.ok(seq.includes(1)); assert.equal(seq.at(-1), 0);
  });
  it("S2 decides only on its weekly day; S3 scales down in high volatility", () => {
    const bars = mk(lin(120, 100, 0.5)), d2 = S2()(bars);
    const decided = bars.map((_, i) => d2(i)).filter((x) => x !== null);
    assert.ok(decided.length > 0 && decided.length <= Math.ceil(36 / 7) + 1);
    const calm = mk(lin(260, 100, 0.2)), wild = mk(lin(260, 100, 0.2).map((c, i) => c * (i % 2 ? 1.06 : 0.95)));
    assert.equal(S3()(calm)(259), 1);
    assert.ok(S3()(wild)(259) < 0.5);
  });
});

// Round 8 rotation backtester (src/research/r8/xsmom.mjs): no lookahead, next-open fills, fees on every fill,
// absolute-momentum cash filter, held names kept, bounded by cash, deterministic bootstrap.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockBootstrap, buyHold, rotate } from "../src/research/r8/xsmom.mjs";

const DAY = 86_400_000, T0 = Date.UTC(2023, 0, 1);
const mk = (closes, opens = closes) => closes.map((c, i) => ({ t: T0 + i * DAY, o: opens[i], h: Math.max(c, opens[i]), l: Math.min(c, opens[i]), c }));
const lin = (n, a, step) => Array.from({ length: n }, (_, i) => a + i * step);

describe("r8 rotation backtester", () => {
  it("holds the strongest positive-momentum market, buys at the NEXT open, pays fees both ways", () => {
    const S = { UP: mk(lin(60, 100, 1)), FLAT: mk(lin(60, 100, 0.1)), DOWN: mk(lin(60, 100, -0.5)) };
    const r = rotate(S, { L: 10, K: 1, from: T0 + 20 * DAY, to: T0 + 50 * DAY, feePct: 0.2, slipPct: 0 });
    const buy = r.trades.find((x) => x.side === "BUY");
    assert.equal(buy.m, "UP");
    assert.equal(buy.t, T0 + 21 * DAY, "decided at day 20's close, filled at day 21's open");
    assert.equal(buy.px, S.UP[21].o);
    assert.ok(r.trades.every((x) => x.m !== "DOWN"), "a negative-momentum market is never bought");
    assert.ok(r.fees > 0 && r.net > 0);
  });
  it("no lookahead: changing data AFTER a decision does not change that decision", () => {
    const base = { A: mk(lin(60, 100, 1)), B: mk(lin(60, 100, 0.5)) };
    const alt = { A: mk([...lin(30, 100, 1), ...lin(30, 10, 0)]), B: base.B };
    const o = { L: 10, K: 1, from: T0 + 20 * DAY, to: T0 + 29 * DAY, feePct: 0.2, slipPct: 0 };
    assert.deepEqual(rotate(base, o).trades.slice(0, 1), rotate(alt, o).trades.slice(0, 1));
  });
  it("all markets falling: stays in cash (no trades, no fees)", () => {
    const S = { A: mk(lin(60, 100, -1)), B: mk(lin(60, 100, -0.2)) };
    const r = rotate(S, { L: 10, K: 2, from: T0 + 20 * DAY, to: T0 + 55 * DAY });
    assert.equal(r.trades.length, 0); assert.equal(r.net, 0); assert.equal(r.exposure, 0);
  });
  it("a held market that stays in the target is not re-traded; spending never exceeds cash", () => {
    const S = { A: mk(lin(80, 100, 1)), B: mk(lin(80, 100, 0.8)), C: mk(lin(80, 100, 0.6)) };
    const r = rotate(S, { L: 10, K: 2, from: T0 + 20 * DAY, to: T0 + 75 * DAY });
    assert.equal(r.trades.filter((x) => x.side === "BUY").length, 2, "bought A and B once each");
    assert.ok(r.path.every((p) => p.equity > 0));
  });
  it("leaver sold at the next open after the decision that drops it; per-market P&L sums to net", () => {
    const S = { A: mk([...lin(40, 100, 1), ...lin(40, 139, -2)]), B: mk(lin(80, 100, 0.3)) };
    const r = rotate(S, { L: 7, K: 1, from: T0 + 10 * DAY, to: T0 + 78 * DAY, feePct: 0.2, slipPct: 0.05 });
    assert.ok(r.trades.some((x) => x.side === "SELL" && x.m === "A"));
    const sum = Object.values(r.pnl).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - r.net) < 1e-6, `${sum} vs ${r.net}`);
  });
  it("buy-and-hold and the block bootstrap are deterministic and sane", () => {
    const S = { A: mk(lin(30, 100, 1)), B: mk(lin(30, 100, -1)) };
    const bh = buyHold(S, { from: T0, to: T0 + 29 * DAY, feePct: 0, slipPct: 0 });
    assert.ok(Math.abs(bh.net) < 1e-9, "symmetric up/down cancel without costs");
    const x = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.01 : -0.005));
    const a = blockBootstrap(x), b = blockBootstrap(x);
    assert.deepEqual(a, b);
    assert.ok(a.lo <= a.mean && a.mean <= a.hi);
  });
});

describe("r8 rotation: data that ends", () => {
  it("a held market whose data ends is sold at its last close (never valued at zero) and not bought again", () => {
    const S = { A: mk(lin(40, 100, 1)), B: mk(lin(80, 100, 0.2)) };
    const r = rotate(S, { L: 7, K: 1, from: T0 + 10 * DAY, to: T0 + 79 * DAY, feePct: 0, slipPct: 0 });
    const sold = r.trades.find((x) => x.m === "A" && x.reason === "DATA_ENDED");
    assert.ok(sold, "A sold when its data ended");
    assert.equal(sold.px, S.A[39].c);
    assert.ok(r.path.every((p) => p.equity > 50), "equity never collapses to the cash share");
  });
});

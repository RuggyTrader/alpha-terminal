// Round 8 portfolio backtester: shared cash, sizing scenarios A-D, exchange minimums with recorded rejections,
// next-open fills, no lookahead, and the cross-sectional rotation's information boundary.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REJECT, backtestPortfolio, blockBootstrap, isolatedSleeves, minEquityForTrade, monthlyReturns, sizeEntry, summarizePortfolio } from "../src/research/r8/portfolio.mjs";
import { CANDIDATES, P3, rotationRanks } from "../src/research/r8/families.mjs";

const DAY = 86_400_000;
const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
const flat = (n, p = 100, t0 = 0, step = 1) => Array.from({ length: n }, (_, i) => bar(t0 + i * step, p, p, p, p));
const enterAt = (k, stop) => () => (i, pos) => (!pos && i === k ? { enter: { stop } } : null);

describe("sizeEntry", () => {
  const base = { equity: 100, cash: 100, px: 100, stop: 95, openRisk: 0, openCount: 0, fee: 0.002 };
  it("B risk sizing: equity x risk / stop distance, capped by cash", () => {
    assert.equal(sizeEntry({ ...base, scenario: "risk", s: { riskPct: 2 } }).qty, 0.4); // $2 / $5
    const capped = sizeEntry({ ...base, stop: 99.9, scenario: "risk", s: { riskPct: 2 } }).qty; // $2/$0.1 = 20 units > cash
    assert.ok(capped * 100 * 1.002 <= 100 + 1e-9);
  });
  it("C fixed fraction ignores the stop distance", () => {
    assert.equal(sizeEntry({ ...base, scenario: "fixed_fraction", s: { fractionPct: 20 } }).qty, 0.2);
  });
  it("below the exchange minimum the entry is rejected with a reason, never forced (B)", () => {
    const r = sizeEntry({ ...base, scenario: "risk", s: { riskPct: 2 }, min: { minQty: 1, minCost: 0.5 } });
    assert.equal(r.reject, REJECT.BELOW_MIN_QTY);
    const c = sizeEntry({ ...base, scenario: "risk", s: { riskPct: 2 }, min: { minQty: 0, minCost: 50 } });
    assert.equal(c.reject, REJECT.BELOW_MIN_COST);
  });
  it("D may raise to the minimum only inside the per-trade and total risk budgets", () => {
    const s = { riskPct: 1, maxRiskPct: 3, openRiskPct: 5, maxNotionalPct: 50, allowRaiseToMin: true };
    // wants 0.2 units ($1 / $5); minimum 0.5 units -> risk $2.5 <= 3% of 100 -> raised
    const ok = sizeEntry({ ...base, scenario: "risk_budget", s, min: { minQty: 0.5 } });
    assert.deepEqual(ok, { qty: 0.5, raised: true });
    // minimum 0.7 units -> risk $3.5 > 3% -> rejected
    assert.equal(sizeEntry({ ...base, scenario: "risk_budget", s, min: { minQty: 0.7 } }).reject, REJECT.BELOW_MIN_QTY);
    // total budget already used -> rejected
    assert.equal(sizeEntry({ ...base, openRisk: 5, scenario: "risk_budget", s, min: {} }).reject, REJECT.RISK_BUDGET_FULL);
    // raising is not allowed when the flag is off
    assert.equal(sizeEntry({ ...base, scenario: "risk_budget", s: { ...s, allowRaiseToMin: false }, min: { minQty: 0.5 } }).reject, REJECT.BELOW_MIN_QTY);
  });
  it("max positions and invalid stops are rejected", () => {
    assert.equal(sizeEntry({ ...base, openCount: 3, scenario: "risk", s: { riskPct: 2, maxPositions: 3 } }).reject, REJECT.MAX_POSITIONS);
    assert.equal(sizeEntry({ ...base, stop: 101, scenario: "risk", s: { riskPct: 2 } }).reject, REJECT.STOP_INVALID);
  });
  it("quantities round DOWN to the lot precision", () => {
    assert.equal(sizeEntry({ ...base, stop: 97, scenario: "risk", s: { riskPct: 2 }, min: { lotDecimals: 2 } }).qty, 0.66);
  });
});

describe("backtestPortfolio", () => {
  it("fills at the next open with slippage and accounts gross, fees and net separately", () => {
    const b = flat(6); b[3] = bar(3, 110, 110, 110, 110); b[4] = bar(4, 120, 120, 120, 120); b[5] = bar(5, 120, 120, 120, 120);
    const make = () => (i, pos) => (!pos && i === 2 ? { enter: { stop: 50 } } : pos && i === 4 ? { exit: true } : null);
    const r = backtestPortfolio({ X: b }, make, { feePct: 0.2, slipPct: 0.1, scenario: "fixed_fraction", sizing: { fractionPct: 50 } });
    assert.equal(r.trades.length, 1);
    const t = r.trades[0];
    assert.equal(t.entry, 110 * 1.001);
    assert.equal(t.exit, 120 * 0.999);
    assert.ok(Math.abs(t.net - (t.gross - t.fees)) < 1e-9);
    assert.ok(Math.abs(r.final - 100 - t.net) < 1e-9, "cash reconciles to the trade's net");
  });
  it("shares cash across markets: a second entry is sized from what is left", () => {
    const s = { X: flat(5), Y: flat(5) };
    const r = backtestPortfolio(s, enterAt(1, 90), { feePct: 0, slipPct: 0, scenario: "fixed_fraction", sizing: { fractionPct: 80 } });
    assert.equal(r.trades.length, 2);
    const notional = r.trades.map((t) => t.entry * t.qty);
    assert.ok(Math.abs(notional[0] - 80) < 1e-6);
    assert.ok(notional[1] <= 20 + 1e-6, "the second market only gets the remaining cash");
  });
  it("records every rejected entry with its reason", () => {
    const r = backtestPortfolio({ X: flat(5) }, enterAt(1, 95), { scenario: "risk", sizing: { riskPct: 2 }, minimums: { X: { minQty: 5 } } });
    assert.equal(r.trades.length, 0);
    assert.equal(r.rejections.length, 1);
    assert.equal(r.rejections[0].reason, REJECT.BELOW_MIN_QTY);
    assert.equal(summarizePortfolio(r).executable_pct, 0);
  });
  it("stops fill at the stop or a worse gap open", () => {
    const b = flat(6); b[3] = bar(3, 80, 80, 70, 75);
    const r = backtestPortfolio({ X: b }, enterAt(1, 90), { feePct: 0, slipPct: 0, scenario: "fixed_fraction", sizing: { fractionPct: 50 } });
    assert.equal(r.trades[0].kind, "stop");
    assert.equal(r.trades[0].exit, 80, "gapped through the 90 stop -> filled at the 80 open");
  });
  it("no lookahead: changing a future bar cannot change earlier decisions or fills", () => {
    const mk = () => (bars) => (i, pos) => (!pos && bars[i].c > 100 ? { enter: { stop: 50 } } : null);
    const a = flat(8), b = flat(8); a[2] = bar(2, 100, 101, 100, 101); b[2] = a[2]; b[7] = bar(7, 1, 1, 1, 1);
    const ra = backtestPortfolio({ X: a }, mk(), { scenario: "fixed_fraction", sizing: { fractionPct: 10 } });
    const rb = backtestPortfolio({ X: b }, mk(), { scenario: "fixed_fraction", sizing: { fractionPct: 10 } });
    assert.deepEqual(ra.signals, rb.signals);
    assert.deepEqual(ra.curve.slice(0, 7), rb.curve.slice(0, 7));
  });
  it("scenario A runs each market in its own $20 wallet", () => {
    const out = isolatedSleeves({ X: flat(5), Y: flat(5) }, enterAt(1, 90), { feePct: 0, slipPct: 0 });
    assert.deepEqual(Object.keys(out), ["X", "Y"]);
    assert.equal(out.X.capital, 20);
    assert.equal(out.X.trades[0].qty * 10, 20 * 0.02); // $0.40 risk / $10 stop distance
  });
});

describe("rotation P3", () => {
  it("ranks only from closes at or before the rebalance day, and holds cash when no market has positive momentum", () => {
    const t0 = 7 * DAY * 10; // a rebalance day
    const up = Array.from({ length: 45 }, (_, i) => bar(t0 + i * DAY, 100 + i, 100 + i, 100 + i, 100 + i));
    const down = Array.from({ length: 45 }, (_, i) => bar(t0 + i * DAY, 200 - i, 200 - i, 200 - i, 200 - i));
    const sel = rotationRanks({ UP: up, DN: down }, { L: 30, K: 3 });
    const at = t0 + 35 * DAY;
    assert.deepEqual([...sel.get(at)], ["UP"]);
    // mutating a future close cannot change a past selection
    const up2 = up.map((b) => ({ ...b })); up2[44] = bar(up2[44].t, 1, 1, 1, 1);
    assert.deepEqual([...rotationRanks({ UP: up2, DN: down }).get(at)], ["UP"]);
    const rDown = rotationRanks({ DN: down });
    assert.equal(rDown.get(at).size, 0, "absolute momentum filter: cash in a falling market");
  });
  it("P3 exits a held market at the next open when it leaves the selection", () => {
    const sel = new Map([[0, new Set(["X"])], [3 * DAY, new Set()]]);
    const b = Array.from({ length: 20 }, (_, i) => bar(i * DAY, 100, 101, 99, 100));
    const r = backtestPortfolio({ X: b }, P3(sel), { scenario: "fixed_fraction", sizing: { fractionPct: 30 } });
    // ATR(14) is null before bar 13, so the entry at t=0 is not taken; use a later selection instead
    assert.equal(r.trades.length, 0);
    const sel2 = new Map([[14 * DAY, new Set(["X"])], [17 * DAY, new Set()]]);
    const r2 = backtestPortfolio({ X: b }, P3(sel2), { scenario: "fixed_fraction", sizing: { fractionPct: 30 } });
    assert.equal(r2.trades.length, 1);
    assert.equal(r2.trades[0].entryT, 15 * DAY);
    assert.equal(r2.trades[0].exitT, 18 * DAY);
    assert.equal(r2.trades[0].kind, "signal");
  });
  it("the candidate list is frozen: three LONG-only candidates with fixed ids", () => {
    assert.deepEqual(CANDIDATES.map((c) => c.id), ["R8-T1-240-55-20", "R8-M1-1440-30", "R8-P3-1440-30-3"]);
  });
});

describe("setup counting", () => {
  it("a rejected setup re-attempted on consecutive bars counts once; a later separate setup counts again", () => {
    let k = 0; const make = () => (i, pos) => (!pos && [1, 2, 3, 6].includes(i) ? { enter: { stop: 95 } } : null);
    const r = backtestPortfolio({ X: flat(10) }, make, { scenario: "risk", sizing: { riskPct: 2 }, minimums: { X: { minQty: 5 } } });
    const s = summarizePortfolio(r);
    assert.equal(s.signals, 4); assert.equal(s.setups, 2); assert.equal(s.executed_setups, 0); assert.equal(s.executable_pct, 0);
  });
});

describe("statistics", () => {
  it("monthly returns chain to the total return", () => {
    const curve = [{ t: Date.UTC(2024, 0, 1), eq: 100 }, { t: Date.UTC(2024, 0, 31), eq: 110 }, { t: Date.UTC(2024, 1, 28), eq: 99 }];
    const m = monthlyReturns(curve);
    assert.equal(m.length, 2);
    assert.ok(Math.abs(m.reduce((a, x) => a * (1 + x.ret), 1) - 0.99) < 1e-12);
  });
  it("block bootstrap is deterministic and brackets the mean", () => {
    const xs = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.02 : -0.01));
    const a = blockBootstrap(xs), b = blockBootstrap(xs);
    assert.deepEqual(a, b);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    assert.ok(a[0] <= mean && mean <= a[1]);
  });
  it("minimum equity for one trade: minNotional x stop / risk", () => {
    assert.equal(minEquityForTrade({ minNotional: 10, stopPct: 0.1, riskPct: 0.02 }), 50);
  });
});

// Round 7 research backtester: execution rules that make results trustworthy (no lookahead, next-open fills, stop-first
// ambiguity, gap fills, fee and short accounting, sizing caps, minimums).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backtest, bootstrap, priorHigh, sma, summarize } from "../src/research/r7/bt.mjs";
import { GRID } from "../src/research/r7/families.mjs";

const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
const flat = (n, p = 100) => Array.from({ length: n }, (_, i) => bar(i, p, p, p, p));
const enterAt = (k, stop) => () => (i, pos) => (!pos && i === k ? { enter: { stop } } : null);

describe("round 7 backtester", () => {
  it("fills a decision taken at bar i's close at bar i+1's open (with slippage), never at the decision bar", () => {
    const b = flat(5); b[3] = bar(3, 110, 110, 110, 110);
    const r = backtest(b, enterAt(2, 50), { feePct: 0, slipPct: 0.1 });
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].entry, 110 * 1.001);
  });
  it("no lookahead: changing bars after i cannot change decisions up to i", () => {
    const seen = [];
    const spy = (bars) => (i) => { seen.push(bars.slice(0, i + 1).map((x) => x.c).join(",")); return null; };
    const a = flat(6), b = flat(6); b[5] = bar(5, 1, 1, 1, 1);
    seen.length = 0; backtest(a, spy); const sa = [...seen];
    seen.length = 0; backtest(b, spy); const sb = [...seen];
    assert.deepEqual(sa.slice(0, 5), sb.slice(0, 5));
    // indicators: values at i use bars 0..i only
    const x = [1, 2, 3, 4, 100];
    assert.deepEqual(sma(x, 2).slice(0, 4), sma([1, 2, 3, 4, -999], 2).slice(0, 4));
    assert.equal(priorHigh([bar(0, 1, 5, 1, 1), bar(1, 1, 3, 1, 1), bar(2, 1, 9, 1, 1)], 2)[2], 5, "the prior range excludes the current bar");
  });
  it("a stop is filled at the stop, or at the open when the bar gaps through it; stop before target in one bar", () => {
    const b = flat(6); b[3] = bar(3, 100, 101, 95, 100);
    let r = backtest(b, enterAt(1, 96), { feePct: 0, slipPct: 0 });
    assert.equal(r.trades[0].exit, 96); assert.equal(r.trades[0].kind, "stop");
    const g = flat(6); g[3] = bar(3, 90, 91, 89, 90);
    r = backtest(g, enterAt(1, 96), { feePct: 0, slipPct: 0 });
    assert.equal(r.trades[0].exit, 90, "gap below the stop fills at the worse open");
  });
  it("fees are paid on both fills; net = gross - fees; equity ends at capital + net", () => {
    const b = flat(6); b[4] = bar(4, 110, 110, 110, 110); b[5] = bar(5, 110, 110, 110, 110);
    const ex = () => (i, pos) => (!pos && i === 1 ? { enter: { stop: 50 } } : pos && i === 3 ? { exit: true } : null);
    const r = backtest(b, ex, { feePct: 0.2, slipPct: 0 });
    const t = r.trades[0];
    assert.ok(Math.abs(t.fees - (t.entry * t.qty * 0.002 + t.exit * t.qty * 0.002)) < 1e-12);
    assert.ok(Math.abs(t.net - (t.gross - t.fees)) < 1e-12);
    assert.ok(Math.abs(r.final - (100 + t.net)) < 1e-9);
  });
  it("SHORT: profit when price falls; fully collateralised (never more notional than cash)", () => {
    const b = flat(6); b[4] = bar(4, 90, 90, 90, 90); b[5] = bar(5, 90, 90, 90, 90);
    const ex = () => (i, pos) => (!pos && i === 1 ? { enter: { stop: 200 } } : pos && i === 3 ? { exit: true } : null);
    const r = backtest(b, ex, { side: "SHORT", feePct: 0, slipPct: 0, riskPct: 100 });
    assert.ok(r.trades[0].gross > 0);
    assert.ok(r.trades[0].qty * r.trades[0].entry <= 100 + 1e-9);
  });
  it("risk sizing is capped by equity (no leverage) and exchange minimums skip trades", () => {
    const b = flat(6);
    let r = backtest(b, enterAt(1, 99.99), { feePct: 0, slipPct: 0, riskPct: 2 });
    assert.ok(r.trades[0].qty * r.trades[0].entry <= 100 + 1e-9);
    r = backtest(b, enterAt(1, 50), { minNotional: 500 });
    assert.equal(r.trades.length, 0);
  });
  it("summary and deterministic bootstrap", () => {
    assert.deepEqual(bootstrap([1, 2, 3, 4, 5]), bootstrap([1, 2, 3, 4, 5]));
    assert.equal(bootstrap([1, 2]), null);
    const s = summarize({ trades: [{ net: 1, gross: 1.2, fees: 0.2 }, { net: -2, gross: -1.8, fees: 0.2 }], final: 99, maxDD: 0.05, exposure: 0.5 });
    assert.equal(s.net, -1); assert.equal(s.pf, 0.5); assert.ok(Math.abs(s.fees - 0.4) < 1e-12);
  });
  it("the pre-registered grid has exactly the specified configurations", () => {
    assert.deepEqual(Object.fromEntries(Object.entries(GRID).map(([k, v]) => [k, v.map((x) => x.id)])), {
      T1: ["T1-240-20-10", "T1-240-55-20", "T1-1440-20-10", "T1-1440-55-20"], T2: ["T2-240-50", "T2-240-100", "T2-240-200", "T2-1440-50", "T2-1440-100", "T2-1440-200"],
      M1: ["M1-1440-30", "M1-1440-60", "M1-1440-120"], B1: ["B1-60", "B1-240"], R1: ["R1-60-2", "R1-60-2.5", "R1-240-2", "R1-240-2.5"] });
  });
});

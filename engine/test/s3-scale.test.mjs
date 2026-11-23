// The optional S3 size multiplier (spec.scale): default unchanged; 0.5 halves the target notional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backtest } from "../src/research/dd2/bt.mjs";

const D = 86_400_000, T0 = Date.parse("2020-01-01");
let s = 3; const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
const K = []; let p = 100; for (let i = 0; i < 500; i++) { const o = p; p *= Math.exp((rnd() - 0.45) * 0.04); K.push({ t: T0 + i * D, o, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99, c: p }); }
const run = (scale) => { const audit = []; const spec = { family: "V", p: { n: 200, tv: 0.4 }, cb: 0, ...(scale === undefined ? {} : { scale }) }; const r = backtest([{ name: "X", K, minQty: 0 }], spec, { from: T0, to: T0 + 500 * D, fee: 0, slip: 0, stopSlip: 0, minCost: 0, audit }); return { r, firstBuy: audit.find((x) => x.side === "BUY") }; };

test("scale defaults to 1 (unchanged) and 0.5 halves the first target position", () => {
  const a = run(), b = run(1), h = run(0.5);
  assert.equal(a.r.final, b.r.final);
  assert.ok(Math.abs(h.firstBuy.notional - a.firstBuy.notional / 2) < 1e-6, `${h.firstBuy.notional} vs ${a.firstBuy.notional / 2}`);
  assert.ok(h.r.dd_official_pct < a.r.dd_official_pct);
});

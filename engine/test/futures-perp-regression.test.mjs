// Regression tests for the perpetual-style simulator (synthetic data only, no private files):
//  * cross-check against the independent re-implementation on random paths, including liquidations;
//  * ledger identity (final = capital + price P&L - fees - slippage - funding);
//  * the v1 defect (per-unit fees at old low prices) cannot recur.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulatePerp, HOUR, DAY } from "../src/research/futures/perp.mjs";
import { simulateIndependent } from "../src/research/futures/perp-independent.mjs";

const T0 = Date.parse("2020-01-01T00:00:00Z");
function path(seed, n, p0, vol) { let s = seed >>> 0; const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32); const H = []; let p = p0; for (let i = 0; i < n; i++) { const o = p; p *= Math.exp((r() - 0.5) * vol); const h = Math.max(o, p) * (1 + r() * vol / 3), l = Math.min(o, p) * (1 - r() * vol / 3); H.push({ t: T0 + i * HOUR, o, h, l, c: p }); } return H; }
const COST = (mode) => ({ fee: { mode, pct: { A: 0.001, B: 0.003 }, perContract: { A: 0.5, B: 0.5 }, contract: { A: 0.01, B: 0.1 } }, spread: { A: 0.0002, B: 0.0006 }, slip: 0.0005, liqSlip: 0.003, missProb: mode === "ideal" ? 0 : 0.05, liqFee: { pct: 0.005, perContract: 10 } });
const MARGIN = { init: { A: 0.1, B: 0.1 }, maint: { A: 0.05, B: 0.05 } };

test("independent re-implementation agrees on random paths (all leverage levels, both cost modes, with liquidations)", () => {
  let liqSeen = 0;
  for (let k = 0; k < 24; k++) {
    const assets = [{ name: "A", H: path(11 + k, 24 * 120, 100, 0.03), funding: (t) => ((t / HOUR) % 7 - 3) * 1e-5 }, { name: "B", H: path(91 + k, 24 * 120, 10, 0.05), funding: () => 1.25e-5 }];
    const lev = [0.5, 1, 3, 6][k % 4];
    const decide = (t) => { const d = Math.floor(t / DAY); return { A: (d % 5 < 3 ? 1 : -1) * lev, B: (d % 3 === 0 ? -1 : 1) * lev * 0.7 }; };
    for (const mode of ["ideal", "conservative"]) for (const compound of [true, false]) {
      const cfg = { capital: 100, compound, margin: MARGIN, band: k % 2 ? 0.25 : 0, ...COST(mode) }, win = { from: T0, to: T0 + 120 * DAY };
      const a = simulatePerp(assets, decide, cfg, win), b = simulateIndependent(assets, decide, cfg, win);
      assert.ok(Math.abs(a.final - b.final) <= 1e-9 * Math.max(1, Math.abs(a.final)), `final ${a.final} vs ${b.final}`);
      assert.ok(Math.abs(a.dd_pct - b.dd_pct) <= 1e-9, `dd ${a.dd_pct} vs ${b.dd_pct}`);
      assert.equal(a.liquidations, b.liquidations);
      assert.ok(Math.abs(a.ledger_residual) < 1e-7, `ledger residual ${a.ledger_residual}`);
      liqSeen += a.liquidations;
    }
  }
  assert.ok(liqSeen > 0, "the test set must exercise liquidations");
});

test("v1 defect cannot recur: at an old low price, a fractional order pays max(% fee, $0.50), not $0.50 per historical unit", () => {
  // price $8 (ETH in early 2017): $50 of notional = 6.25 units = 62.5 'contracts' of 0.1 ETH under the v1 rule ($31.25)
  const H = Array.from({ length: 3 }, (_, i) => ({ t: T0 + i * HOUR, o: 8, h: 8, l: 8, c: 8 }));
  const r = simulatePerp([{ name: "B", H, funding: () => 0 }], (t) => (t === T0 ? { B: 0.5 } : null), { capital: 100, compound: true, margin: MARGIN, ...COST("conservative"), missProb: 0, spread: { A: 0, B: 0 }, slip: 0 }, { from: T0, to: T0 + 3 * HOUR });
  assert.ok(Math.abs(r.fees - 0.5) < 1e-12, `fees ${r.fees}`); // max(50 x 0.3 % = 0.15, 0.50) = 0.50
});

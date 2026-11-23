// Fractional perpetual-style simulator: accounting checks with hand-computed expectations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulatePerp, periodStats, longestRecoveryDays, HOUR, DAY } from "../src/research/futures/perp.mjs";

const T0 = Date.parse("2024-01-01T00:00:00Z");
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const flat = (n, px) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * HOUR, o: px, h: px, l: px, c: px }));
const asset = (H, rate = 0) => ({ name: "X", H, funding: () => rate });
const BASE = { capital: 100, compound: true, fee: { mode: "ideal", pct: { X: 0 }, perContract: { X: 0.5 }, contract: { X: 0.1 } }, spread: { X: 0 }, slip: 0, liqSlip: 0, missProb: 0, margin: { init: { X: 0.1 }, maint: { X: 0.05 } }, liqFee: { pct: 0, perContract: 10 } };
const run = (H, w, cfg = {}, hours = H.length) => simulatePerp([asset(H, cfg.rate ?? 0)], (t) => (t === T0 ? { X: w } : null), { ...BASE, ...cfg }, { from: T0, to: T0 + hours * HOUR });

test("long 1x: equity follows the price; short 1x gains when it falls", () => {
  const H = flat(3, 100); H[1] = { ...H[1], h: 110, c: 110 }; H[2] = { t: H[2].t, o: 110, h: 110, l: 110, c: 110 };
  close(run(H, 1).final, 110); close(run(H, -1).final, 90);
});

test("funding: a long pays units x price x rate every hour (shorts receive)", () => {
  const H = flat(10, 100);
  close(run(H, 1, { rate: 0.0001 }).final, 100 - 10 * 1 * 100 * 0.0001);
  close(run(H, -1, { rate: 0.0001 }).final, 100 + 10 * 1 * 100 * 0.0001);
});

test("ideal fees are a percentage of notional; conservative fees are charged per WHOLE contract", () => {
  const H = flat(2, 100);
  close(run(H, 0.3, { fee: { ...BASE.fee, pct: { X: 0.001 } } }).final, 100 - 30 * 0.001); // 0.3 units x 100 = $30 notional
  // 0.3 units with a 0.1 contract = 3 contracts x $0.50
  close(run(H, 0.3, { fee: { ...BASE.fee, mode: "conservative" } }).final, 100 - 1.5);
  // a tiny 0.05-unit position still pays a full contract's fee ($0.50): fixed fees are NOT scaled down
  close(run(H, 0.05, { fee: { ...BASE.fee, mode: "conservative" } }).final, 100 - 0.5);
});

test("spread and slippage cost half-spread + slip on the traded notional", () => {
  const H = flat(2, 100);
  close(run(H, 1, { spread: { X: 0.002 }, slip: 0.0005 }).final, 100 - 100 * (0.001 + 0.0005));
});

test("liquidation: 10x long, a 6 % intrabar fall breaches 5 % maintenance -> closed at the low, fee charged", () => {
  const H = flat(3, 100); H[1] = { t: H[1].t, o: 100, h: 100, l: 94, c: 99 };
  const r = run(H, 10, { liqFee: { pct: 0.005, perContract: 10 } });
  assert.equal(r.liquidations, 1);
  // 10 units: loss 10 x 6 = 60 -> equity 40; maintenance 10 x 94 x 5 % = 47 > 40 -> liquidated; ideal fee 0.5 % x 940
  close(r.final, 100 - 60 - 0.005 * 940);
});

test("initial margin caps gross exposure", () => {
  const H = flat(2, 100);
  const r = run(H, 20, { margin: { init: { X: 0.1 }, maint: { X: 0.05 } } }); // 20x wanted, 10x allowed
  close(r.final, 100); assert.equal(r.trades, 1);
  const H2 = flat(2, 100); H2[1] = { ...H2[1], h: 101, c: 101 };
  close(run(H2, 20).final, 100 + 10 * 1); // 10 units x $1
});

test("compounding sizes from equity; fixed sizing from starting capital", () => {
  const H = [...flat(24, 100)]; H[23] = { ...H[23], h: 150, c: 150 };
  for (let i = 0; i < 24; i++) H.push({ t: T0 + (24 + i) * HOUR, o: i ? 160 : 150, h: 160, l: 150, c: 160 });
  const decide = (t) => (t === T0 || t === T0 + DAY ? { X: 1 } : null);
  const c = simulatePerp([asset(H)], decide, { ...BASE, compound: true }, { from: T0, to: T0 + 48 * HOUR });
  const f = simulatePerp([asset(H)], decide, { ...BASE, compound: false }, { from: T0, to: T0 + 48 * HOUR });
  close(c.final, 150 + 1 * 10);                 // equity 150 -> 1 unit at 150 -> +10
  close(f.final, 150 + (100 / 150) * 10);       // fixed $100 notional -> 0.667 units -> +6.67
});

test("missed orders are skipped deterministically", () => {
  const r = run(flat(3, 100), 1, { missProb: 1 });
  assert.equal(r.trades, 0); assert.equal(r.missed, 1); close(r.final, 100);
});

test("period statistics and recovery time", () => {
  const daily = [[0, 100], [DAY, 110], [2 * DAY, 99], [3 * DAY, 105], [4 * DAY, 111]];
  const p = periodStats(daily, 2); assert.equal(p.n, 2); close(p.worst_pct, -1);
  assert.equal(longestRecoveryDays(daily), 3);
});

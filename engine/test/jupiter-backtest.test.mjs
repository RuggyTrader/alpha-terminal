// Jupiter Perps PAPER research: cost math, risk manager, corrected backtester (regressions for the perp.mjs defects),
// and strategy cross-validation against an independent implementation. Hand-computed expectations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openFee, closeFee, liquidationPrice, positionValue, borrowPerHour, impactBps } from "../src/research/jupiter/costs.mjs";
import { plan, requiredCash, stopPrice } from "../src/research/jupiter/risk.mjs";
import { runBacktest, rollingStats } from "../src/research/jupiter/backtest.mjs";
import { aggregate, strategyA, strategyB, sigmaAt, exposure, H, DAY } from "../src/research/jupiter/strategies.mjs";
import { strategyAIndependent, strategyBIndependent } from "../src/research/jupiter/strategies-independent.mjs";

const CFG = JSON.parse(readFileSync(new URL("../src/research/jupiter/config.frozen.json", import.meta.url), "utf8"));
const C0 = { ...CFG.costs.base, missProb: 0, stopFailProb: 0, delaySlipBps: 0, stopSlipBps: 0, networkUsdPerTx: 0, longCollateralSwapBps: 0 };
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const T0 = Date.parse("2024-01-01T00:00:00Z");
// a market from hourly closes; o = previous close, h/l = max/min(o, c) unless overridden
const mkt = (closes, over = {}) => { const rows = closes.map((c, i) => { const o = i ? closes[i - 1] : c; const r = [T0 + i * H, o, Math.max(o, c), Math.min(o, c), c, 1]; if (over[i]) Object.assign(r, over[i]); return r; }); return { rows, daily: aggregate(rows, DAY) }; };
const flatDaily = (n, px = 100) => Array.from({ length: n }, (_, i) => ({ t: T0 - (n - i) * DAY, o: px, h: px, l: px, c: px * (1 + (i % 2 ? 0.01 : -0.01)) })); // sigma ~ 0.38

test("cost math: 6 bps base, linear price impact, liquidation price makes the value equal size/500", () => {
  near(impactBps(1000, "SOL", C0), (1000 * 1e6 * 1e4) / 3.75e15);
  near(openFee(1000, "SOL", C0), 1000 * (6 + impactBps(1000, "SOL", C0)) / 1e4);
  const p = { asset: "BTC", side: "long", sizeUsd: 50, collateralUsd: 10, entry: 100, borrowAccrued: 0.2 };
  const lp = liquidationPrice(p, C0);
  near(p.collateralUsd + p.sizeUsd * (lp / 100 - 1) - closeFee(50, "BTC", C0) - 0.2, 50 / 500, 1e-9);
  const s = { ...p, side: "short" }, ls = liquidationPrice(s, C0);
  near(s.collateralUsd + s.sizeUsd * (1 - ls / 100) - closeFee(50, "BTC", C0) - 0.2, 0.1, 1e-9);
  near(borrowPerHour(100, "long", "SOL", C0), 100 * 1.496e-5); near(borrowPerHour(100, "short", "SOL", C0), 100 * 6.36e-6);
  assert.equal(positionValue(p, 1, C0), 0); // isolated margin: never below zero
});

test("risk: fee reservation BEFORE sizing (regression: perp.mjs sized first and deducted fees after)", () => {
  const c = { ...C0, networkUsdPerTx: 0.1, longCollateralSwapBps: 30 };
  const r = plan({ asset: "SOL", target: 1.1, sleeveEquity: 33.3, walletCash: 20, pos: null, pending: null, shutdown: false, L: 1.1, rm: CFG.riskManager, account: CFG.account, costs: c });
  assert.equal(r.type, "OPEN");
  assert.ok(requiredCash(r.collateralUsdDelta, "long", c) <= 20 - CFG.account.gasReserveUsd + 1e-9, "collateral + swap + 3 network fees fit after the gas reserve");
  assert.ok(r.leverage >= 1.1 - 1e-9 && r.leverage <= 1.1 + 1e-9);
  const tiny = plan({ asset: "SOL", target: 1.1, sleeveEquity: 33.3, walletCash: 12, pos: null, pending: null, shutdown: false, L: 1.1, rm: CFG.riskManager, account: CFG.account, costs: c });
  assert.equal(tiny.type, "NONE"); assert.match(tiny.reason, /collateral/);
});

test("risk: minimum collateral $10 x 1.1, leverage cap, duplicate guard, shutdown closes", () => {
  const base = { asset: "BTC", sleeveEquity: 33.3, walletCash: 100, pos: null, pending: null, shutdown: false, rm: CFG.riskManager, account: CFG.account, costs: C0 };
  assert.equal(plan({ ...base, target: 0.3, L: 1.1 }).type, "NONE");                // $10 notional < $11
  const o = plan({ ...base, target: 5, L: 5 }); assert.equal(o.type, "OPEN"); near(o.leverage, 5); near(o.sizeUsdDelta, 5 * 33.3);
  near(plan({ ...base, target: 9, L: 3 }).sizeUsdDelta, 3 * 33.3);                    // target clipped at the approved level
  assert.match(plan({ ...base, target: 1, L: 2, pending: { key: "x" } }).reason, /duplicate/);
  const pos = { asset: "BTC", side: "long", sizeUsd: 30, collateralUsd: 27, entry: 100, borrowAccrued: 0 };
  assert.equal(plan({ ...base, target: 1, L: 2, pos, shutdown: true }).type, "CLOSE");
  assert.equal(plan({ ...base, target: -1, L: 2, pos }).type, "CLOSE");              // side change -> close first
});

test("liquidation takes ALL remaining collateral (regression: perp.mjs charged a percentage liquidation fee)", () => {
  // one asset = one sleeve of $100; collateral $97 (the $3 gas reserve stays), 5x -> size $485, liquidation ~80.3.
  // Hour 3 GAPS open at 75, through both the stop (~90.1) and the liquidation price -> liquidated at the open
  const closes = [100, 100, 100, 75, 75], m = { BTC: { ...mkt(closes, { 3: [T0 + 3 * H, 75, 75, 75, 75, 1] }), signals: [{ t: T0 + H, signal: 1 }] } };
  m.BTC.daily = flatDaily(40);
  const r = runBacktest(m, { from: T0, to: T0 + 5 * H, L: 5, costs: { ...C0 }, config: { ...CFG, assets: ["BTC"], sizing: { ...CFG.sizing, volRefAnnual: 10 } }, assets: ["BTC"], shutdownEnabled: false });
  assert.equal(r.liquidations, 1);
  near(r.trade_list[0].sizeUsd, 485, 1e-6); near(r.trade_list[0].net, -97, 1e-9); // the whole $97 posted is lost
  near(r.final, 3, 1e-9);                                                          // only the gas reserve remains
  assert.ok(Math.abs(r.ledger_residual) < 1e-9 && Math.abs(r.equity_identity_residual) < 1e-9);
});

test("isolated margin: a liquidation on one asset leaves the other position untouched (regression: perp.mjs liquidated everything)", () => {
  const n = 6, btc = mkt([100, 100, 100, 70, 70, 70], { 3: [T0 + 3 * H, 70, 70, 70, 70, 1] }), eth = mkt([100, 100, 100, 101, 101, 101]); // BTC gaps through liquidation
  btc.daily = flatDaily(40); eth.daily = flatDaily(40);
  btc.signals = [{ t: T0 + H, signal: 1 }]; eth.signals = [{ t: T0 + H, signal: 1 }];
  const cfg = { ...CFG, assets: ["BTC", "ETH"], sizing: { ...CFG.sizing, volRefAnnual: 10 } };
  const r = runBacktest({ BTC: btc, ETH: eth }, { from: T0, to: T0 + n * H, L: 5, costs: C0, config: cfg, assets: ["BTC", "ETH"], shutdownEnabled: false });
  assert.equal(r.liquidations, 1); assert.deepEqual(r.open, ["ETH"]);
});

test("capital allocation from REALIZED collateral: an unrealized gain is not used to size a new position", () => {
  // BTC opens at 100 and doubles (unrealized); then ETH signals. ETH collateral must come from realized equity / 2 sleeves
  const btc = mkt([100, 100, 100, 200, 200, 200, 200]), eth = mkt([100, 100, 100, 100, 100, 100, 100]);
  btc.daily = flatDaily(40); eth.daily = flatDaily(40);
  btc.signals = [{ t: T0 + H, signal: 1 }]; eth.signals = [{ t: T0 + 4 * H, signal: 1 }];
  const cfg = { ...CFG, assets: ["BTC", "ETH"], sizing: { ...CFG.sizing, volRefAnnual: 10 } };
  const r = runBacktest({ BTC: btc, ETH: eth }, { from: T0, to: T0 + 7 * H, L: 1.1, costs: C0, config: cfg, assets: ["BTC", "ETH"], shutdownEnabled: false });
  assert.deepEqual(r.open.sort(), ["BTC", "ETH"]);
  // realized equity ~ $100 (marked ~ $155); ETH sleeve = realized / 2 = ~$50 -> notional ~ $55, further limited by the
  // spendable cash ($50 - $3 gas reserve = $47 collateral -> $51.7). Using the marked equity would have given ~ $85.
  const ethPos = r.positions.ETH; near(ethPos.sizeUsd, 47 * 1.1, 1e-6); assert.ok(ethPos.sizeUsd < 56, "sizing ignored the unrealized BTC gain");
  near(r.positions.BTC.sizeUsd, 55, 1e-9);
});

test("stops: gap through the stop fills at the open; a gap through liquidation is a liquidation; a failed stop is retried", () => {
  const cfg = { ...CFG, assets: ["SOL"], sizing: { ...CFG.sizing, volRefAnnual: 10 } };
  // 5x long at 100: liquidation ~80.3, stop ~90.1. Hour 3 opens at 88 (gap through the stop, not liquidation)
  const g = mkt([100, 100, 100, 88, 88], { 3: [T0 + 3 * H, 88, 88, 87, 88, 1] }); g.daily = flatDaily(40); g.signals = [{ t: T0 + H, signal: 1 }];
  const r1 = runBacktest({ SOL: g }, { from: T0, to: T0 + 5 * H, L: 5, costs: C0, config: cfg, assets: ["SOL"], shutdownEnabled: false });
  assert.equal(r1.trade_list[0].reason, "STOP_LOSS"); near(r1.trade_list[0].exit, 88);
  const l = mkt([100, 100, 100, 70, 70], { 3: [T0 + 3 * H, 70, 70, 69, 70, 1] }); l.daily = flatDaily(40); l.signals = [{ t: T0 + H, signal: 1 }];
  assert.equal(runBacktest({ SOL: l }, { from: T0, to: T0 + 5 * H, L: 5, costs: C0, config: cfg, assets: ["SOL"], shutdownEnabled: false }).liquidations, 1);
  const f = mkt([100, 100, 100, 89, 89, 89], { 3: [T0 + 3 * H, 100, 100, 89, 89, 1] }); f.daily = flatDaily(40); f.signals = [{ t: T0 + H, signal: 1 }];
  const r3 = runBacktest({ SOL: f }, { from: T0, to: T0 + 6 * H, L: 5, costs: { ...C0, stopFailProb: 1 }, config: cfg, assets: ["SOL"], shutdownEnabled: false });
  assert.ok(r3.counts.stopFailed >= 1); assert.equal(r3.counts.stopFired, 0); assert.equal(r3.liquidations, 0); // not yet at liquidation
});

test("borrow accrues hourly on the full size and is charged at close; ledger identities hold", () => {
  const cfg = { ...CFG, assets: ["ETH"], sizing: { ...CFG.sizing, volRefAnnual: 10 } };
  const closes = Array(14).fill(100), m = mkt(closes); m.daily = flatDaily(40);
  m.signals = [{ t: T0 + H, signal: 1 }, { t: T0 + 11 * H, signal: 0 }];
  const r = runBacktest({ ETH: m }, { from: T0, to: T0 + 14 * H, L: 1.1, costs: C0, config: cfg, assets: ["ETH"], shutdownEnabled: false });
  const size = 1.1 * 97; // one sleeve; collateral $97 after the $3 gas reserve, at the 1.1x minimum leverage
  near(r.trade_list[0].sizeUsd, size, 1e-9);
  near(r.fees.borrow, 10 * size * 1.3009e-5, 1e-9); // filled at hour 1's open, closed at hour 11's open -> 10 hourly accruals
  near(r.final, 100 - openFee(size, "ETH", C0) - closeFee(size, "ETH", C0) - r.fees.borrow, 1e-9);
  assert.ok(Math.abs(r.ledger_residual) < 1e-9 && Math.abs(r.equity_identity_residual) < 1e-9);
});

test("account shutdown at $75 closes everything at the next hour and can end BELOW $75 (no guaranteed loss limit)", () => {
  const cfg = { ...CFG, assets: ["BTC"], sizing: { ...CFG.sizing, volRefAnnual: 10 } };
  // one sleeve = all equity; 3x long; price falls 10 % (equity ~70 at the worst) then gaps another 5 % at the next open
  const m = mkt([100, 100, 100, 90, 85.5, 85.5], { 3: [T0 + 3 * H, 100, 100, 90, 90, 1] }); m.daily = flatDaily(40); m.signals = [{ t: T0 + H, signal: 1 }];
  const r = runBacktest({ BTC: m }, { from: T0, to: T0 + 6 * H, L: 3, costs: C0, config: { ...cfg, riskManager: { ...cfg.riskManager } }, assets: ["BTC"] });
  assert.ok(r.shutdown, "shutdown triggered"); assert.deepEqual(r.open, []);
  assert.ok(r.final < 75, `final ${r.final} is below the $75 trigger`);
});

test("no martingale: with a constant signal and volatility, a smaller account never gets a larger position", () => {
  const rm = CFG.riskManager, s1 = plan({ asset: "SOL", target: 2, sleeveEquity: 33, walletCash: 100, pos: null, pending: null, shutdown: false, L: 2, rm, account: CFG.account, costs: C0 });
  const s2 = plan({ asset: "SOL", target: 2, sleeveEquity: 25, walletCash: 75, pos: null, pending: null, shutdown: false, L: 2, rm, account: CFG.account, costs: C0 });
  assert.ok(s2.sizeUsdDelta < s1.sizeUsdDelta);
});

test("increase averages the entry price preserving token quantity (Jupiter USD-sized positions)", () => {
  const cfg = { ...CFG, assets: ["SOL"], sizing: { ...CFG.sizing, volRefAnnual: 10 } };
  const m = mkt([100, 100, 100, 100, 200, 200, 200]); m.daily = flatDaily(40);
  m.signals = [{ t: T0 + H, signal: 0.5 }, { t: T0 + 5 * H, signal: 1 }];
  const r = runBacktest({ SOL: m }, { from: T0, to: T0 + 7 * H, L: 2, costs: C0, config: cfg, assets: ["SOL"], shutdownEnabled: false });
  assert.equal(r.counts.increases, 1); assert.ok(Math.abs(r.ledger_residual) < 1e-9);
});

test("strategies match the independent implementation bar by bar (A both variants, B both variants)", () => {
  let x = 100, s = 11; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const rows = []; for (let i = 0; i < 24 * 400; i++) { const o = x; x *= Math.exp((rnd() - 0.5) * 0.02 + 0.0001); rows.push([T0 + i * H, o, Math.max(o, x) * (1 + rnd() * 0.003), Math.min(o, x) * (1 - rnd() * 0.003), x, 1]); }
  const b4 = aggregate(rows, 4 * H), d = aggregate(rows, DAY), A = CFG.strategies.A, B = CFG.strategies.B;
  for (const v of ["long_flat", "long_short"]) {
    const a1 = strategyA(b4, A, v), a2 = strategyAIndependent(b4, A.channelsDays, A.barsPerDay, A.exitFraction, v === "long_short");
    assert.equal(a1.length, a2.length); a1.forEach((p, i) => { assert.equal(p.t, a2[i][0]); assert.equal(p.signal, a2[i][1]); });
    assert.ok(a1.some((p) => p.signal !== 0));
    const b1 = strategyB(d, B, v), b2 = strategyBIndependent(d, B.lookbackDays, B.holdDays, B.anchor, v === "long_short");
    assert.equal(b1.length, b2.length); b1.forEach((p, i) => { assert.equal(p.t, b2[i][0]); assert.equal(p.signal, b2[i][1]); });
  }
});

test("sizing: sigma from completed daily bars only; exposure = signal x L x min(1, volRef / sigma)", () => {
  const d = flatDaily(40); const sg = sigmaAt(d, d.at(-1).t + DAY, 30); assert.ok(sg > 0.3 && sg < 0.45);
  near(exposure(0.5, 3, 1.2, 0.6), 0.5 * 3 * 0.5); near(exposure(1, 2, 0.3, 0.6), 2);
  assert.equal(sigmaAt(d, d[10].t, 30), null);
});

test("rolling stats: probability of a 25 % fall within h days", () => {
  const curve = [100, 100, 74, 80, 100, 100].map((v, i) => [i * DAY, v]);
  const r = rollingStats(curve, 2); assert.equal(r.n, 4); near(r.p_loss25, 2 / 4);
});

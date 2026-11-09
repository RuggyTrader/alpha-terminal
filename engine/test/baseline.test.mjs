// Corrected baseline study (src/cli/baseline.mjs): models A/B/C on the committed benchmark fixture.
//   node --test test/baseline.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { VENUES } from "../src/costs.mjs";
import { equityPath, metrics, modelC, study, tradeCosts, verifyCandles } from "../src/cli/baseline.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-2026-10-19_2026-11-07.json"), "utf8"));
const CANDLES = FIX.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const cfg = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, join(HERE, ".."));

describe("data integrity check", () => {
  it("finds gaps, duplicates, unordered and invalid candles without inventing any", () => {
    const k = (m, o = 10) => ({ t: m * 300_000, o, h: o + 1, l: o - 1, c: o });
    const v = verifyCandles([k(0), k(1), k(1), k(4), k(3), { ...k(5), h: 5 }], { from: 0, to: 6 * 300_000 });
    assert.equal(v.duplicates, 1);
    assert.equal(v.unordered, 1);
    assert.equal(v.invalidOHLC, 1);
    assert.deepEqual(v.gaps.map((g) => g.missing), [2, 1]); // 1→4 and 3→5
    assert.equal(v.candles, 6);
  });

  it("the benchmark fixture is complete, ordered and on the 5-minute grid", () => {
    const v = verifyCandles(CANDLES);
    assert.equal(v.duplicates + v.unordered + v.offGrid + v.invalidOHLC + v.nonPositive, 0);
  });
});

describe("per-fill costs (Model B)", () => {
  const t = { side: "LONG", qty: 10, entryPrice: 100, exitPrice: 99, exitKind: "SL" };
  it("limit entry = maker fee; stop exit = taker fee on the slipped price + slippage", () => {
    const c = tradeCosts(t, VENUES.kraken); // 0.40 / 0.80, slippage 0.03%
    assert.ok(Math.abs(c.entryFee - 4) < 1e-9);
    assert.ok(Math.abs(c.slippage - 990 * 0.0003) < 1e-9);
    assert.ok(Math.abs(c.exitFee - (990 - 990 * 0.0003) * 0.008) < 1e-9);
  });
  it("take-profit exit = maker, no slippage; no costs under 'none'", () => {
    const c = tradeCosts({ ...t, exitPrice: 102, exitKind: "TP" }, VENUES.ndax);
    assert.equal(c.slippage, 0);
    assert.ok(Math.abs(c.total - (1000 + 1020) * 0.002) < 1e-9);
    assert.equal(tradeCosts(t, VENUES.none).total, 0);
  });
  it("slippage on a short stop exit raises the buy-back price (fee on the higher value)", () => {
    const c = tradeCosts({ side: "SHORT", qty: 10, entryPrice: 100, exitPrice: 101, exitKind: "SL" }, VENUES.ndax);
    assert.ok(Math.abs(c.exitFee - (1010 + 1010 * 0.001) * 0.002) < 1e-9);
  });
});

describe("study on the benchmark window", () => {
  const res = study({ candles: CANDLES, inputs: cfg.inputs, from: CANDLES[0].t, to: CANDLES.at(-1).t + 300_000 });

  it("Model A is the exact original: both directions, fixed $10 risk, TradingView benchmark summary", () => {
    const a = res.model_a.all;
    assert.equal(a.trades, 69);
    assert.equal(a.winners, 32);
    assert.equal(a.profit_factor, 3.298);
    assert.equal(a.max_drawdown, 21.95);
    assert.ok(a.longs > 0 && a.shorts > 0);
    assert.equal(a.longs + a.shorts, a.trades);
    // fixed-dollar risk: a full stop-loss loses about $10 (Pine qty = risk / stop distance), never a % of equity
    const sl = res.trades.filter((t) => t.result === "SL" && t.exitKind === "SL");
    assert.ok(sl.length > 0 && sl.every((t) => t.pnl < -9 && t.pnl > -12), "stop losses ≈ -$10");
  });

  it("Model B keeps exactly A's trades; only costs differ", () => {
    const b = res.model_b.ndax;
    assert.equal(b.trades, res.model_a.all.trades);
    assert.equal(b.gross, res.model_a.all.net);
    assert.ok(Math.abs(b.gross - b.total_costs - b.net) < 0.02);
    assert.ok(Math.abs(b.entry_fees + b.exit_fees + b.slippage - b.total_costs) < 0.02);
    assert.equal(res.model_b.none.net, res.model_a.all.net);
    assert.ok(Math.abs(b.long.net + b.short.net - b.net) < 0.02);
  });

  it("$100 equity path shows positions larger than the capital instead of hiding them", () => {
    const e = res.model_a.equity_from_100;
    assert.ok(e.max_position_notional > 100);
    assert.equal(e.entries_larger_than_start_capital, 69);
  });
});

describe("Model C (current ALPHA PAPER ledger rules)", () => {
  it("never executes a short, never spends more than the balance, never goes negative from a refusal", () => {
    for (const cap of [100, 10_000]) {
      const c = modelC(CANDLES, cfg.inputs, cap, VENUES.ndax);
      assert.equal(c.executed_shorts, 0);
      assert.ok(c.refused_by_reason.SHORT_SELLING_DISABLED > 0);
      if (cap === 100) assert.equal(c.executed_trades, 0, "no $10-risk order fits $100");
    }
  });
  it("metrics and equity helpers agree", () => {
    const tr = [{ side: "LONG", qty: 1, entryPrice: 10, exitPrice: 12, pnl: 2, entryTime: "a", exitTime: "b", result: "TP2" },
      { side: "SHORT", qty: 1, entryPrice: 10, exitPrice: 13, pnl: -3, entryTime: "c", exitTime: "d", result: "SL" }];
    const m = metrics(tr);
    assert.deepEqual([m.net, m.profit_factor, m.max_drawdown, m.longs, m.shorts], [-1, 0.667, 3, 1, 1]);
    const e = equityPath(tr, 2);
    assert.equal(e.min_equity, 1);
    assert.equal(e.entries_larger_than_start_capital, 2);
  });
});

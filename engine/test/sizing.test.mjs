// Small-account position sizing (src/sizing.mjs) and how the engine uses it. Prices in the unit cases are the live
// SOLUSD order seen in production on 2026-11-09 (limit 86.78, stop 86.08); candles in the runner cases are the
// engine's real Kraken fixture.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { DEFAULT_SIZING, sizeOrder } from "../src/sizing.mjs";
import { runBacktest } from "../src/cli/backtest.mjs";
import { loadConfig } from "../src/config.mjs";
import { EngineRunner } from "../src/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDLES = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;
const P = { sizing: { mode: "percent", symbol: "SOLUSD" }, entry: 86.78, stop: 86.08, side: 1 };

describe("sizeOrder: percent (small-account) mode", () => {
  it("$10 / $50 / $100: 1% risk, capped to the balance after the price buffer and fee reserve, never above it", () => {
    for (const cap of [10, 50, 100]) {
      const s = sizeOrder({ ...P, capital: cap });
      assert.equal(s.ok, true, `${cap}: ${s.reason}`);
      assert.equal(s.riskTarget, cap / 100);
      assert.ok(s.qty * 86.78 * 1.005 * 1.004 <= cap + 1e-9, "cost incl. buffer and fee reserve fits the balance");
      assert.equal(s.capped, true, "with a 0.81% stop, 1% risk would need more than the balance: capped, no leverage");
      assert.equal(s.cappedBy, "BALANCE");
      assert.ok(s.riskActual <= s.riskTarget);
      assert.equal(Number(s.qty.toFixed(8)), s.qty, "8-decimal quantity, rounded down");
    }
    const ten = sizeOrder({ ...P, capital: 10 });
    assert.deepEqual([ten.qty, ten.notional, ten.riskActual, ten.requiredCapital], [0.1142038, 9.91, 0.08, 12.51]);
  });

  it("a wide stop takes the full 1% risk without the cap", () => {
    const s = sizeOrder({ ...P, stop: 80, capital: 100 });
    assert.equal(s.capped, false);
    assert.equal(s.riskActual, 1);
  });

  it("skips safely, with the exact reason: too small, short, unknown or no balance, bad stop", () => {
    const tiny = sizeOrder({ ...P, capital: 4 });
    assert.deepEqual([tiny.ok, tiny.code], [false, "BELOW_MIN_QTY"]);
    assert.match(tiny.reason, /below the minimum order of 0\.05 SOL \(needs about \$4\.38/);
    assert.equal(sizeOrder({ ...P, capital: 5 }).ok, true, "$5 is enough for 0.05 SOL at $86.78");
    // 0.0892 units of a $5 asset: above the 0.05 minimum quantity, below the $0.50 minimum value.
    const cheap = sizeOrder({ ...P, sizing: { mode: "percent", symbol: "SOLUSD", riskPct: 10 }, entry: 5, stop: 4.5, capital: 0.45 });
    assert.deepEqual([cheap.code, cheap.qty >= 0.05], ["BELOW_MIN_COST", true]);
    assert.equal(sizeOrder({ ...P, side: -1, entry: 86, stop: 87, capital: 100 }).code, "SHORT_NOT_ALLOWED");
    assert.equal(sizeOrder({ ...P, capital: null }).code, "BALANCE_UNKNOWN");
    assert.equal(sizeOrder({ ...P, capital: 0 }).code, "NO_CAPITAL");
    assert.equal(sizeOrder({ ...P, stop: 86.78, capital: 100 }).code, "INVALID_STOP");
  });

  it("never above the Worker's order-value limit (risk cap off, so only the order limit binds)", () => {
    const s = sizeOrder({ ...P, sizing: { mode: "percent", symbol: "SOLUSD", maxRiskUSD: null }, capital: 100000, maxNotional: 5000 });
    assert.ok(s.notional <= 5000);
    assert.equal(s.cappedBy, "ORDER_LIMIT");
  });

  it("fixed mode is the original formula, unchanged", () => {
    const s = sizeOrder({ sizing: { mode: "fixed" }, riskUSD: 10, entry: 86.78, stop: 86.08, side: 1, capital: 10 });
    assert.equal(s.qty, 10 / (86.78 - 86.08));
    assert.equal(DEFAULT_SIZING.mode, "fixed");
  });
});

describe("configuration", () => {
  it("fixed stays the default without a ledger (local research); percent mode and its parameters are validated", () => {
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "none" }).sizing.mode, "fixed");
    const c = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_SIZING: "percent", ENGINE_RISK_PCT: "1" });
    assert.deepEqual([c.sizing.mode, c.sizing.riskPct, c.sizing.feePct, c.sizing.priceBufferPct], ["percent", 1, 0.4, 0.5]);
    assert.throws(() => loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_SIZING: "leverage" }), /fixed or percent/);
    assert.throws(() => loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_SIZING: "percent", ENGINE_RISK_PCT: "50" }), /between/);
  });
});

describe("strategy with percent sizing (real Kraken fixture)", () => {
  it("fixed sizing is unchanged by the new code: same trades as before", () => {
    const a = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5 });
    const b = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5, sizing: { mode: "fixed" } });
    assert.deepEqual(b.trades, a.trades);
  });

  it("percent sizing: long-only, every order fits the balance, shorts are skipped with a reason, the balance compounds", () => {
    const run = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5, pivotTies: { left: "strict", right: "strict" },
      sizing: { mode: "percent", riskPct: 1 }, ledger: { startCapital: 10, feePct: 0, maxNotional: 5000, longOnly: true } });
    assert.ok(run.trades.length > 0);
    assert.ok(run.trades.every((t) => t.side === "LONG"));
    assert.ok(run.trades.every((t) => t.qty >= 0.05 && t.qty * t.entryPrice <= 10.5), "small fractional quantities within about $10");
    assert.equal(run.account.refused.length, 0, "nothing the ledger would refuse");
    const skips = run.events.filter((e) => e.type === "ORDER_SKIPPED");
    assert.ok(skips.some((e) => e.code === "SHORT_NOT_ALLOWED"));
    const net = run.trades.reduce((s, t) => s + t.pnl, 0);
    assert.ok(Math.abs(run.account.endCapital - (10 + net)) < 1e-9, "the balance is $10 plus the closed results");
  });

  it("runner: without a balance from the Worker, percent mode places nothing and says why", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "alpha-sizing-"));
    const cfg = { ...loadConfig({ ENGINE_ENV_FILE: "none" }), symbol: "SOLUSD", intervalMin: 5, sync: true, apiBase: "http://alpha.test", webhookSecret: "x", dataDir, lateBars: 2,
      pivotTies: { left: "strict", right: "strict" }, sizing: { mode: "percent", riskPct: 1, feePct: 0.4, priceBufferPct: 0.5 } };
    let visible = CANDLES.length;
    // An older Worker: its ledger view has no balance.
    const http = async (url) => new Response(JSON.stringify(url.endsWith("/engine-ledger") ? { ok: true, position: null, alerts: {} } : { ok: true }), { status: 200 });
    const r = new EngineRunner(cfg, { fetchCandles: async () => CANDLES.slice(0, visible), http, now: () => CANDLES[visible - 1].t + 310_000, log: () => {} });
    await r.tick();
    const st = r.statusPayload();
    assert.equal(st.sizing.mode, "percent");
    assert.equal(st.sizing.capital_usd, null);
    assert.equal(r.state.strategy.broker.entry, null, "no order without a known balance");
    assert.ok(r.state.strategy.lastSizing === null || r.state.strategy.lastSizing.code === "BALANCE_UNKNOWN" || r.state.strategy.lastSizing.code === "SHORT_NOT_ALLOWED");
  });
});

// PAPER execution-cost hints sent by the engine: maker/taker liquidity per signal, and the conservative-fill option.
// The strategy itself is unchanged: neither changes which signals are produced unless ENGINE_LIMIT_THROUGH_TICKS > 0.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { EngineRunner } from "../src/runner.mjs";
import { runBacktest } from "../src/cli/backtest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDLES = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;

const liq = (entryMode, item) => EngineRunner.prototype.liquidityFor.call({ state: { strategy: { inputs: { entryMode } } } }, item);

describe("liquidity hint for the PAPER cost model", () => {
  it("limit entries and take-profits are maker; stops, time exits, reconciliation and market entries are taker", () => {
    assert.equal(liq("Limit @ 0.705", { kind: "ENTRY" }), "maker");
    assert.equal(liq("Market on close", { kind: "ENTRY" }), "taker");
    assert.equal(liq("Limit @ 0.705", { kind: "EXIT", exitKind: "TP" }), "maker");
    for (const exitKind of ["SL", "BE", "TRAIL", "TIME", "RECONCILE_AFTER_DATA_GAP", null, undefined]) {
      assert.equal(liq("Limit @ 0.705", { kind: "EXIT", exitKind }), "taker", String(exitKind));
    }
  });

  it("every live dry-run signal carries a liquidity hint", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "alpha-costs-"));
    const cfg = { ...loadConfig({ ENGINE_ENV_FILE: "none" }), symbol: "SOLUSD", intervalMin: 5, sync: true, apiBase: "http://alpha.test", webhookSecret: "x", dataDir, lateBars: 2 };
    // Go live just before the first fill, as the main runner tests do, so every later fill is sent.
    let visible = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5 }).events.find((e) => e.type === "ENTRY_FILL").bar;
    const sent = [];
    let position = null;
    const http = async (url, init) => {
      const b = JSON.parse(init.body);
      if (url.endsWith("/engine-ledger")) return new Response(JSON.stringify({ ok: true, position, alerts: {} }), { status: 200 });
      if (url.endsWith("/dry-run")) {
        sent.push(b);
        position = b.action === "CLOSE" ? null : { symbol: b.symbol, side: "long", status: "OPEN", qty: Number(b.qty), open_alert_id: b.id };
        return new Response(JSON.stringify({ ok: true, code: "DRY_RUN_ACCEPTED" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const r = new EngineRunner(cfg, { fetchCandles: async ({ sinceMs }) => CANDLES.slice(0, visible).filter((k) => sinceMs === null || k.t > sinceMs), http, now: () => CANDLES[visible - 1].t + 310_000, log: () => {} });
    await r.tick();
    while (visible < CANDLES.length) { visible += 1; await r.tick(); }
    assert.ok(sent.length > 0, "the fixture produces live signals");
    for (const b of sent) assert.ok(b.liquidity === "maker" || b.liquidity === "taker", JSON.stringify(b));
    const item = (id) => r.state.outbox.find((x) => x.id === id);
    for (const b of sent) assert.equal(b.liquidity, r.liquidityFor(item(b.id)));
  });
});

describe("ENGINE_LIMIT_THROUGH_TICKS", () => {
  it("defaults to 0 (TradingView emulator rule) and rejects bad values", () => {
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "none" }).limitThroughTicks, 0);
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_LIMIT_THROUGH_TICKS: "2" }).limitThroughTicks, 2);
    for (const v of ["-1", "1.5", "21", "x"]) {
      assert.throws(() => loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_LIMIT_THROUGH_TICKS: v }), /integer 0-20/, v);
    }
  });

  it("is applied to the strategy's broker only when set, and removed again when cleared", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "alpha-costs-"));
    const base = { ...loadConfig({ ENGINE_ENV_FILE: "none" }), symbol: "SOLUSD", intervalMin: 5, sync: false, dataDir, lateBars: 2 };
    const deps = { fetchCandles: async ({ sinceMs }) => CANDLES.slice(0, 300).filter((k) => sinceMs === null || k.t > sinceMs), now: () => CANDLES[299].t + 310_000, log: () => {} };
    const on = new EngineRunner({ ...base, limitThroughTicks: 2 }, deps);
    await on.tick();
    assert.equal(on.state.strategy.broker.opts?.limitThroughTicks, 2);
    assert.ok(on.state.strategy.broker.opts?.tick > 0);
    on.cfg = { ...on.cfg, limitThroughTicks: 0 };
    await on.prepareSizing();
    assert.equal(on.state.strategy.broker.opts?.limitThroughTicks, undefined);
  });
});

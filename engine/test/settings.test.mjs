// Website risk setting in the live runner (ENGINE_REMOTE_SETTINGS=on): applies to new entries only, open
// positions keep their size, it survives restarts and re-warms, it is confirmed back, and bad values are ignored.
//   node --test test/settings.test.mjs

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { EngineRunner } from "../src/runner.mjs";
import { runBacktest } from "../src/cli/backtest.mjs";
import { loadConfig } from "../src/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDLES = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;
const STEP = 300_000;

function harness({ remoteSettings = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "alpha-engine-settings-"));
  const cfg = { profile: "test", symbol: "SOLUSD", intervalMin: 5, inputs: {}, sync: true, apiBase: "http://alpha.test", webhookSecret: "s", dataDir, lateBars: 2, krakenBase: "", remoteSettings };
  const h = { cfg, visible: 0, server: null, statuses: [] };
  const http = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/webhook/engine-status")) {
      h.statuses.push(body.status);
      return new Response(JSON.stringify({ ok: true, settings: h.server }), { status: 200 });
    }
    if (url.endsWith("/webhook/engine-ledger")) return new Response(JSON.stringify({ ok: true, position: null, alerts: {} }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, code: "DRY_RUN_ACCEPTED" }), { status: 200 });
  };
  h.make = () => new EngineRunner(cfg, {
    fetchCandles: async ({ sinceMs }) => CANDLES.slice(0, h.visible).filter((k) => sinceMs === null || k.t > sinceMs),
    http, now: () => CANDLES[h.visible - 1].t + STEP + 10_000, log: () => {},
  });
  h.orders = () => readFileSync(join(dataDir, "audit-SOLUSD-5m.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((r) => r.type === "candle" && !r.warmup).flatMap((r) => r.events.filter((e) => e.type === "ORDER_PLACED"));
  return h;
}

// A bar where the default-input strategy holds a position, with a later ORDER_PLACED after it closes.
const ev = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5 }).events;
const entry = ev.find((e) => e.type === "ENTRY_FILL");
const exit = ev.find((e) => e.type === "EXIT_FILL" && e.bar > entry.bar);
const later = ev.find((e) => e.type === "ORDER_PLACED" && e.bar > exit.bar);

describe("website risk setting (remote settings)", () => {
  it("applies to new orders only; the open position keeps its size; the engine confirms the version", async () => {
    const h = harness();
    h.visible = entry.bar + 1; // warm-up ends with the position open
    h.server = null;
    const r = h.make();
    await r.tick();
    const pos = r.state.strategy.broker.pos;
    assert.ok(pos, "a position is open");
    const qtyBefore = pos.qty;
    h.server = { strategy: "SOLUSD", version: 2, risk_usd: 25, status: "PENDING" };
    h.visible += 1;
    await r.tick();
    if (r.state.strategy.broker.pos) assert.equal(r.state.strategy.broker.pos.qty, qtyBefore, "open position unchanged");
    assert.equal(r.state.strategy.inputs.riskUSD, 25);
    assert.deepEqual(r.state.settings && [r.state.settings.version, r.state.settings.riskUSD], [2, 25]);
    // The confirmation status update reports the applied version.
    assert.deepEqual(h.statuses.at(-1).settings, { version: 2, risk_usd: 25 });
    assert.equal(h.statuses.at(-1).risk_usd, 25);
    // Orders placed from now on are sized at $25 risk.
    h.server = { strategy: "SOLUSD", version: 2, risk_usd: 25, status: "APPLIED" };
    while (h.visible <= later.bar) { h.visible += 1; await r.tick(); }
    const o = h.orders().at(-1);
    const risk = o.qty * Math.abs(o.limit - o.stop);
    assert.ok(Math.abs(risk - 25) / 25 < 0.02, `order risk ${risk}`);
  });

  it("survives a restart and a data-gap re-warm", async () => {
    const h = harness();
    h.visible = 300;
    h.server = { strategy: "SOLUSD", version: 3, risk_usd: 12.5, status: "PENDING" };
    const r = h.make();
    await r.tick();
    assert.equal(r.state.strategy.inputs.riskUSD, 12.5);
    const again = h.make(); // process restart from the saved state file
    assert.equal(again.state.settings.version, 3);
    assert.equal(again.state.strategy.inputs.riskUSD, 12.5);
    again.fresh("test re-warm");
    assert.equal(again.state.settings.version, 3);
    assert.equal(again.state.strategy.inputs.riskUSD, 12.5);
  });

  it("ignores website settings unless enabled, and ignores invalid values", async () => {
    const off = harness({ remoteSettings: false });
    off.visible = 300;
    off.server = { strategy: "SOLUSD", version: 2, risk_usd: 25 };
    const r = off.make();
    await r.tick();
    assert.equal(r.state.strategy.inputs.riskUSD, 200);
    assert.equal(r.state.settings, undefined);

    const h = harness();
    h.visible = 300;
    const r2 = h.make();
    for (const bad of [{ version: 2, risk_usd: 0.5 }, { version: 1.5, risk_usd: 10 }, { version: 2, risk_usd: "10" }, null]) {
      h.server = bad;
      await r2.tick();
      assert.equal(r2.state.strategy.inputs.riskUSD, 200);
    }
  });

  it("the solusd-5m profile turns remote settings on; paper-test and defaults do not", () => {
    const base = join(HERE, "..");
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, base).remoteSettings, true);
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "paper-test" }, base).remoteSettings, false);
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "none" }, base).remoteSettings, false);
  });
});

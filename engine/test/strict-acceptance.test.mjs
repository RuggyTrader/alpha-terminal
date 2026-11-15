// REVIEW: strict acceptance timing end to end. A ledger stub accepts each order 3 s after the engine sends it and, like
// the Worker with STRICT_FILL_TIMING, refuses any fill whose candle opened before that acceptance. With
// ENGINE_STRICT_FILL=on the engine must never send such a fill (no refusal), including across a restart, order
// replacements and expiries; with it off (production today) some fills come from candles that began before acceptance.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBotConfigs } from "../src/config.mjs";
import { EngineRunner } from "../src/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), ENGINE = join(HERE, "..");
const SOL1 = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-1m-2026-11-10_2026-11-12.json"), "utf8")).candles;
const temps = []; after(() => { for (const t of temps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* locked */ } } });

function harness({ strict, dataDir = null }) {
  const dir = dataDir ?? (temps.push(mkdtempSync(join(tmpdir(), "alpha-strict-"))), temps.at(-1));
  const L = { orders: new Map(), pending: null, position: null, opens: [], refusedEarly: 0, early: 0, cancels: [], clock: { now: SOL1[300].t + 70_000 } };
  const http = async (url, init) => {
    const path = String(url).replace(/^.*\/webhook\//, ""), b = JSON.parse(init.body);
    const ok = (code, data = {}) => new Response(JSON.stringify({ ok: true, code, data }), { status: 200 });
    if (path === "bot-ledger") return new Response(JSON.stringify({ ok: true, position: L.position, alerts: {}, pending_order: L.pending, balance: { available_usd: 20, bot_available_usd: 20, max_order_notional_usd: 5000 } }), { status: 200 });
    if (path !== "bot-order") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (b.action === "PLACE_LIMIT") {
      const o = { order_id: b.order_id, side: b.side, limit: b.limit, accepted_qty: b.qty, placed_at: b.placed_at, received_at: new Date(L.clock.now + 3000).toISOString() };
      L.orders.set(b.order_id, o); L.pending = o;
      return ok("ORDER_PENDING", o);
    }
    if (b.action === "CANCEL_ORDER") { L.cancels.push(b); if (L.pending?.order_id === b.target_order_id) L.pending = null; return ok("ORDER_CANCELLED"); }
    if (/^OPEN_/.test(b.action)) {
      const o = L.orders.get(b.pending_order_id);
      const early = o && Date.parse(b.fill.candle.t) < Date.parse(o.received_at);
      if (early) { L.early++; if (strict) { L.refusedEarly++; return new Response(JSON.stringify({ ok: false, code: "FILL_BEFORE_ORDER" }), { status: 422 }); } }
      L.opens.push({ b, o }); L.pending = null;
      L.position = { symbol: "SOLUSD", side: b.action === "OPEN_LONG" ? "long" : "short", status: "OPEN", qty: b.qty, avg_entry_price: b.fill.price, open_alert_id: b.order_id };
      return ok("DRY_RUN_ACCEPTED", { qty: b.qty });
    }
    if (b.action === "CLOSE") { L.position = null; return ok("DRY_RUN_ACCEPTED"); }
    return ok("OK");
  };
  const mk = () => {
    const [{ cfg }] = loadBotConfigs(["ALPHA-01"], { ENGINE_ENV_FILE: "none", ENGINE_DATA_DIR: dir, ENGINE_SYNC: "on", ALPHA_API_BASE: "http://127.0.0.1:9", ALPHA_WEBHOOK_SECRET: "s", ENGINE_MIRROR: "off", ENGINE_STRICT_FILL: strict ? "on" : "off" }, ENGINE, { allowProposed: true });
    return new EngineRunner(cfg, { fetchCandles: async ({ sinceMs }) => SOL1.filter((k) => k.t + 60_000 <= L.clock.now && (sinceMs === null || k.t > sinceMs)), http, now: () => L.clock.now, log: () => {} });
  };
  return { L, mk, dir };
}

describe("strict acceptance timing (engine = ledger rule)", () => {
  it("strict: every fill is from a candle that began at or after the ledger accepted the order; never refused, across a restart", async () => {
    const h = harness({ strict: true });
    let r = h.mk();
    await r.tick();
    let restarted = false;
    for (let i = 0; i < 1400; i++) {
      h.L.clock.now += 60_000; await r.tick();
      if (!restarted && h.L.pending && r.state.strategy.broker.entry?.acceptedAtMs) {
        // restart while an accepted order is pending: the acceptance time survives in the saved state
        const at = r.state.strategy.broker.entry.acceptedAtMs;
        r = h.mk(); await r.tick();
        assert.equal(r.state.strategy.broker.entry?.acceptedAtMs ?? at, at, "acceptance time preserved across the restart");
        restarted = true;
      }
    }
    assert.ok(restarted, "precondition: a restart happened with an accepted order pending");
    assert.ok(h.L.opens.length >= 3, `precondition: real fills happened (${h.L.opens.length})`);
    assert.equal(h.L.refusedEarly, 0, "the engine never sent a fill from before acceptance");
    for (const { b, o } of h.L.opens) assert.ok(Date.parse(b.fill.candle.t) >= Date.parse(o.received_at));
    assert.ok(h.L.cancels.length > 0, "replacements / expiries still cancel the old order");
  });

  it("off (production today): behaviour unchanged, no acceptance data stored; early fills are counted for information", async () => {
    const h = harness({ strict: false });
    const r = h.mk(); await r.tick();
    for (let i = 0; i < 2600 && SOL1[300].t + 70_000 + (i + 1) * 60_000 < SOL1.at(-1).t + 120_000; i++) { h.L.clock.now += 60_000; await r.tick(); }
    assert.ok(h.L.opens.length >= 3);
    assert.ok(!JSON.stringify(r.state.strategy.broker).includes("acceptedAtMs"), "nothing new in the saved state when off");
    console.log(`current rule: ${h.L.early} of ${h.L.opens.length} fills used a candle that began before acceptance (the backtest over Aug-Nov found 2-4 %)`);
  });
});

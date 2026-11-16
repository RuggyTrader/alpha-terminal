// Outage recovery and reconciliation (production ALPHA-03, 2026-11-16): after a 12-hour power cut the engine caught up,
// its strategy expired the accepted order without being able to send the (too old) cancel, and it then treated a NEW
// order whose placement was skipped (SIGNAL_EXPIRED) as live. That phantom order hid the stale ledger order for 12 h.
// These tests drive the real runner against a ledger stub that behaves like the Worker (one pending order per bot, a new
// placement replaces it, expiry recorded on the order) through power failures, network outages, rejected cancels,
// expired signals, missed candles, repeated restarts, the owner pause, and an unresolved divergence.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBotConfigs } from "../src/config.mjs";
import { EngineRunner } from "../src/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOL1 = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-1m-2026-11-10_2026-11-12.json"), "utf8")).candles;
const temps = []; after(() => { for (const t of temps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* locked */ } } });
const MIN = 60_000;

function harness({ paused = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alpha-outage-")); temps.push(dir);
  const L = {
    clock: { now: SOL1[300].t + 70_000 }, orders: new Map(), pending: null, position: null, places: [], cancels: [], opens: [],
    fillsAgainstUnknown: 0, latePlacements: 0, down: false, refuseCancels: 0, rejectCancels: 0, injectPending: null,
  };
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  const http = async (url, init) => {
    if (L.down) throw new Error("network down (test)");
    const path = String(url).replace(/^.*\/webhook\//, ""), b = JSON.parse(init.body);
    if (path === "bot-ledger") {
      if (L.injectPending && !L.pending) L.pending = L.injectPending;
      return reply(200, { ok: true, position: L.position, alerts: {}, pending_order: L.pending, balance: { available_usd: 20, bot_available_usd: 20, max_order_notional_usd: 5000 } });
    }
    if (path !== "bot-order") return reply(200, { ok: true });
    if (b.action === "PLACE_LIMIT") {
      if (L.clock.now - Date.parse(b.timestamp) > 2 * MIN + 1) L.latePlacements++;
      if (L.orders.has(b.order_id)) return reply(200, { ok: true, code: "ORDER_PENDING", duplicate: true, data: L.orders.get(b.order_id) });
      const o = { order_id: b.order_id, side: b.side, limit: b.limit, accepted_qty: b.qty, placed_at: b.placed_at, expires_at: b.expires_at, received_at: new Date(L.clock.now + 3000).toISOString(), status: "PENDING" };
      if (L.pending) L.pending.status = "REPLACED";
      L.orders.set(b.order_id, o); L.pending = o; L.places.push(b.order_id);
      return reply(200, { ok: true, code: "ORDER_PENDING", data: o });
    }
    if (b.action === "CANCEL_ORDER") {
      if (L.refuseCancels > 0) { L.refuseCancels--; return reply(503, { ok: false, code: "TEMPORARY" }); }
      if (L.rejectCancels > 0) { L.rejectCancels--; return reply(422, { ok: false, code: "CANCEL_REFUSED", message: "refused (test)" }); }
      L.cancels.push({ id: b.order_id, target: b.target_order_id, reason_code: b.reason_code, reason: b.reason });
      const o = L.orders.get(b.target_order_id) ?? (L.injectPending?.order_id === b.target_order_id ? L.injectPending : null);
      if (o && o.status === "PENDING") o.status = b.reason_code === "EXPIRED" ? "EXPIRED" : "CANCELLED";
      if (L.pending?.order_id === b.target_order_id) L.pending = null;
      if (L.injectPending?.order_id === b.target_order_id) L.injectPending = null;
      return reply(200, { ok: true, code: "ORDER_CANCELLED" });
    }
    if (/^OPEN_/.test(b.action)) {
      const o = L.orders.get(b.pending_order_id);
      if (!o || o.status !== "PENDING") { L.fillsAgainstUnknown++; return reply(422, { ok: false, code: o ? "PENDING_ORDER_NOT_ACTIVE" : "PENDING_ORDER_NOT_FOUND" }); }
      o.status = "FILLED"; L.pending = null; L.opens.push(b.order_id);
      L.position = { symbol: "SOLUSD", side: b.action === "OPEN_LONG" ? "long" : "short", status: "OPEN", qty: b.qty, avg_entry_price: b.fill.price, open_alert_id: b.order_id };
      return reply(200, { ok: true, code: "DRY_RUN_ACCEPTED", data: { qty: b.qty } });
    }
    if (b.action === "CLOSE") { L.position = null; return reply(200, { ok: true, code: "DRY_RUN_ACCEPTED" }); }
    return reply(200, { ok: true });
  };
  const mk = (env = {}) => {
    const [{ cfg }] = loadBotConfigs(["ALPHA-01"], { ENGINE_ENV_FILE: "none", ENGINE_DATA_DIR: dir, ENGINE_SYNC: "on", ALPHA_API_BASE: "http://127.0.0.1:9", ALPHA_WEBHOOK_SECRET: "s", ENGINE_MIRROR: "off",
      ENGINE_STRICT_FILL: "on", ENGINE_APPROVED_BOTS: "ALPHA-01", ...(paused ? { ENGINE_PAUSED_BOTS: "ALPHA-01" } : {}), ...env }, join(HERE, ".."), { allowProposed: true });
    return new EngineRunner(cfg, { fetchCandles: async ({ sinceMs }) => SOL1.filter((k) => k.t + MIN <= L.clock.now && (sinceMs === null || k.t > sinceMs)), http, now: () => L.clock.now, log: () => {} });
  };
  const run = async (r, minutes) => { for (let i = 0; i < minutes && L.clock.now + MIN < SOL1.at(-1).t + 2 * MIN; i++) { L.clock.now += MIN; await r.tick(); } };
  const untilPending = async (r, max = 2000) => { for (let i = 0; i < max && !(L.pending && r.state.liveOrder); i++) { L.clock.now += MIN; await r.tick(); } return !!L.pending; };
  const audits = () => readFileSync(join(dir, "audit-ALPHA-01-SOLUSD-1m.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { L, mk, run, untilPending, audits, dir };
}

/** The invariants that must hold after any recovery: engine and ledger agree, nothing unaccepted is live. */
function assertReconciled(h, r, label) {
  const { L } = h;
  const live = r.state.liveOrder;
  const item = live ? r.state.outbox.find((x) => x.id === live.id) : null;
  if (L.pending) assert.ok(live && L.pending.order_id === live.id && item?.status === "accepted", `${label}: the ledger's pending order ${L.pending.order_id} is the engine's accepted live order (engine: ${live?.id} ${item?.status})`);
  if (live && item && item.status !== "accepted" && item.status !== "pending") assert.ok(!L.pending || L.pending.order_id !== live.id, `${label}: an unaccepted engine order is not in the ledger`);
  assert.equal(L.fillsAgainstUnknown, 0, `${label}: no fill was sent for an order the ledger had not accepted`);
  assert.equal(L.latePlacements, 0, `${label}: no order was ever placed late (after an outage)`);
  assert.equal(new Set(L.places).size, L.places.length, `${label}: no order placed twice`);
}

describe("outage recovery: engine order state follows the authoritative ledger", () => {
  it("power failure with an accepted order: after catch-up the stale ledger order is expired/cancelled (recorded), the phantom order is not live, the engine reconciles", async () => {
    const h = harness();
    let r = h.mk(); await r.tick();
    assert.ok(await h.untilPending(r), "precondition: an accepted order is pending in the ledger");
    const stale = h.L.pending.order_id;
    // the PC loses power for 6 hours (no ticks), then the engine restarts from its saved state and catches up
    h.L.clock.now += 6 * 60 * MIN;
    r = h.mk(); await r.tick();
    await h.run(r, 5);
    const c = h.L.cancels.find((x) => x.target === stale);
    assert.ok(c, "the stale order was explicitly cancelled or expired in the ledger");
    assert.match(c.reason, /expired|reconciliation|replaced|setup/i, "with a recorded reason");
    assert.ok(["EXPIRED", "CANCELLED"].includes(h.L.orders.get(stale).status), "terminal state recorded on the stale order");
    assertReconciled(h, r, "after catch-up");
    assert.equal(r.state.ledgerCheck.status, "OK", `ledger check OK again (${JSON.stringify(r.state.ledgerCheck.issues)})`);
    await h.run(r, 600);
    assertReconciled(h, r, "600 minutes later");
  });

  it("a placement skipped as SIGNAL_EXPIRED is never treated as live and never masks a ledger order", async () => {
    const h = harness();
    let r = h.mk(); await r.tick();
    assert.ok(await h.untilPending(r));
    const stale = h.L.pending.order_id;
    // network outage long enough that new placements expire unsent, with the old order still pending in the ledger
    h.L.down = true;
    await h.run(r, 240);
    h.L.down = false;
    await h.run(r, 4);
    const notAccepted = h.audits().filter((a) => a.event === "NOT_ACCEPTED");
    const skipped = r.state.outbox.filter((x) => x.action === "PLACE_LIMIT" && x.code === "SIGNAL_EXPIRED");
    if (skipped.length && r.state.liveOrder && skipped.some((x) => x.id === r.state.liveOrder.id)) assert.ok(notAccepted.length > 0, "a phantom live order is flagged NOT_ACCEPTED");
    assert.ok(h.L.orders.get(stale).status !== "PENDING" || h.L.pending?.order_id === r.state.liveOrder?.id, "the stale order does not stay pending behind a phantom order");
    assertReconciled(h, r, "after the network outage");
  });

  it("a rejected cancellation is retried through reconciliation until the ledger agrees; idempotent", async () => {
    const h = harness();
    const r = h.mk(); await r.tick();
    assert.ok(await h.untilPending(r));
    h.L.refuseCancels = 3; // the next three cancellation attempts fail
    await h.run(r, 400);
    assertReconciled(h, r, "after refused cancellations");
    assert.ok(h.L.cancels.length > 0, "cancellations eventually went through");
  });

  it("missed candles and repeated restarts: state is restored, recovery is idempotent, nothing is placed twice or late", async () => {
    const h = harness();
    let r = h.mk(); await r.tick();
    for (let k = 0; k < 12; k++) {
      await h.run(r, 37);
      h.L.clock.now += (k % 3 === 0 ? 45 : 3) * MIN; // gaps: some longer than lateBars, some short
      r = h.mk(); await r.tick(); // unclean restart from the saved state
    }
    await h.run(r, 5);
    assertReconciled(h, r, "after 12 restarts");
  });

  it("expired orders cannot stay active: a ledger order past its expiry is expired by reconciliation even if the engine still works it", async () => {
    const h = harness();
    const r = h.mk(); await r.tick();
    // the ledger holds an order the engine never sent, with an expiry in the past
    h.L.injectPending = { order_id: "ENG-ALPHA-01-SOLUSD-1-2026-11-10T00:00:00Z-PLACE_SHORT", side: "SHORT", limit: 1, accepted_qty: 0.1, placed_at: "2026-11-10T00:00:00Z",
      expires_at: new Date(h.L.clock.now - 60 * MIN).toISOString(), received_at: "2026-11-10T00:00:03Z", status: "PENDING" };
    await h.run(r, 3);
    const c = h.L.cancels.find((x) => x.target === h.L.injectPending?.order_id || /2026-11-10T00:00:00Z-PLACE_SHORT/.test(x.target));
    assert.ok(c && c.reason_code === "EXPIRED" && /expired at/.test(c.reason), `expired with a recorded reason (${JSON.stringify(c)})`);
    assertReconciled(h, r, "after the expiry");
  });

  it("while the ledger and the engine disagree, nothing that opens exposure is sent", async () => {
    const h = harness();
    const r = h.mk(); await r.tick();
    // an orphan ledger order whose cancellations are rejected outright: the divergence stays unresolved for a while
    h.L.injectPending = { order_id: "ENG-ALPHA-01-SOLUSD-1-2026-11-10T00:01:00Z-PLACE_LONG", side: "LONG", limit: 1, accepted_qty: 0.1, placed_at: "2026-11-10T00:01:00Z",
      expires_at: null, received_at: "2026-11-10T00:01:03Z", status: "PENDING" };
    h.L.rejectCancels = 1e9;
    const placesBefore = h.L.places.length;
    await h.run(r, 1800);
    assert.equal(h.L.places.length, placesBefore, "no new order was placed while unresolved");
    assert.equal(h.L.opens.length, 0, "no entry was sent while unresolved");
    assert.ok(h.audits().some((a) => a.code === "RECONCILE_PENDING"), "precondition: the strategy produced a setup, and it was held (recorded)");
    const attempts = r.state.outbox.filter((x) => x.reconcile).length;
    assert.ok(attempts >= 2 && attempts <= 6, `rejected cancels are retried, bounded (${attempts})`);
    h.L.rejectCancels = 0;
    // retries were exhausted: no further automatic attempt; the divergence stays visible and entries stay blocked
    await h.run(r, 30);
    assert.equal(r.state.ledgerCheck.status, "DIVERGED", "an exhausted reconciliation stays visible, never silently cleared");
  });
});

describe("owner pause (ENGINE_PAUSED_BOTS)", () => {
  it("a paused bot sends no new order and no entry, ever; its scanning continues", async () => {
    const h = harness({ paused: true });
    const r = h.mk(); await r.tick();
    await h.run(r, 1500);
    assert.equal(h.L.places.length, 0, "no limit order placed");
    assert.equal(h.L.opens.length, 0, "no entry sent");
    assert.ok(r.state.outbox.some((x) => x.code === "ENTRIES_PAUSED"), "the strategy still found setups; each was recorded as paused");
    assert.equal(r.state.ledgerCheck.entries_paused, true);
  });

  it("pausing with an accepted, unfilled order cancels it explicitly (recorded), never silently abandons it", async () => {
    const h = harness();
    let r = h.mk(); await r.tick();
    assert.ok(await h.untilPending(r), "precondition: an accepted order");
    const id = h.L.pending.order_id;
    r = h.mk({ ENGINE_PAUSED_BOTS: "ALPHA-01" }); await r.tick();
    await h.run(r, 3);
    const c = h.L.cancels.find((x) => x.target === id);
    assert.ok(c && /paused by the owner/.test(c.reason), `cancelled with the pause recorded (${JSON.stringify(c)})`);
    assert.equal(h.L.pending, null);
    await h.run(r, 600);
    assert.equal(h.L.opens.length, 0, "and nothing opens afterwards");
  });

  it("only the bots of this engine can be paused (a typo is refused at start)", () => {
    assert.throws(() => loadBotConfigs(["ALPHA-01"], { ENGINE_ENV_FILE: "none", ENGINE_PAUSED_BOTS: "ALPHA-09", ENGINE_APPROVED_BOTS: "ALPHA-01" }, join(HERE, ".."), { allowProposed: true }), /ENGINE_PAUSED_BOTS/);
  });
});

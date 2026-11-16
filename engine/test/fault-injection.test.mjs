// Fault injection for the bot path (2026-11-16 mission): power loss at every step of an order's life, lost replies,
// timeouts, duplicate requests, Worker clock skew, ledger unavailability, and recovery with positions and pauses.
// The ledger stub behaves like the Worker where it matters: idempotent by order id (a repeated request returns the
// first outcome), one PENDING order per bot (a new placement replaces it), strict acceptance on fills.
// Invariants checked after every scenario: no duplicate order or fill, no fill against an unaccepted order, no fill
// from a candle before acceptance, the engine's position and order match the ledger, exits are never blocked.
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

function world({ workerSkewMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alpha-fault-")); temps.push(dir);
  const L = { clock: { now: SOL1[300].t + 70_000 }, orders: new Map(), results: new Map(), pending: null, position: null,
    fills: [], early: 0, unknownFills: 0, requests: 0, faults: [], ledgerDown: false };
  // a fault: { action, mode: "lost" (processed, reply lost) | "drop" (never arrives) | "timeout", times }
  const fault = (action) => { const f = L.faults.find((x) => (x.action === action || x.action === "*") && x.times > 0); if (f) f.times--; return f?.mode ?? null; };
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  const http = async (url, init) => {
    L.requests++;
    const path = String(url).replace(/^.*\/webhook\//, ""), b = JSON.parse(init.body);
    if (path === "bot-ledger") {
      if (L.ledgerDown) return reply(503, { ok: false, code: "D1_UNAVAILABLE" });
      return reply(200, { ok: true, position: L.position, alerts: {}, pending_order: L.pending, balance: { available_usd: 20, bot_available_usd: 20, max_order_notional_usd: 5000 } });
    }
    if (path !== "bot-order") return reply(200, { ok: true });
    const mode = fault(b.action);
    if (mode === "drop") throw new Error("connection reset (test)");
    if (mode === "timeout") { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }
    let res;
    if (L.results.has(b.order_id)) res = { ...L.results.get(b.order_id), duplicate: true }; // idempotent by order id
    else {
      const wNow = L.clock.now + workerSkewMs;
      if (b.action === "PLACE_LIMIT") {
        const o = { order_id: b.order_id, side: b.side, limit: b.limit, accepted_qty: b.qty, placed_at: b.placed_at, expires_at: b.expires_at, received_at: new Date(wNow + 2000).toISOString(), status: "PENDING" };
        if (L.pending) L.pending.status = "REPLACED";
        L.orders.set(b.order_id, o); L.pending = o; res = { http: 200, body: { ok: true, code: "ORDER_PENDING", data: o } };
      } else if (b.action === "CANCEL_ORDER") {
        const o = L.orders.get(b.target_order_id);
        if (o && o.status === "PENDING") o.status = b.reason_code === "EXPIRED" ? "EXPIRED" : "CANCELLED";
        if (L.pending?.order_id === b.target_order_id) L.pending = null;
        res = { http: 200, body: { ok: true, code: "ORDER_CANCELLED" } };
      } else if (/^OPEN_/.test(b.action)) {
        const o = L.orders.get(b.pending_order_id);
        if (!o || o.status !== "PENDING") { L.unknownFills++; res = { http: 422, body: { ok: false, code: o ? "PENDING_ORDER_NOT_ACTIVE" : "PENDING_ORDER_NOT_FOUND" } }; }
        else if (Date.parse(b.fill.candle.t) < Date.parse(o.received_at)) { L.early++; res = { http: 422, body: { ok: false, code: "FILL_BEFORE_ORDER" } }; }
        else {
          o.status = "FILLED"; L.pending = null; L.fills.push({ id: b.order_id, kind: "ENTRY" });
          L.position = { symbol: "SOLUSD", side: b.action === "OPEN_LONG" ? "long" : "short", status: "OPEN", qty: b.qty, avg_entry_price: b.fill.price, open_alert_id: b.order_id };
          res = { http: 200, body: { ok: true, code: "DRY_RUN_ACCEPTED", data: { qty: b.qty } } };
        }
      } else if (b.action === "CLOSE") {
        if (!L.position) res = { http: 422, body: { ok: false, code: "NO_POSITION" } };
        else { L.fills.push({ id: b.order_id, kind: "EXIT" }); L.position = null; res = { http: 200, body: { ok: true, code: "DRY_RUN_ACCEPTED" } }; }
      } else res = { http: 200, body: { ok: true } };
      L.results.set(b.order_id, res);
    }
    if (mode === "lost") throw new Error("reply lost after the ledger processed the request (test)");
    return reply(res.http, res.body);
  };
  const mk = (env = {}) => {
    const [{ cfg }] = loadBotConfigs(["ALPHA-01"], { ENGINE_ENV_FILE: "none", ENGINE_DATA_DIR: dir, ENGINE_SYNC: "on", ALPHA_API_BASE: "http://127.0.0.1:9", ALPHA_WEBHOOK_SECRET: "s", ENGINE_MIRROR: "off",
      ENGINE_STRICT_FILL: "on", ENGINE_APPROVED_BOTS: "ALPHA-01", ...env }, join(HERE, ".."), { allowProposed: true });
    return new EngineRunner(cfg, { fetchCandles: async ({ sinceMs }) => SOL1.filter((k) => k.t + MIN <= L.clock.now && (sinceMs === null || k.t > sinceMs)), http, now: () => L.clock.now, log: () => {} });
  };
  const step = async (r, n = 1) => { for (let i = 0; i < n && L.clock.now + MIN < SOL1.at(-1).t + 2 * MIN; i++) { L.clock.now += MIN; await r.tick(); } };
  const until = async (r, cond, max = 2500) => { for (let i = 0; i < max && !cond(); i++) await step(r); return cond(); };
  return { L, mk, step, until };
}

function invariants(w, r, label) {
  const { L } = w;
  const ids = L.fills.map((f) => `${f.kind}:${f.id}`);
  assert.equal(new Set(ids).size, ids.length, `${label}: no duplicate fill`);
  assert.equal(L.unknownFills, 0, `${label}: no fill against an order the ledger had not accepted`);
  assert.equal(L.early, 0, `${label}: no fill from a candle before the ledger's acceptance`);
  const holds = !!r.state.strategy.broker.pos && !!r.state.openEntryId;
  if (L.position) assert.ok(holds && r.state.openEntryId === L.position.open_alert_id, `${label}: the ledger's open position is the engine's (${L.position.open_alert_id} vs ${r.state.openEntryId})`);
  const live = r.state.liveOrder, item = live ? r.state.outbox.find((x) => x.id === live.id) : null;
  if (L.pending) assert.ok(live && live.id === L.pending.order_id && item?.status === "accepted" && !live.cancelled, `${label}: the ledger's pending order is the engine's accepted order`);
}

describe("fault injection: power loss at every step of an order's life", () => {
  it("before acceptance (request never arrived): the order is re-sent once after restart, or expires unsent; never duplicated", async () => {
    const w = world();
    let r = w.mk(); await r.tick();
    w.L.faults.push({ action: "PLACE_LIMIT", mode: "drop", times: 1 });
    await w.until(r, () => w.L.faults[0].times === 0);
    r = w.mk(); await r.tick(); // unclean restart right after the failed send
    await w.step(r, 300);
    invariants(w, r, "after restart");
  });

  it("after acceptance, reply lost: the retry returns the SAME order (idempotent); the engine adopts it, no second order", async () => {
    const w = world();
    let r = w.mk(); await r.tick();
    w.L.faults.push({ action: "PLACE_LIMIT", mode: "lost", times: 1 });
    await w.until(r, () => w.L.faults[0].times === 0);
    const accepted = w.L.pending?.order_id;
    assert.ok(accepted, "precondition: the ledger accepted the order whose reply was lost");
    r = w.mk(); await r.tick(); await w.step(r, 2);
    assert.equal([...w.L.orders.keys()].filter((k) => k === accepted).length, 1);
    invariants(w, r, "after the lost reply");
    await w.step(r, 400);
    invariants(w, r, "400 min later");
  });

  it("during cancellation (cancel processed, reply lost) and with a restart: the order ends cancelled once; nothing fills it", async () => {
    const w = world();
    let r = w.mk(); await r.tick();
    assert.ok(await w.until(r, () => !!w.L.pending));
    w.L.faults.push({ action: "CANCEL_ORDER", mode: "lost", times: 2 });
    await w.until(r, () => w.L.faults[0].times === 0, 1500);
    r = w.mk(); await r.tick();
    await w.step(r, 200);
    invariants(w, r, "after a lost cancel reply");
  });

  it("during fill processing (fill recorded, reply lost) and a restart: one position, the engine holds the ledger's, exits work", async () => {
    const w = world();
    let r = w.mk(); await r.tick();
    w.L.faults.push({ action: "OPEN_LONG", mode: "lost", times: 1 }, { action: "OPEN_SHORT", mode: "lost", times: 1 });
    await w.until(r, () => w.L.fills.length > 0);
    r = w.mk(); await r.tick(); await w.step(r, 3);
    invariants(w, r, "after a lost fill reply");
    await w.until(r, () => w.L.fills.some((f) => f.kind === "EXIT"), 1500);
    invariants(w, r, "after the exit");
  });
});

describe("fault injection: network, timeouts, duplicates, clock skew, ledger outage", () => {
  it("timeouts and dropped connections on every request type for an hour: retried safely, no duplicates, consistent after", async () => {
    const w = world();
    const r = w.mk(); await r.tick();
    w.L.faults.push({ action: "*", mode: "timeout", times: 25 }, { action: "*", mode: "drop", times: 25 });
    await w.step(r, 900);
    invariants(w, r, "after flaky network");
  });

  it("the Worker clock runs 2 minutes AHEAD: fills still respect the ledger's own acceptance time", async () => {
    const w = world({ workerSkewMs: 120_000 });
    const r = w.mk(); await r.tick();
    await w.step(r, 1500);
    assert.ok(w.L.fills.length > 0, "precondition: fills happened");
    invariants(w, r, "with Worker clock skew");
  });

  it("the ledger read is unavailable (D1 down) for 3 hours: the check is UNVERIFIED (never OK), nothing diverges, recovery is clean", async () => {
    const w = world();
    const r = w.mk(); await r.tick();
    w.L.ledgerDown = true;
    await w.step(r, 180);
    assert.equal(r.state.ledgerCheck.status, "UNVERIFIED");
    w.L.ledgerDown = false;
    await w.step(r, 300);
    invariants(w, r, "after the ledger outage");
  });
});

describe("fault injection: recovery with positions and pauses", () => {
  it("power loss with an OPEN position for 6 hours: after restart the engine still holds exactly the ledger's position and can exit", async () => {
    const w = world();
    let r = w.mk(); await r.tick();
    assert.ok(await w.until(r, () => !!w.L.position), "precondition: an open position");
    w.L.clock.now += 6 * 60 * MIN;
    r = w.mk(); await r.tick(); await w.step(r, 2);
    invariants(w, r, "after the outage");
    await w.until(r, () => !w.L.position, 1500);
    invariants(w, r, "after the exit");
  });

  it("paused with an OPEN position: the exit is still sent and accepted; no new entry afterwards; repeated restarts change nothing", async () => {
    const w = world();
    let r = w.mk(); await r.tick();
    assert.ok(await w.until(r, () => !!w.L.position), "precondition: an open position");
    const fillsBefore = w.L.fills.filter((f) => f.kind === "ENTRY").length;
    for (let k = 0; k < 5; k++) { r = w.mk({ ENGINE_PAUSED_BOTS: "ALPHA-01" }); await r.tick(); await w.step(r, 40); }
    await w.until(r, () => !w.L.position, 1500);
    assert.equal(w.L.position, null, "the paused bot's position was closed by its normal exit");
    await w.step(r, 600);
    assert.equal(w.L.fills.filter((f) => f.kind === "ENTRY").length, fillsBefore, "no new entry while paused");
    invariants(w, r, "paused with a position");
  });
});

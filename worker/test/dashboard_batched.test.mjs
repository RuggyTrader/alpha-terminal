// /api/dashboard CPU (2026-11-17): getDashboardSnapshot reads through autoBatch (worker/src/d1_autobatch.ts) instead of
// ~25 separate D1 round trips. It must return exactly what the per-statement reference returns, on varied data, and use
// far fewer round trips. Also checks the wrapper's own semantics (first/first(col)/raw/all, failure, write ordering).
//   node --test test/dashboard_batched.test.mjs
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { loadHandlers, makeD1, seed } from "../scripts/dashboard-profile.mjs";

let M, AB;
before(async () => {
  M = await loadHandlers("./src/dashboard_api", ["getDashboardSnapshot", "getDashboardSnapshotReference"]);
  AB = await loadHandlers("./src/d1_autobatch", ["autoBatch"]);
  globalThis.fetch = async () => { throw new Error("network disabled in tests"); };
});

const FROZEN = Date.parse("2026-11-17T00:00:00Z");
async function frozen(fn) { const real = Date.now; Date.now = () => FROZEN; try { return await fn(); } finally { Date.now = real; } }
const norm = (r) => JSON.stringify({ ...r, generated_at: "X" });

function variants(db, v) {
  const x = (sql, ...a) => db.raw.prepare(sql).run(...a);
  x(`UPDATE portfolio_wallets SET updated_at = '2026-11-16T00:00:00Z'`); x(`UPDATE engine_state SET updated_at = '2026-11-16 00:00:00'`); // DB-creation-time defaults differ between the two databases
  if (v >= 1) { // an open bot position, a paper position, risk decisions and orders joined to alerts, a legacy trade with a story
    x(`INSERT INTO bot_positions (trade_id, bot_id, symbol, side, status, qty, entry_price, entry_fee_micro, collateral_micro, stop, tp, risk_usd, fee_model, opened_at, mark_price, mark_at)
       VALUES ('OPEN1', 'ALPHA-02', 'SOLUSD', 'LONG', 'OPEN', 0.27, 71.28, 39000, 19250000, 70.9, 72.4, 10, 'ndax', '2026-11-16T23:35:00Z', 71.1, '2026-11-16T23:59:00Z')`);
    x(`INSERT INTO risk_decisions (alert_fk, decided_at, approved, code, reason, side, final_qty, checks_json) VALUES (1, 'now', 1, 'OK', '', 'buy', 0.1, '[{"k":"x"}]'), (2, 'now', 0, 'LIMIT', 'too big', 'sell', 0, 'not json')`);
    x(`INSERT INTO orders (alert_fk, source, client_order_id, symbol, side, qty, order_type, time_in_force, status, submitted_at, updated_at) VALUES (1, 'paper', 'c1', 'SOLUSD', 'buy', 0.1, 'market', 'gtc', 'dry_run_accepted', 'now', 'now')`);
    x(`INSERT INTO trades (symbol, direction, status, entry_qty, entry_avg_price, open_qty, opened_at, closed_at, realized_pnl, fees_usd, gross_pnl, source, open_alert_id, close_alert_id, leg_order_ids_json)
       VALUES ('SOLUSD', 'long', 'CLOSED', '0.12', '81.43', '0', '2026-11-13T00:35:00Z', '2026-11-13T00:40:00Z', '-0.03', '0', '-0.03', 'ALPHA_PAPER', 'A1', 'A2', '[1,2]'),
              ('SOLUSD', 'long', 'OPEN', '0.1', '80', '0.1', '2026-11-13T02:00:00Z', NULL, '0', NULL, NULL, 'ALPHA_PAPER', 'A3', NULL, 'bad json')`);
  }
  if (v === 3) { // an older schema (before migration 0007): readers that tolerate missing bot tables must keep working
    db.raw.exec("DROP TABLE IF EXISTS bot_positions; DROP TABLE IF EXISTS bot_pending_orders; DROP TABLE IF EXISTS bot_fills");
  }
  if (v >= 2 && v !== 3) { // no engine heartbeat key for the legacy dashboard; an empty activity table
    x(`DELETE FROM app_meta WHERE key LIKE 'engine_status%'`);
    x(`DELETE FROM activity_events`);
  }
}

describe("dashboard snapshot: auto-batched reads", () => {
  for (const v of [0, 1, 2, 3]) {
    it(`returns exactly the per-statement reference result (variant ${v})`, async () => {
      const a = makeD1(), b = makeD1(); seed(a); seed(b); variants(a, v); variants(b, v);
      const env = (db) => ({ DB: db, ENABLE_TRADING: "false" });
      const ref = await frozen(() => M.getDashboardSnapshotReference(env(a), 50));
      const got = await frozen(() => M.getDashboardSnapshot(env(b), 50));
      assert.equal(norm(got), norm(ref));
      if (v === 3) assert.ok(b.c.awaits <= a.c.awaits, `older schema (fallback path): ${b.c.awaits} vs ${a.c.awaits}`);
      else {
        assert.ok(b.c.awaits <= 8 && b.c.awaits * 3 < a.c.awaits, `round trips: batched ${b.c.awaits} vs reference ${a.c.awaits}`);
        assert.equal(b.c.statements, a.c.statements, "same statements, only grouped");
      }
    });
  }
});

describe("autoBatch semantics", () => {
  it("first / first(col) / all / raw match D1, and parallel reads share one batch", async () => {
    const db = makeD1(); seed(db);
    const d = AB.autoBatch(db);
    const [one, none, col, all, raw] = await Promise.all([
      d.prepare(`SELECT bot_id FROM bots ORDER BY bot_id LIMIT 1`).first(),
      d.prepare(`SELECT bot_id FROM bots WHERE bot_id = ?`).bind("NOPE").first(),
      d.prepare(`SELECT bot_id FROM bots ORDER BY bot_id LIMIT 1`).first("bot_id"),
      d.prepare(`SELECT bot_id FROM bots ORDER BY bot_id`).all(),
      d.prepare(`SELECT bot_id, symbol FROM bots ORDER BY bot_id LIMIT 1`).raw(),
    ]);
    assert.deepEqual(one, { bot_id: "ALPHA-01" });
    assert.equal(none, null);
    assert.equal(col, "ALPHA-01");
    assert.equal(all.results.length, 4);
    assert.deepEqual(raw, [["ALPHA-01", "SOLUSD"]]);
    assert.equal(d.stats.waves, 1);
    assert.equal(db.c.awaits, 1, "one D1 round trip");
  });
  it("first() of a multi-row result is the FIRST row; all() returns every row (no truncation)", async () => {
    const db = makeD1(); seed(db);
    const d = AB.autoBatch(db);
    const [first, all] = await Promise.all([
      d.prepare(`SELECT id FROM alerts ORDER BY id`).first(),
      d.prepare(`SELECT id FROM alerts ORDER BY id`).all(),
    ]);
    assert.deepEqual(first, { id: 1 });
    assert.equal(all.results.length, 400);
    assert.equal(all.results.at(-1).id, 400);
  });
  it("errors stay per statement: a failing statement fails only itself (the wave is re-run one by one)", async () => {
    const db = makeD1(); seed(db);
    const d = AB.autoBatch(db);
    const r = await Promise.allSettled([d.prepare(`SELECT 1 AS x`).first(), d.prepare(`SELECT * FROM no_such_table`).all()]);
    assert.deepEqual(r.map((x) => x.status), ["fulfilled", "rejected"]);
    assert.deepEqual(r[0].value, { x: 1 });
    assert.equal(d.stats.fallbacks, 1);
    assert.deepEqual(await d.prepare(`SELECT 2 AS y`).first(), { y: 2 });
  });
  it("a write flushes queued reads first and is not batched with them", async () => {
    const db = makeD1(); seed(db);
    const d = AB.autoBatch(db);
    const before = d.prepare(`SELECT COUNT(*) AS n FROM activity_events`).first("n");
    await d.prepare(`INSERT INTO activity_events (ts, category, level, message) VALUES ('t', 'x', 'info', 'm')`).run();
    const after = await d.prepare(`SELECT COUNT(*) AS n FROM activity_events`).first("n");
    assert.equal(await before + 1, after);
  });
});

describe("activity feed: one batched wave", () => {
  it("/api/dashboard/events reads in at most 2 D1 round trips (table list + one batch), first page and older pages", async () => {
    const F = await loadHandlers("./src/events", ["activityFeed", "resetTableCache"]);
    for (const before of [null, "2026-11-16T12:00:00Z"]) {
      F.resetTableCache();
      const db = makeD1(); seed(db);
      const r = await F.activityFeed(db, 30, before);
      assert.ok(r.items.length > 0);
      assert.ok(db.c.awaits <= 2, `round trips: ${db.c.awaits}`);
      if (before) assert.ok(r.items.every((x) => x.at <= before), "an older page holds only items at or before the cursor");
    }
  });
});

// Engine outage detection (src/outage.ts, migration 0009): runs in the Worker cron, independent of the engine's PC.
//   node --test test/outage.test.mjs
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHandlers, makeD1 } from "../scripts/dashboard-profile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let O;
before(async () => { O = await loadHandlers("./src/outage", ["checkEngineOutages", "assess", "offlineAfterMs", "recentOutages"]); });

const NOW = Date.parse("2026-11-17T02:00:00Z"), MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
function world() {
  const db = makeD1();
  const x = (sql, ...a) => db.raw.prepare(sql).run(...a);
  x(`UPDATE bots SET status = 'ACTIVE', ledger_api = 'bot'`);
  x(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, prefs_json, created_at, updated_at) VALUES ('https://fcm.googleapis.com/x1', 'k', 'a', '{}', 'now', 'now'), ('https://fcm.googleapis.com/x2', 'k', 'a', '{}', 'now', 'now')`);
  const report = (bot, receivedAgoMin, candleAgoMin, extra = {}) => x(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`, `engine_status:${bot}`,
    JSON.stringify({ bot_id: bot, received_at: iso(NOW - receivedAgoMin * MIN), last_candle_time: iso(NOW - candleAgoMin * MIN), ...extra }));
  const sent = [];
  const send = async (sub, payload) => { sent.push({ sub: sub.endpoint, ...payload }); return { ok: true, status: 201 }; };
  const run = (now = NOW) => O.checkEngineOutages({ DB: db }, { now, send });
  const rows = () => db.raw.prepare(`SELECT bot_id, kind, started_at, ended_at, alerted_at, alert_devices, recovery_alerted_at FROM engine_outages ORDER BY id`).all().map((r) => ({ ...r }));
  return { db, report, sent, run, rows };
}

describe("engine outage detection", () => {
  it("thresholds: 10 minutes for 1m/5m bots, 3 candles above that; never-reported bots are not outages", () => {
    assert.equal(O.offlineAfterMs(1), 10 * MIN); assert.equal(O.offlineAfterMs(5), 15 * MIN); assert.equal(O.offlineAfterMs(60), 180 * MIN);
    assert.equal(O.assess(null, 5, NOW), null);
    assert.equal(O.assess({ received_at: iso(NOW - 16 * MIN), last_candle_time: iso(NOW - 20 * MIN) }, 5, NOW), "ENGINE_OFFLINE");
    assert.equal(O.assess({ received_at: iso(NOW - 1 * MIN), last_candle_time: iso(NOW - 25 * MIN) }, 5, NOW), "MARKET_DATA_STALE");
    assert.equal(O.assess({ received_at: iso(NOW - 1 * MIN), last_candle_time: iso(NOW - 6 * MIN) }, 5, NOW), null);
  });
  it("healthy fleet (including an engine-paused bot that keeps reporting): nothing opened, nothing sent", async () => {
    const w = world();
    for (const b of ["ALPHA-01", "ALPHA-02", "ALPHA-03", "ALPHA-04"]) w.report(b, 1, 2, b === "ALPHA-01" || b === "ALPHA-03" ? { ledger_check: { entries_paused: true } } : {});
    const r = await w.run();
    assert.equal(r.opened, 0); assert.equal(w.sent.length, 0); assert.equal(w.rows().length, 0);
  });
  it("the whole PC goes down: ONE notification per device naming every bot; no repeat on later ticks; one recovery notice", async () => {
    const w = world();
    for (const b of ["ALPHA-01", "ALPHA-02", "ALPHA-03", "ALPHA-04"]) w.report(b, 20, 21);
    const r1 = await w.run();
    assert.equal(r1.opened, 4); assert.equal(r1.devices, 2);
    assert.equal(w.sent.length, 2, "one message per device");
    assert.match(w.sent[0].title, /engine offline \(all bots\)/);
    assert.match(w.sent[0].body, /SOL Flare: no report since 01:40 UTC/);
    assert.match(w.sent[0].body, /Stops and exits are not managed/);
    for (const t of [1, 2, 3]) await w.run(NOW + t * MIN);
    assert.equal(w.sent.length, 2, "no repeated alerts while the outage lasts");
    for (const b of ["ALPHA-01", "ALPHA-02", "ALPHA-03", "ALPHA-04"]) w.report(b, -10, -9); // reporting again (relative to NOW+10)
    const r2 = await w.run(NOW + 10 * MIN);
    assert.equal(r2.closed, 4); assert.equal(r2.recoveries, 4);
    assert.equal(w.sent.length, 4); assert.match(w.sent[2].title, /back to normal/);
    assert.ok(w.rows().every((x) => x.ended_at && x.alerted_at && x.recovery_alerted_at && x.alert_devices === 2));
    await w.run(NOW + 11 * MIN);
    assert.equal(w.sent.length, 4, "no repeated recovery notice");
  });
  it("one bot's candles stop while its engine reports: MARKET_DATA_STALE, distinct from offline", async () => {
    const w = world();
    for (const b of ["ALPHA-01", "ALPHA-03", "ALPHA-04"]) w.report(b, 1, 2);
    w.report("ALPHA-02", 1, 30);
    const r = await w.run();
    assert.equal(r.opened, 1);
    assert.deepEqual(w.rows().map((x) => [x.bot_id, x.kind]), [["ALPHA-02", "MARKET_DATA_STALE"]]);
    assert.match(w.sent[0].title, /market data delayed · SOL Orbit/);
  });
  it("no devices: the episode is still recorded (visible later), with 0 devices alerted", async () => {
    const w = world();
    w.db.raw.exec(`UPDATE push_subscriptions SET disabled_at = 'now'`);
    w.report("ALPHA-04", 30, 31);
    const r = await w.run();
    assert.equal(r.opened, 1); assert.equal(r.devices, 0);
    assert.equal(w.rows()[0].alert_devices, 0);
    assert.equal((await O.recentOutages(w.db)).length, 1);
  });
  it("before migration 0009: does nothing and never throws", async () => {
    const w = world();
    w.db.raw.exec("DROP TABLE engine_outages");
    w.report("ALPHA-04", 30, 31);
    const r = await w.run();
    assert.equal(r.opened, 0); assert.ok(r.skipped); assert.equal(w.sent.length, 0);
    assert.equal(await O.recentOutages(w.db), null);
  });
});

describe("migration 0009 is purely additive", () => {
  it("every table and index from 0001-0008 is unchanged; it adds only engine_outages and its index", () => {
    const files = readdirSync(join(ROOT, "migrations")).filter((f) => /^\d{4}_/.test(f)).sort();
    const a = new DatabaseSync(":memory:"), b = new DatabaseSync(":memory:");
    for (const f of files.filter((f) => f < "0009")) { const sql = readFileSync(join(ROOT, "migrations", f), "utf8"); a.exec(sql); b.exec(sql); }
    b.exec(readFileSync(join(ROOT, "migrations", "0009_engine_outages.sql"), "utf8"));
    const schema = (db) => db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => ({ ...r }));
    const before = schema(a), after = schema(b);
    assert.deepEqual(after.filter((x) => !/engine_outages/.test(x.name)), before);
    assert.deepEqual(after.filter((x) => /engine_outages/.test(x.name)).map((x) => x.name).sort(), ["engine_outages", "idx_engine_outages_open"]);
    assert.doesNotMatch(readFileSync(join(ROOT, "migrations", "0009_engine_outages.sql"), "utf8"), /\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i);
  });
});

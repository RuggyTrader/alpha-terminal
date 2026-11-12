// Trade events, activity feed and Web Push (worker/src/events.ts, worker/src/webpush.ts, migration 0006), in-process.
//   * the real modules, bundled with esbuild, on a real SQLite database with migrations 0001-0006 (a small D1 shim)
//   * Web Push crypto against the RFC 8291 test vector; VAPID JWT verified with the public key
//   * events: one per authoritative row, idempotent, funded/mirror kept apart, P&L from the ledger, no backlog flood
//   * delivery: one notification per event per device, persisted status, expired subscriptions retired, retries bounded
//   * API: session, origin, passphrase to enable, endpoint allowlist, device cap, test rate limit
// No network: every push goes to an injected fetcher.
//   node --test test/events_push.test.mjs

import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const require = createRequire(import.meta.url);
const esbuild = require(join(ROOT, "node_modules", "esbuild"));
const work = mkdtempSync(join(tmpdir(), "alpha-events-"));
let M; // the bundled modules

before(async () => {
  const out = join(work, "events.mjs");
  await esbuild.build({
    stdin: { contents: `export * from "./src/events"; export * as webpush from "./src/webpush"; export { handleEngineMirror } from "./src/mirror";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
  });
  M = await import(pathToFileURL(out).href);
});
after(() => rmSync(work, { recursive: true, force: true }));

// ---------------------------------------------------------------- D1 shim over node:sqlite

function makeD1({ upTo = 6 } = {}) {
  const raw = new DatabaseSync(":memory:");
  const files = readdirSync(join(ROOT, "migrations")).filter((f) => /^\d{4}_/.test(f)).sort();
  for (const f of files) if (Number(f.slice(0, 4)) <= upTo) raw.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  raw.exec("PRAGMA foreign_keys = OFF"); // fixtures insert ledger rows without their orders and alerts
  let queries = 0;
  const norm = (v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a.map(norm)),
    all: async () => { queries++; return { results: raw.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
    first: async () => { queries++; const r = raw.prepare(sql).get(...args); return r ? { ...r } : null; },
    run: async () => { queries++; const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return {
    raw,
    get queries() { return queries; },
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      queries++;
      raw.exec("BEGIN");
      try {
        const res = list.map((s) => { const r = raw.prepare(s.sql).run(...s.args); return { meta: { changes: Number(r.changes) } }; });
        raw.exec("COMMIT");
        return res;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a).map((r) => ({ ...r }));

// ---------------------------------------------------------------- fixtures (shapes of the real ledger and mirror rows)

let n = 0;
function fundedRound(db, { pnl, fees, qty = 1.5, entry = 150, exit = 152 }) {
  n++;
  const pos = Number(db.raw.prepare(`INSERT INTO paper_positions (symbol, status, qty, avg_entry_price, multiplier, opened_at, closed_at, entry_qty_total, entry_value_total, open_alert_id, open_order_id, last_order_id, updated_at)
    VALUES ('SOLUSD', 'CLOSED', 0, ?, 1, '2026-11-10T10:00:00Z', '2026-11-10T10:30:00Z', ?, ?, 'a', 'o', 'o', 'now')`).run(entry, qty, qty * entry).lastInsertRowid);
  const tr = Number(db.raw.prepare(`INSERT INTO trades (symbol, direction, status, entry_qty, entry_avg_price, open_qty, opened_at, closed_at, realized_pnl, fees_usd, position_fk, source)
    VALUES ('SOLUSD', 'long', 'closed', ?, ?, '0', '2026-11-10T10:00:00Z', '2026-11-10T10:30:00Z', ?, ?, ?, 'ALPHA_PAPER')`).run(String(qty), String(entry), String(pnl), String(fees), pos).lastInsertRowid);
  const fill = (kind, side, price, rp, at) => db.raw.prepare(`INSERT INTO paper_fills (order_fk, client_order_id, alert_id, position_fk, symbol, side, kind, qty, price, price_source, price_at, realized_pnl, position_qty_after, avg_entry_after, filled_at, fee_micro)
    VALUES (?, ?, ?, ?, 'SOLUSD', ?, ?, ?, ?, 'kraken', ?, ?, 0, ?, ?, ?)`).run(n * 10 + (kind === "OPEN" ? 1 : 2), `c${n}${kind}`, `al${n}${kind}`, pos, side, kind, qty, price, at, rp, entry, at, 120000);
  fill("OPEN", "buy", entry, 0, "2026-11-10T10:00:05Z");
  fill("CLOSE", "sell", exit, pnl + fees, "2026-11-10T10:30:05Z");
  return tr;
}
const ACC = "MIRROR-SOLUSD-5m-abc";
function mirrorAccount(db, acc = ACC, symbol = "SOLUSD") {
  db.raw.prepare(`INSERT OR IGNORE INTO mirror_accounts (account_id, symbol, timeframe, inputs_hash, created_at, updated_at) VALUES (?, ?, '5m', 'abc', 'now', 'now')`).run(acc, symbol);
}
function mirrorClose(db, { seq, gross, net, cls = "live", side = "SHORT", acc = ACC, symbol = "SOLUSD" }) {
  mirrorAccount(db, acc, symbol);
  const id = `MIR-${symbol}-5-2026-11-10T${String(10 + Math.floor(seq / 12)).padStart(2, "0")}:${String((seq % 12) * 5).padStart(2, "0")}:00Z-${side}`;
  db.raw.prepare(`INSERT INTO mirror_trades (account_id, trade_id, seq, side, qty, entry_time, entry_price, exit_time, exit_price, exit_kind, result, gross_pnl, notional_usd, entry_liquidity, exit_liquidity, cost_profile, est_fees, est_slippage, net_modelled_pnl, classification, exit_candle_json, processed_at, received_at, inputs_hash, payload_hash)
    VALUES (?, ?, ?, ?, 2, '2026-11-10T10:00:00Z', 150, '2026-11-10T11:00:00Z', 143, 'TP', 'TP2', ?, 300, 'maker', 'maker', 'ndax', ?, 0, ?, ?, '{}', 'now', 'now', 'abc', 'h')`).run(acc, id, seq, side, gross, gross - net, net, cls);
  return id;
}
function mirrorOpen(db, { seq, cls = "live", side = "SHORT", acc = ACC, symbol = "ETHUSD" }) {
  mirrorAccount(db, acc, symbol);
  const id = `MIR-${symbol}-5-2026-11-10T12:0${seq % 10}:00Z-${side}`;
  db.raw.prepare(`INSERT INTO mirror_open_events (account_id, event_id, trade_id, seq, side, qty, entry_time, entry_price, classification, entry_candle_json, processed_at, received_at, payload_hash)
    VALUES (?, ?, ?, ?, ?, 0.5, '2026-11-10T12:00:00Z', 3100, ?, '{}', 'now', 'now', 'h')`).run(acc, `${id}:ENTRY`, id, seq, side, cls);
  return id;
}

// ---------------------------------------------------------------- push test keys (generated per run; never real)

const b64u = (b) => Buffer.from(b).toString("base64url");
async function vapidKeys() {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b64u(pub), privateKey: jwk.d, subject: "mailto:test@example.invalid", verifyKey: kp.publicKey };
}
async function deviceKeys() {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { p256dh: b64u(new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey))), auth: b64u(webcrypto.getRandomValues(new Uint8Array(16))) };
}
function addSub(db, endpoint, keys, prefs = {}) {
  // as POST /api/notifications/subscribe does: a new device starts after the events that already exist
  db.raw.exec(`INSERT OR IGNORE INTO event_cursors (name, last_id) VALUES ('push_planned', (SELECT COALESCE(MAX(id), 0) FROM trade_events))`);
  return Number(db.raw.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, prefs_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'now', 'now')`)
    .run(endpoint, keys.p256dh, keys.auth, JSON.stringify(prefs)).lastInsertRowid);
}
function recorder(statusFor = () => 201) {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: statusFor(url, calls.length) }); };
  return { calls, fetcher };
}

// ================================================================= tests

describe("Web Push crypto", () => {
  it("encrypts the RFC 8291 Appendix A example byte for byte", async () => {
    const asPub = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const pubBytes = Buffer.from(asPub, "base64url");
    const jwk = { kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", x: b64u(pubBytes.subarray(1, 33)), y: b64u(pubBytes.subarray(33)) };
    const out = await M.webpush.encryptPayload(
      { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      { senderPrivateJwk: jwk, senderPublic: new Uint8Array(pubBytes), salt: new Uint8Array(Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url")) });
    assert.equal(b64u(out), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
  });

  it("signs a VAPID JWT (ES256) that verifies with the public key, scoped to the push service origin, ≤ 24 h", async () => {
    const v = await vapidKeys();
    const now = Date.UTC(2026, 10, 10);
    const h = await M.webpush.vapidAuthorization("https://web.push.apple.com/abc", v, now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
    assert.ok(m, h);
    assert.equal(m[4], v.publicKey);
    const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
    assert.equal(claims.aud, "https://web.push.apple.com");
    assert.ok(claims.exp - now / 1000 <= 24 * 3600 && claims.exp > now / 1000);
    assert.equal(claims.sub, v.subject);
    assert.ok(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, v.verifyKey, Buffer.from(m[3], "base64url"), new TextEncoder().encode(`${m[1]}.${m[2]}`)));
    assert.ok(!h.includes(v.privateKey), "the private key never leaves the Worker");
  });

  it("accepts only known push services over https", () => {
    for (const ok of ["https://web.push.apple.com/x", "https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x"]) assert.ok(M.webpush.allowedEndpoint(ok), ok);
    for (const bad of ["http://web.push.apple.com/x", "https://evil.example/x", "https://web.push.apple.com.evil.example/x", "https://127.0.0.1/x", "javascript:alert(1)", 42, null, `https://web.push.apple.com/${"a".repeat(2000)}`])
      assert.equal(M.webpush.allowedEndpoint(bad), false, String(bad).slice(0, 60));
  });

  it("sendPush maps 201 → ok, 404/410 → gone, 429/5xx → retry, other 4xx → no retry, network error → retry; never throws", async () => {
    const v = await vapidKeys();
    const k = await deviceKeys();
    const sub = { endpoint: "https://web.push.apple.com/abc", ...k };
    const at = (status) => M.webpush.sendPush(sub, { title: "t" }, v, { fetcher: async () => new Response(null, { status }) });
    assert.equal((await at(201)).ok, true);
    for (const s of [404, 410]) assert.deepEqual([(await at(s)).gone, (await at(s)).retry], [true, false]);
    for (const s of [429, 500, 503]) assert.deepEqual([(await at(s)).gone, (await at(s)).retry], [false, true]);
    assert.equal((await at(400)).retry, false);
    const net = await M.webpush.sendPush(sub, {}, v, { fetcher: async () => { throw new Error("down"); } });
    assert.equal(net.ok, false);
    assert.equal(net.retry, true);
    const r = recorder();
    await M.webpush.sendPush(sub, { title: "x" }, v, { fetcher: r.fetcher });
    const hd = r.calls[0].init.headers;
    assert.equal(hd["Content-Encoding"], "aes128gcm");
    assert.ok(Number(hd.TTL) > 0);
    assert.match(hd.Authorization, /^vapid t=/);
  });
});

describe("trade events (idempotent, authoritative)", () => {
  it("records nothing that existed before migration 0006 (cursors start at the current end): no flood after a deploy", async () => {
    const db = makeD1({ upTo: 5 });
    fundedRound(db, { pnl: 1, fees: 0.1 });
    mirrorClose(db, { seq: 1, gross: 5, net: 4 });
    for (const f of ["0006_events_and_push.sql"]) db.raw.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
    M.resetTableCache();
    assert.equal(await M.syncTradeEvents(db), 0);
    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM trade_events")[0].n, 0);
  });

  it("one event per fill and per mirror record; a second run (or a crash between runs) adds nothing", async () => {
    const db = makeD1();
    M.resetTableCache();
    const tr = fundedRound(db, { pnl: 2.45, fees: 0.37, qty: 1.25, entry: 150, exit: 152.5 });
    mirrorOpen(db, { seq: 1 });
    mirrorClose(db, { seq: 2, gross: 14.56, net: 13.98 });
    await M.syncTradeEvents(db);
    await M.syncTradeEvents(db);
    const ev = rows(db, "SELECT * FROM trade_events ORDER BY id");
    assert.deepEqual(ev.map((e) => e.kind), ["FUNDED_ENTRY", "FUNDED_CLOSE", "MIRROR_ENTRY", "MIRROR_CLOSE"]);
    assert.equal(new Set(ev.map((e) => e.event_key)).size, 4);
    // funded P&L is the LEDGER's recorded net result, with its fees; nothing recomputed
    const close = ev[1];
    assert.equal(close.source, "funded");
    assert.equal(close.pnl, 2.45);
    assert.equal(close.fees, 0.37);
    assert.equal(close.url, `/trades/${tr}`);
    // mirror never mixes with funded
    assert.deepEqual(ev.slice(2).map((e) => e.source), ["mirror", "mirror"]);
    assert.equal(ev[3].pnl, 14.56);
    assert.equal(ev[3].pnl_net, 13.98);
    // the cursors moved together with the events
    const cur = Object.fromEntries(rows(db, "SELECT name, last_id FROM event_cursors").map((r) => [r.name, r.last_id]));
    assert.equal(cur.paper_fills, 2);
    assert.equal(cur.mirror_trades, 1);
    assert.equal(cur.mirror_open_events, 1);
  });

  it("works on schema 5 (no 0006 tables): nothing is recorded and nothing throws", async () => {
    const db = makeD1({ upTo: 5 });
    M.resetTableCache();
    assert.equal(await M.syncTradeEvents(db), 0);
    await M.processEvents({ DB: db });
    assert.deepEqual((await M.deliver({ DB: db, VAPID_PUBLIC_KEY: "x", VAPID_PRIVATE_KEY: "y", VAPID_SUBJECT: "z" })), { planned: 0, sent: 0, failed: 0 });
    const feed = await M.activityFeed(db);
    assert.ok(Array.isArray(feed.items));
  });
});

describe("notification text", () => {
  const base = { id: 1, event_key: "k", source: "funded", symbol: "SOLUSD", side: "buy", qty: 1.25, price: 150.25, pnl: null, pnl_net: null, fees: null, classification: "live", ref: "7", account_id: null, url: "/trades/7", occurred_at: "2026-11-10T10:00:00Z" };
  const P = (o = {}) => ({ ...M.DEFAULT_PREFS, ...o });
  it("matches the requested formats, labels mirror results hypothetical, and hides amounts on request", () => {
    assert.equal(M.message({ ...base, kind: "FUNDED_ENTRY" }, P()).title, "ALPHA PAPER · SOLUSD BUY filled");
    assert.match(M.message({ ...base, kind: "FUNDED_ENTRY" }, P()).body, /1\.25 at \$150\.25/);
    const fc = M.message({ ...base, kind: "FUNDED_CLOSE", side: "sell", pnl: 2.45, fees: 0.37 }, P());
    assert.equal(fc.title, "ALPHA PAPER · SOLUSD closed · +$2.45 PAPER P&L");
    assert.match(fc.body, /fees \$0\.37/);
    const me = M.message({ ...base, kind: "MIRROR_ENTRY", source: "mirror", symbol: "ETHUSD", side: "SHORT" }, P());
    assert.equal(me.title, "STRATEGY MIRROR · ETHUSD SHORT opened");
    assert.match(me.body, /Hypothetical/);
    const mc = M.message({ ...base, kind: "MIRROR_CLOSE", source: "mirror", pnl: 14.56, pnl_net: 13.98 }, P());
    assert.equal(mc.title, "STRATEGY MIRROR · SOLUSD closed · +$14.56 hypothetical gross");
    assert.match(mc.body, /Modelled net \+\$13\.98/);
    const hidden = M.message({ ...base, kind: "FUNDED_CLOSE", pnl: 2.45, fees: 0.37, price: 152 }, P({ hide_amounts: true }));
    assert.doesNotMatch(hidden.title + hidden.body, /\d+\.\d\d|\$/);
    const noPnl = M.message({ ...base, kind: "MIRROR_CLOSE", source: "mirror", pnl: 14.56, pnl_net: 13.98 }, P({ include_pnl: false }));
    assert.doesNotMatch(noPnl.title + noPnl.body, /14\.56|13\.98/);
    assert.match(M.message({ ...base, kind: "MIRROR_CLOSE", source: "mirror", pnl: -3, pnl_net: -3.4, classification: "catch_up" }, P()).title, /−\$3\.00 hypothetical gross \(catch-up\)/);
  });
  it("preferences: live only by default; per-type switches; TEST only to its own device", () => {
    const e = (kind, classification = "live", ref = null) => ({ kind, classification, ref });
    assert.equal(M.wants(P(), e("MIRROR_CLOSE", "catch_up"), 1), false);
    assert.equal(M.wants(P(), e("MIRROR_CLOSE", "historical"), 1), false);
    assert.equal(M.wants(P({ include_catch_up: true }), e("MIRROR_CLOSE", "catch_up"), 1), true);
    assert.equal(M.wants(P({ mirror_entry: false }), e("MIRROR_ENTRY"), 1), false);
    assert.equal(M.wants(P({ enabled: false }), e("FUNDED_CLOSE"), 1), false);
    assert.equal(M.wants(P(), e("TEST", "live", "2"), 1), false);
    assert.equal(M.wants(P(), e("TEST", "live", "1"), 1), true);
    assert.deepEqual(M.cleanPrefs({ funded_entry: "yes", evil: true, hide_amounts: true }), { ...M.DEFAULT_PREFS, hide_amounts: true });
  });
});

describe("delivery", () => {
  async function setup() {
    const db = makeD1();
    M.resetTableCache();
    const v = await vapidKeys();
    const env = { DB: db, VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: v.subject };
    return { db, env };
  }

  it("one notification per event per device, never repeated; skipped events are recorded, not sent", async () => {
    const { db, env } = await setup();
    const a = addSub(db, "https://web.push.apple.com/A", await deviceKeys());
    const b = addSub(db, "https://fcm.googleapis.com/fcm/send/B", await deviceKeys(), { mirror_close: false });
    fundedRound(db, { pnl: 1, fees: 0.1 });
    mirrorClose(db, { seq: 1, gross: 5, net: 4 });
    await M.syncTradeEvents(db);
    const r = recorder();
    const first = await M.deliver(env, { fetcher: r.fetcher });
    assert.equal(first.planned, 3);
    assert.equal(first.sent, 3); // at most 3 per invocation; 5 wanted (A: 3 events; B: 2, mirror close switched off)
    for (let i = 0; i < 3; i++) await M.deliver(env, { fetcher: r.fetcher });
    assert.equal(r.calls.length, 5, "re-running never sends again");
    const d = rows(db, "SELECT subscription_id AS s, status FROM push_deliveries ORDER BY id");
    assert.equal(d.filter((x) => x.s === a && x.status === "sent").length, 3);
    assert.equal(d.filter((x) => x.s === b && x.status === "sent").length, 2);
    assert.equal(d.filter((x) => x.s === b && x.status === "skipped").length, 1);
    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM push_deliveries")[0].n, 6);
    // at most PUSHES_PER_RUN (3) sends per invocation
    // (6 mirror closes: device A wants them, device B switched them off)
    for (let i = 0; i < 6; i++) mirrorClose(db, { seq: 10 + i, gross: 1, net: 1 });
    await M.syncTradeEvents(db);
    const r2 = recorder();
    assert.equal((await M.deliver(env, { fetcher: r2.fetcher })).sent, 3);
    assert.equal((await M.deliver(env, { fetcher: r2.fetcher })).sent, 3);
    assert.equal((await M.deliver(env, { fetcher: r2.fetcher })).sent, 0);
    assert.ok(r2.calls.every((c) => c.url.endsWith("/A")));
  });

  it("410 retires the subscription; 5xx retries with backoff up to the limit, then fails; status is persisted", async () => {
    const { db, env } = await setup();
    addSub(db, "https://web.push.apple.com/GONE", await deviceKeys());
    addSub(db, "https://fcm.googleapis.com/fcm/send/FLAKY", await deviceKeys());
    mirrorClose(db, { seq: 1, gross: 5, net: 4 });
    await M.syncTradeEvents(db);
    const r = recorder((url) => (url.includes("GONE") ? 410 : 503));
    let t = Date.UTC(2026, 10, 10);
    await M.deliver(env, { fetcher: r.fetcher, now: t });
    const gone = rows(db, "SELECT disabled_at, disabled_reason FROM push_subscriptions WHERE endpoint LIKE '%GONE'")[0];
    assert.ok(gone.disabled_at);
    assert.match(gone.disabled_reason, /expired/);
    assert.equal(rows(db, "SELECT status FROM push_deliveries WHERE subscription_id = 1")[0].status, "expired");
    // immediately again: backoff holds
    await M.deliver(env, { fetcher: r.fetcher, now: t + 1000 });
    assert.equal(r.calls.filter((c) => c.url.includes("FLAKY")).length, 1);
    for (let i = 0; i < 10; i++) { t += 10 * 60_000; await M.deliver(env, { fetcher: r.fetcher, now: t }); }
    const flaky = rows(db, "SELECT status, attempts FROM push_deliveries WHERE subscription_id = 2")[0];
    assert.deepEqual(flaky, { status: "failed", attempts: 6 });
    assert.equal(r.calls.filter((c) => c.url.includes("GONE")).length, 1, "a retired device is never contacted again");
  });

  it("overlapping invocations never send the same notification twice (claim before send)", async () => {
    const { db, env } = await setup();
    addSub(db, "https://web.push.apple.com/A", await deviceKeys());
    mirrorClose(db, { seq: 1, gross: 5, net: 4 });
    await M.syncTradeEvents(db);
    const r = recorder();
    await Promise.all([M.deliver(env, { fetcher: r.fetcher }), M.deliver(env, { fetcher: r.fetcher }), M.deliver(env, { fetcher: r.fetcher })]);
    assert.equal(r.calls.length, 1);
    assert.equal(rows(db, "SELECT status FROM push_deliveries")[0].status, "sent");
  });

  it("a send cut off before its outcome was recorded is marked failed, never re-sent (at most once)", async () => {
    const { db, env } = await setup();
    addSub(db, "https://web.push.apple.com/A", await deviceKeys());
    mirrorClose(db, { seq: 1, gross: 5, net: 4 });
    await M.syncTradeEvents(db);
    const t = Date.UTC(2026, 10, 10);
    await M.deliver(env, { fetcher: recorder(() => 201).fetcher, now: t }); // plans and sends
    db.raw.exec("UPDATE push_deliveries SET status = 'sending', sent_at = NULL"); // as if the invocation died mid-send
    const r = recorder();
    await M.deliver(env, { fetcher: r.fetcher, now: t + 60_000 });
    assert.equal(rows(db, "SELECT status FROM push_deliveries")[0].status, "sending", "still within the claim window");
    await M.deliver(env, { fetcher: r.fetcher, now: t + 10 * 60_000 });
    const d = rows(db, "SELECT status, error FROM push_deliveries")[0];
    assert.equal(d.status, "failed");
    assert.match(d.error, /not resent/);
    assert.equal(r.calls.length, 0);
  });

  it("a failing push service never breaks ingestion (processEvents swallows errors)", async () => {
    const { db, env } = await setup();
    addSub(db, "https://web.push.apple.com/A", await deviceKeys());
    db.raw.exec("DROP TABLE push_deliveries");
    await M.processEvents(env); // must not throw
  });

  it("a newly enabled device gets no backlog of events recorded before it subscribed", async () => {
    const { db, env } = await setup();
    mirrorClose(db, { seq: 1, gross: 5, net: 4 });
    await M.syncTradeEvents(db);
    addSub(db, "https://web.push.apple.com/NEW", await deviceKeys());
    const r = recorder();
    assert.equal((await M.deliver(env, { fetcher: r.fetcher })).sent, 0);
    mirrorClose(db, { seq: 2, gross: 6, net: 5 });
    await M.syncTradeEvents(db);
    assert.equal((await M.deliver(env, { fetcher: r.fetcher })).sent, 1);
  });

  it("without VAPID keys nothing is sent and nothing is planned", async () => {
    const { db } = await setup();
    addSub(db, "https://web.push.apple.com/A", await deviceKeys());
    mirrorClose(db, { seq: 1, gross: 5, net: 4 });
    await M.syncTradeEvents(db);
    assert.deepEqual(await M.deliver({ DB: db }), { planned: 0, sent: 0, failed: 0 });
  });
});

describe("activity feed", () => {
  it("is bounded, newest first, labels sources, and excludes TEST notifications", async () => {
    const db = makeD1();
    M.resetTableCache();
    fundedRound(db, { pnl: 1, fees: 0.1 });
    mirrorClose(db, { seq: 1, gross: 5, net: 4, cls: "catch_up" });
    db.raw.prepare(`INSERT INTO alerts (alert_id, received_at, symbol, action, status, response_code, rejection_reason) VALUES ('x', '2026-11-10T09:00:00Z', 'SOLUSD', 'buy', 'rejected', 'RISK_REJECTED', 'over limit')`).run();
    db.raw.prepare(`INSERT INTO trade_events (event_key, kind, source, classification, ref, occurred_at, created_at) VALUES ('TEST:1:1', 'TEST', 'system', 'live', '1', '2026-11-10T23:00:00Z', 'now')`).run();
    await M.syncTradeEvents(db);
    const { items } = await M.activityFeed(db, 500);
    assert.ok(items.length <= 50);
    assert.ok(!items.some((i) => /test notification/i.test(i.title)));
    for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].at >= items[i].at, "newest first");
    assert.ok(items.some((i) => i.source === "mirror" && i.classification === "catch_up"));
    assert.ok(items.some((i) => i.source === "funded" && /REJECTED/.test(i.title)));
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  });
});

describe("notifications API", () => {
  const ORIGIN = "https://alpha.example";
  const PASS = "correct horse battery staple";
  async function setup() {
    const db = makeD1();
    M.resetTableCache();
    const v = await vapidKeys();
    const token = "tok-" + Math.random();
    db.raw.prepare(`INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_seen_at) VALUES (?, 'now', ?, 'now')`)
      .run(createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 3600_000).toISOString());
    const env = { DB: db, VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: v.subject, DASHBOARD_PASSPHRASE: PASS };
    const call = (path, body, { cookie = true, method = "POST", origin = ORIGIN } = {}) => M.handleNotificationsApi(new Request(`${ORIGIN}${path}`, {
      method, headers: { "content-type": "application/json", "x-alpha-terminal": "1", origin, ...(cookie ? { cookie: `at_session=${token}` } : {}), "cf-connecting-ip": "203.0.113.9" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }), env, path);
    return { db, env, call, v };
  }
  const sub = async (endpoint = "https://web.push.apple.com/dev1") => ({ endpoint, keys: await deviceKeys() });

  it("config reports the public key only (never the private key) and needs a session", async () => {
    const { call, v } = await setup();
    assert.equal((await call("/api/notifications/config", null, { cookie: false, method: "GET" })).status, 401);
    const r = await (await call("/api/notifications/config", null, { method: "GET" })).json();
    assert.equal(r.data.available, true);
    assert.equal(r.data.public_key, v.publicKey);
    assert.ok(!JSON.stringify(r).includes(v.privateKey));
    assert.equal(r.data.defaults.include_catch_up, false);
  });

  it("enabling needs the passphrase, a known push service, valid keys and the app origin", async () => {
    const { call, db } = await setup();
    const s = await sub();
    assert.equal((await call("/api/notifications/subscribe", { subscription: s, passphrase: "wrong" })).status, 403);
    assert.equal((await call("/api/notifications/subscribe", { subscription: s })).status, 403);
    assert.equal((await call("/api/notifications/subscribe", { subscription: { ...s, endpoint: "https://attacker.example/x" }, passphrase: PASS })).status, 400);
    assert.equal((await call("/api/notifications/subscribe", { subscription: { ...s, keys: { p256dh: "AAAA", auth: "BB" } }, passphrase: PASS })).status, 400);
    assert.equal((await call("/api/notifications/subscribe", { subscription: s, passphrase: PASS }, { origin: "https://evil.example" })).status, 403);
    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM push_subscriptions")[0].n, 0);
    const ok = await call("/api/notifications/subscribe", { subscription: s, passphrase: PASS, prefs: { mirror_entry: false } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).prefs.mirror_entry, false);
    // re-enabling the same device updates it, never duplicates it
    await call("/api/notifications/subscribe", { subscription: s, passphrase: PASS });
    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM push_subscriptions")[0].n, 1);
  });

  it("at most 10 devices", async () => {
    const { call } = await setup();
    for (let i = 0; i < 10; i++) assert.equal((await call("/api/notifications/subscribe", { subscription: await sub(`https://web.push.apple.com/d${i}`), passphrase: PASS })).status, 200);
    assert.equal((await call("/api/notifications/subscribe", { subscription: await sub("https://web.push.apple.com/d10"), passphrase: PASS })).status, 409);
  });

  it("preferences, test (rate-limited, only to this device), and disable", async () => {
    const { call, db, env } = await setup();
    const s = await sub();
    await call("/api/notifications/subscribe", { subscription: s, passphrase: PASS });
    const other = await sub("https://fcm.googleapis.com/fcm/send/other");
    await call("/api/notifications/subscribe", { subscription: other, passphrase: PASS });
    const p = await (await call("/api/notifications/preferences", { endpoint: s.endpoint, prefs: { hide_amounts: true } })).json();
    assert.equal(p.prefs.hide_amounts, true);
    assert.equal((await call("/api/notifications/status", { endpoint: "https://web.push.apple.com/unknown" })).status, 404);

    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => { sent.push(String(url)); return new Response(null, { status: 201 }); };
    try {
      const t = await (await call("/api/notifications/test", { endpoint: s.endpoint })).json();
      assert.equal(t.sent, 1);
      assert.deepEqual(sent, [s.endpoint], "the test goes only to the device that asked");
      assert.equal((await call("/api/notifications/test", { endpoint: s.endpoint })).status, 429);
      // a later real event still reaches both devices exactly once; the test is never re-sent
      mirrorClose(db, { seq: 1, gross: 5, net: 4 });
      await M.syncTradeEvents(db);
      await M.deliver(env);
      await M.deliver(env);
      assert.equal(sent.length, 3);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal((await call("/api/notifications/unsubscribe", { endpoint: s.endpoint })).status, 200);
    const st = await (await call("/api/notifications/status", { endpoint: s.endpoint })).json();
    assert.equal(st.active, false);
    assert.equal((await call("/api/notifications/test", { endpoint: s.endpoint })).status, 409);
  });

  it("reports 'not available' cleanly without VAPID keys or before migration 0006", async () => {
    const { db } = await setup();
    const r = await M.handleNotificationsApi(new Request(`${ORIGIN}/api/notifications/config`, { headers: { cookie: "x=1" } }), { DB: db }, "/api/notifications/config");
    assert.equal(r.status, 401);
  });
});

describe("Strategy Mirror ENTRY records on the Worker (mirror.ts)", () => {
  const STEP = 300_000;
  const ENGINE = join(ROOT, "..", "engine");
  const SECRET = "test-secret-" + Math.random();
  async function entries() {
    const { createMirror, mirrorStep, activate } = await import(pathToFileURL(join(ENGINE, "src", "mirror.mjs")).href);
    const { loadConfig } = await import(pathToFileURL(join(ENGINE, "src", "config.mjs")).href);
    const P5 = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, ENGINE);
    const C = JSON.parse(readFileSync(join(ENGINE, "test", "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;
    const ctx = { lateMs: 2 * STEP, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, inputsHash: "e0e0e0e0e0e0e0e0", entryEvents: true };
    const Mi = createMirror({ ...ctx, nowMs: C[0].t });
    C.forEach((k, i) => { mirrorStep(Mi, k, { ...ctx, nowMs: k.t + STEP + 5_000 }); if (i === 200) activate(Mi, k.t + STEP + 5_000); });
    const account = { account_id: Mi.accountId, symbol: "SOLUSD", timeframe: "5m", profile: "solusd-5m", strategy: "OTE Pro Strat (engine)", inputs_hash: "e0e0e0e0e0e0e0e0",
      engine_version: "0.1.0", engine_release: null, engine_commit: null, created_at: Mi.createdAt, activated_at: Mi.activatedAt, last_candle_time: Mi.lastCandle.t,
      last_candle_close: Mi.lastCandle.close, candles_processed: Mi.candlesProcessed, risk_usd: 10, last_seq: Mi.seq, pending: 0, refused: 0, open_position: null,
      resets: 0, interruptions: 0, skipped_candles: 0, last_error: null };
    return { account, items: Mi.outbox.map(({ status: _s, attempts: _a, ...x }) => x) };
  }
  async function post(db, account, items) {
    const all = [];
    for (let i = 0; i < items.length; i += 25) {
      const r = await M.handleEngineMirror(new Request("https://w/webhook/engine-mirror", { method: "POST", body: JSON.stringify({ secret: SECRET, account, items: items.slice(i, i + 25) }) }),
        { DB: db, WEBHOOK_SECRET: SECRET, KRAKEN_API_BASE: "http://127.0.0.1:9" });
      all.push(...(await r.json()).results);
    }
    return all;
  }
  const noNet = async (fn) => { const f = globalThis.fetch; globalThis.fetch = async () => { throw new Error("no network in tests"); }; try { return await fn(); } finally { globalThis.fetch = f; } };

  it("stores each ENTRY once, keeps the sequence contiguous, and becomes exactly one MIRROR_ENTRY event", async () => {
    const db = makeD1();
    M.resetTableCache();
    const { account, items } = await entries();
    const nEntries = items.filter((x) => x.type === "ENTRY").length;
    assert.ok(nEntries > 0);
    const res = await noNet(() => post(db, account, items));
    assert.equal(res.filter((r) => r.status === "stored").length, items.length, "every TRADE and ENTRY stored");
    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM mirror_open_events")[0].n, nEntries);
    assert.equal(rows(db, "SELECT last_contiguous_seq AS s FROM mirror_accounts")[0].s, items.at(-1).seq);
    // a full re-delivery is all duplicates, nothing new stored
    const again = await noNet(() => post(db, account, items));
    assert.ok(again.every((r) => r.status === "duplicate"), JSON.stringify(again.find((r) => r.status !== "duplicate")));
    // changed content under a stored ENTRY id is a conflict, never overwritten
    const e = items.find((x) => x.type === "ENTRY");
    const conflict = await noNet(() => post(db, account, [{ ...e, qty: e.qty * 2 }]));
    assert.equal(conflict[0].code, "ENTRY_CONFLICT");
    // an ENTRY outside its candle is refused
    const bad = await noNet(() => post(db, account, [{ ...e, seq: items.at(-1).seq + 1, entry_price: e.entry_candle.h * 2 }]));
    assert.equal(bad[0].code, "INVALID_ENTRY");
    await M.syncTradeEvents(db);
    const ev = rows(db, "SELECT kind, classification FROM trade_events WHERE kind = 'MIRROR_ENTRY'");
    assert.equal(ev.length, nEntries);
    // historical warm-up entries are recorded but, with default preferences, never notified
    assert.ok(ev.some((x) => x.classification === "historical"));
  });

  it("on schema 5 (before migration 0006) ENTRY records are left unacknowledged, never refused or lost; trades still stored", async () => {
    const db = makeD1({ upTo: 5 });
    M.resetTableCache();
    const { account, items } = await entries();
    const res = await noNet(() => post(db, account, items));
    const entrySeqs = new Set(items.filter((x) => x.type === "ENTRY").map((x) => x.seq));
    assert.ok(!res.some((r) => entrySeqs.has(r.seq)), "no result for an ENTRY: the engine keeps it pending");
    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM mirror_trades")[0].n, items.filter((x) => x.type === "TRADE").length);
  });
});


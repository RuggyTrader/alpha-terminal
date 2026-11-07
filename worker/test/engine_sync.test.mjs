// Development-environment sync test: the OTE engine (engine/) → the real Worker on `wrangler dev --local` with
// throwaway D1 databases. Never touches production. The engine replays real Kraken SOLUSD 5m candles from the
// engine's fixture one completed candle at a time; the Worker prices ALPHA PAPER fills from live Kraken data and
// reads the Alpaca PAPER account (GET only), so this needs PAPER keys in worker/.dev.vars, otherwise it skips.
//
// Two isolated Workers: one runs the engine with the Pine default risk ($200, orders far above the $5,000 limit),
// one with the `paper-test` profile ($5 risk). Fixture trades (strict pivot rule): SHORT, then LONG, then LONG.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { EngineRunner } from "../../engine/src/runner.mjs";
import { loadConfig } from "../../engine/src/config.mjs";
import { runBacktest } from "../../engine/src/cli/backtest.mjs";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_DIR = join(WORKER_DIR, "..", "engine");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const keys = existsSync(join(WORKER_DIR, ".dev.vars")) ? readFileSync(join(WORKER_DIR, ".dev.vars"), "utf8").split(/\r?\n/).map((l) => l.split("=")[0].trim()) : [];
const needsBroker = keys.includes("ALPACA_KEY") && keys.includes("ALPACA_SECRET") ? {} : { skip: "ALPACA_KEY / ALPACA_SECRET (PAPER) not in worker/.dev.vars" };

const CANDLES = JSON.parse(readFileSync(join(ENGINE_DIR, "test", "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;
const STEP = 300_000;
// The sync scenarios need the fixture's LONG trades (ALPHA PAPER is long-only). They exist with the strict pivot
// rule; with TradingView's rule (the engine default) this short fixture only trades short. Ledger sync does not depend
// on the strategy rule, so these tests pin the strict rule for both the expected fills and the runner.
const PIVOTS = { left: "strict", right: "strict" };
const FILLS = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5, pivotTies: PIVOTS }).events
  .filter((e) => e.type === "ENTRY_FILL" || e.type === "EXIT_FILL").map((e) => e.bar);

const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 90000 });
const temps = [];

/** One isolated local Worker + D1, and an engine runner replaying the fixture against it. */
function environment(port, profile) {
  const persist = mkdtempSync(join(tmpdir(), "alpha-engine-sync-"));
  const engineData = mkdtempSync(join(tmpdir(), "alpha-engine-sync-state-"));
  temps.push(persist, engineData);
  const base = `http://127.0.0.1:${port}`;
  const env = { persist, base, worker: null, visible: 0, sends: [], cookie: null, skewMs: 0 };
  env.start = async () => {
    wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
    const args = ["wrangler", "dev", "--local", "--port", String(port), "--inspector-port", String(port + 600), "--ip", "127.0.0.1", "--persist-to", persist];
    for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET })) args.push("--var", `${k}:${v}`);
    env.worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      try { if ((await fetch(`${base}/health`)).status === 200) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Worker on ${port} did not start`);
  };
  env.stop = () => {
    if (env.worker && env.worker.exitCode === null) {
      try { if (WIN) execFileSync("taskkill", ["/PID", String(env.worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-env.worker.pid, "SIGTERM"); } catch { /* gone */ }
    }
  };
  const engineCfg = loadConfig({ ENGINE_ENV_FILE: "none", ...(profile ? { ENGINE_PROFILE: profile } : {}) }, ENGINE_DIR);
  env.cfg = { ...engineCfg, sync: true, apiBase: base, webhookSecret: WEBHOOK_SECRET, dataDir: engineData, lateBars: 2, pivotTies: PIVOTS };
  env.runner = () => new EngineRunner(env.cfg, {
    fetchCandles: async ({ sinceMs }) => CANDLES.slice(0, env.visible).filter((k) => sinceMs === null || k.t > sinceMs),
    now: () => CANDLES[env.visible - 1].t + STEP + 10_000 + env.skewMs,
    http: async (url, init) => { if (url.endsWith("/dry-run")) env.sends.push(JSON.parse(init.body).id); return fetch(url, init); },
    log: () => {},
  });
  env.sql = (q, write = false) => {
    const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
    const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
    const db = new DatabaseSync(join(dir, file), { readOnly: !write });
    try {
      if (write) { db.exec("PRAGMA busy_timeout = 5000"); db.exec(q); return []; }
      return db.prepare(q).all().map((r) => ({ ...r }));
    } finally { db.close(); }
  };
  env.dashboard = async () => {
    if (!env.cookie) {
      const r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
      env.cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
    }
    const r = await fetch(`${base}/api/dashboard`, { headers: { Cookie: env.cookie, "X-Alpha-Terminal": "1" } });
    assert.equal(r.status, 200);
    return (await r.json()).data;
  };
  env.replayTo = async (r, bar) => { while (r.state.strategy.bar < bar) { env.visible += 1; await r.tick(); } };
  return env;
}

const dflt = environment(8797, null); // Pine default risk
const test = environment(8798, "paper-test");

before(async () => {
  if (needsBroker.skip) return;
  await Promise.all([dflt.start(), test.start()]);
});
after(() => {
  dflt.stop();
  test.stop();
  for (const d of temps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
});

describe("default strategy risk ($200): truthful rejections, nothing reaches the ledger", () => {
  it("rejected entries are recorded with the Worker's reason and their exits are never sent", needsBroker, async () => {
    assert.equal(dflt.cfg.inputs.riskUSD, undefined, "Pine default (200) applies");
    dflt.visible = FILLS[0];
    const r = dflt.runner();
    await r.tick(); // warm-up
    await dflt.replayTo(r, FILLS[3]); // SHORT trade, then the first LONG trade
    const box = r.state.outbox;
    const [sell, sellClose, buy, buyClose] = box;
    assert.deepEqual([sell.action, sell.status], ["SELL", "rejected"]); // short selling is disabled
    assert.deepEqual([buy.action, buy.status, buy.code], ["BUY", "rejected", "MAX_ORDER_NOTIONAL"]);
    assert.match(buy.reason, /above the limit \$5000/);
    for (const c of [sellClose, buyClose]) assert.deepEqual([c.action, c.status, c.code], ["CLOSE", "skipped", "ENTRY_NOT_IN_LEDGER"]);
    assert.deepEqual(dflt.sends, [sell.id, buy.id], "only the two entries were submitted");

    assert.equal(dflt.sql(`SELECT COUNT(*) AS n FROM alerts WHERE action = 'close'`)[0].n, 0, "no CLOSE ever hit the ledger");
    assert.equal(dflt.sql(`SELECT COUNT(*) AS n FROM paper_positions`)[0].n, 0);
    assert.equal(dflt.sql(`SELECT COUNT(*) AS n FROM trades`)[0].n, 0);
    const rejected = dflt.sql(`SELECT alert_id, response_code, rejection_reason FROM alerts ORDER BY id`);
    assert.deepEqual(rejected.map((a) => a.alert_id), [sell.id, buy.id]);
    assert.ok(rejected.every((a) => a.rejection_reason));

    const d = await dflt.dashboard();
    assert.equal(d.paper.positions.length, 0);
    assert.equal(d.bot.status.last_rejection.status, "skipped");
    assert.equal(d.bot.status.outbox.rejected, 2);
    assert.equal(d.bot.status.outbox.skipped, 2);
  });
});

describe("paper-test profile ($5 risk): engine and ALPHA PAPER ledger stay in step", () => {
  let r;
  it("warm-up sends nothing; the heartbeat shows the engine ONLINE with its profile", needsBroker, async () => {
    assert.deepEqual(test.cfg.inputs, { riskUSD: 5 });
    test.visible = FILLS[0];
    r = test.runner();
    await r.tick();
    assert.equal(test.sends.length, 0);
    const d = await test.dashboard();
    assert.equal(d.bot.state, "ONLINE");
    assert.deepEqual([d.bot.status.profile, d.bot.status.risk_usd, d.bot.status.mode], ["paper-test", 5, "PAPER"]);
    assert.ok(!JSON.stringify(d.bot).includes(WEBHOOK_SECRET));
  });

  it("BUY accepted → the same position is open in the ledger; CLOSE → both flat and one ALPHA PAPER trade", needsBroker, async () => {
    await test.replayTo(r, FILLS[2]); // short trade (refused) and the LONG entry
    const buy = r.state.outbox.find((x) => x.action === "BUY");
    assert.deepEqual([buy.status, buy.code], ["accepted", "DRY_RUN_ACCEPTED"]);
    const enginePos = r.state.strategy.broker.pos;
    let d = await test.dashboard();
    const ledgerPos = d.paper.positions.find((p) => p.symbol === "SOLUSD");
    assert.ok(ledgerPos, "ledger position open while the engine is in the trade");
    assert.ok(Math.abs(ledgerPos.qty - Number(enginePos.qty.toFixed(8))) < 1e-8, "same quantity");
    assert.equal(d.bot.status.position.ledger.status, "MIRRORED");
    assert.equal(d.bot.status.ledger_check.status, "OK");
    assert.ok(ledgerPos.qty * ledgerPos.avg_entry_price <= 5000);

    // Divergence against the real D1 ledger is reported, not claimed as mirrored (test-only tampering).
    test.sql(`UPDATE paper_positions SET qty = qty + 1 WHERE status = 'OPEN'`, true);
    await r.tick();
    d = await test.dashboard();
    assert.equal(d.bot.status.ledger_check.status, "DIVERGED");
    assert.match(d.bot.status.ledger_check.issues[0], /ledger qty .* vs engine/);
    assert.equal(d.bot.status.position.ledger.status, "DIVERGED");
    test.sql(`UPDATE paper_positions SET qty = qty - 1 WHERE status = 'OPEN'`, true);
    await r.tick();
    d = await test.dashboard();
    assert.equal(d.bot.status.ledger_check.status, "OK");

    await test.replayTo(r, FILLS[3]); // the LONG exit
    const close = r.state.outbox.find((x) => x.action === "CLOSE" && x.entryId === buy.id);
    assert.deepEqual([close.status, close.code], ["accepted", "DRY_RUN_ACCEPTED"]);
    d = await test.dashboard();
    assert.equal(d.paper.positions.length, 0);
    assert.equal(r.state.strategy.broker.pos, null);
    const [trade] = test.sql(`SELECT * FROM trades WHERE source = 'ALPHA_PAPER'`);
    assert.deepEqual([trade.open_alert_id, trade.close_alert_id, trade.strategy], [buy.id, close.id, "OTE Pro Strat (engine)"]);
    // The short trade's CLOSE was never sent: no NO_POSITION close in the ledger.
    assert.equal(test.sql(`SELECT COUNT(*) AS n FROM alerts WHERE action = 'close'`)[0].n, 1);
    assert.equal(test.sql(`SELECT COUNT(*) AS n FROM orders WHERE alpaca_order_id IS NOT NULL`)[0].n, 0);
    assert.equal(new Set(test.sends).size, test.sends.length, "no signal id was sent twice");
  });

  it("restart, forced resend and an outage never duplicate a simulated trade", needsBroker, async () => {
    const counts = () => test.sql(`SELECT (SELECT COUNT(*) FROM alerts) a, (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM paper_fills) f, (SELECT COUNT(*) FROM trades) t`)[0];
    const before = counts();
    const r2 = test.runner(); // process restart from the saved state file
    await r2.tick();
    assert.equal(r2.state.strategy.bar, r.state.strategy.bar);
    for (const x of r2.state.outbox.filter((y) => y.status === "accepted")) x.status = "pending"; // crash before saving results
    await r2.flush();
    assert.ok(r2.state.outbox.filter((x) => x.kind).every((x) => ["accepted", "rejected", "skipped"].includes(x.status)));
    assert.deepEqual(counts(), before);

    // Prolonged outage across the second LONG trade's entry: when the Worker answers again 45 minutes later,
    // the entry is expired at delivery (never fills at a later price) and its exit is never sent.
    const r3 = test.runner();
    const realHttp = r3.http;
    let down = true;
    r3.http = async (url, init) => { if (down && url.endsWith("/dry-run")) throw new TypeError("fetch failed"); return realHttp(url, init); };
    await test.replayTo(r3, FILLS[4]);
    const entry2 = r3.state.outbox.at(-1);
    assert.deepEqual([entry2.action, entry2.status], ["BUY", "pending"]);
    assert.equal(r3.state.lastError.where, "sync");
    test.skewMs = 45 * 60_000;
    down = false;
    await r3.tick();
    assert.deepEqual([entry2.status, entry2.code], ["skipped", "SIGNAL_EXPIRED"]);
    await test.replayTo(r3, FILLS[5]);
    const exit2 = r3.state.outbox.find((x) => x.entryId === entry2.id);
    assert.deepEqual([exit2.status, exit2.code], ["skipped", "ENTRY_NOT_IN_LEDGER"]);
    assert.equal(test.sql(`SELECT COUNT(*) AS n FROM alerts WHERE alert_id IN ('${entry2.id}', '${exit2.id}')`)[0].n, 0, "neither reached the ledger");
    assert.deepEqual(counts(), before, "no fill, order or trade was added");
    test.skewMs = 0;
  });

  it("the engine's ledger view is read-only and needs the webhook secret", needsBroker, async () => {
    const q = (body) => fetch(`${test.base}/webhook/engine-ledger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await q({ secret: "wrong", symbol: "SOLUSD" })).status, 401);
    assert.equal((await q({ secret: WEBHOOK_SECRET, symbol: "SPY" })).status, 400);
    assert.equal((await q({ secret: WEBHOOK_SECRET, symbol: "SOLUSD", alert_ids: ["bad id with spaces"] })).status, 400);
    const snap = () => test.sql(`SELECT (SELECT COUNT(*) FROM alerts) a, (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM paper_positions) p, (SELECT COUNT(*) FROM activity_events) e`)[0];
    const before = snap();
    const buy = r.state.outbox.find((x) => x.action === "BUY");
    const res = await (await q({ secret: WEBHOOK_SECRET, symbol: "SOLUSD", alert_ids: [buy.id] })).json();
    assert.equal(res.read_only, true);
    assert.equal(res.alerts[buy.id].response_code, "DRY_RUN_ACCEPTED");
    assert.deepEqual(snap(), before);
  });

  it("a silent engine is shown truthfully as STALE, then OFFLINE", needsBroker, async () => {
    const setAge = (sec) => {
      const v = JSON.parse(test.sql(`SELECT value FROM app_meta WHERE key = 'engine_status'`)[0].value);
      v.received_at = new Date(Date.now() - sec * 1000).toISOString();
      test.sql(`UPDATE app_meta SET value = '${JSON.stringify(v).replace(/'/g, "''")}' WHERE key = 'engine_status'`, true);
    };
    setAge(15 * 60);
    assert.equal((await test.dashboard()).bot.state, "STALE");
    setAge(2 * 3600);
    assert.equal((await test.dashboard()).bot.state, "OFFLINE");
  });

  it("the status endpoint needs the webhook secret and a supported symbol, and changes nothing else", needsBroker, async () => {
    const post = (body) => fetch(`${test.base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    assert.equal((await post({ secret: "wrong", status: { symbol: "SOLUSD" } })).status, 401);
    assert.equal((await post({ secret: WEBHOOK_SECRET, status: { symbol: "SPY" } })).status, 400);
    assert.equal((await post("x".repeat(5000))).status, 413);
    const snap = () => test.sql(`SELECT (SELECT COUNT(*) FROM alerts) a, (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM paper_positions) p`)[0];
    const before = snap();
    assert.equal((await post({ secret: WEBHOOK_SECRET, status: { symbol: "SOLUSD", timeframe: "5m", status_text: "ok", extra: "dropped" } })).status, 200);
    assert.deepEqual(snap(), before);
    const d = await test.dashboard();
    assert.equal(d.bot.state, "ONLINE");
    assert.equal(d.bot.status.extra, undefined);
  });
});

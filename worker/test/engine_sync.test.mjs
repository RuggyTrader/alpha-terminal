// Development-environment sync test: the OTE engine (engine/) → the real Worker on `wrangler dev --local` with a
// throwaway D1. Never touches production. The engine replays real Kraken SOLUSD 5m candles from the engine's
// fixture one completed candle at a time; the Worker prices its ALPHA PAPER fills from live Kraken data and reads
// the Alpaca PAPER account (GET only), so this needs PAPER keys in worker/.dev.vars, otherwise it skips.

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
import { runBacktest } from "../../engine/src/cli/backtest.mjs";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const keys = existsSync(join(WORKER_DIR, ".dev.vars")) ? readFileSync(join(WORKER_DIR, ".dev.vars"), "utf8").split(/\r?\n/).map((l) => l.split("=")[0].trim()) : [];
const needsBroker = keys.includes("ALPACA_KEY") && keys.includes("ALPACA_SECRET") ? {} : { skip: "ALPACA_KEY / ALPACA_SECRET (PAPER) not in worker/.dev.vars" };

const FIX = JSON.parse(readFileSync(join(WORKER_DIR, "..", "engine", "test", "fixtures", "SOLUSD-5m-kraken.json"), "utf8"));
const CANDLES = FIX.candles;
const STEP = 300_000;
const RISK = 10; // engine input riskUSD for this test, so orders fit ALPHA TERMINAL's $5,000 per-order limit

const persist = mkdtempSync(join(tmpdir(), "alpha-engine-sync-"));
const engineData = mkdtempSync(join(tmpdir(), "alpha-engine-sync-state-"));
const BASE = "http://127.0.0.1:8797";
let worker;

const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 90000 });
function sqlite(sql, write = false) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  const db = new DatabaseSync(join(dir, file), { readOnly: !write });
  try {
    if (write) { db.exec("PRAGMA busy_timeout = 5000"); db.exec(sql); return []; }
    return db.prepare(sql).all().map((r) => ({ ...r }));
  } finally { db.close(); }
}
let cookie = null;
async function dashboard() {
  if (!cookie) {
    const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
    cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  }
  const r = await fetch(`${BASE}/api/dashboard`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" } });
  assert.equal(r.status, 200);
  return (await r.json()).data;
}

before(async () => {
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  const args = ["wrangler", "dev", "--local", "--port", "8797", "--inspector-port", "9397", "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).status === 200) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Worker did not start");
});
after(() => {
  if (worker && worker.exitCode === null) {
    try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid, "SIGTERM"); } catch { /* gone */ }
  }
  for (const d of [persist, engineData]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
});

// Replay: candles [0, visible) are "completed"; the clock is 10 s after the newest one closed.
let visible = 0;
const sends = [];
const cfg = { symbol: "SOLUSD", intervalMin: 5, inputs: { riskUSD: RISK }, sync: true, apiBase: BASE, webhookSecret: WEBHOOK_SECRET, dataDir: engineData, lateBars: 2, krakenBase: "" };
const makeRunner = () => new EngineRunner(cfg, {
  fetchCandles: async ({ sinceMs }) => CANDLES.slice(0, visible).filter((k) => sinceMs === null || k.t > sinceMs),
  now: () => CANDLES[visible - 1].t + STEP + 10_000,
  http: async (url, init) => { if (url.endsWith("/dry-run")) sends.push(JSON.parse(init.body).id); return fetch(url, init); },
  log: () => {},
});

const bt = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5, inputs: { riskUSD: RISK } });
const fillBars = bt.events.filter((e) => e.type === "ENTRY_FILL" || e.type === "EXIT_FILL").map((e) => e.bar);
const longIdx = bt.trades.findIndex((t) => t.side === "LONG");

describe("engine → ALPHA TERMINAL (local dev Worker + D1)", () => {
  let runner;

  it("warm-up sends no signals; the heartbeat makes the dashboard show the engine ONLINE", needsBroker, async () => {
    visible = fillBars[0]; // history up to just before the first fill
    runner = makeRunner();
    await runner.tick();
    assert.equal(sends.length, 0);
    const d = await dashboard();
    assert.equal(d.bot.state, "ONLINE");
    assert.equal(d.bot.status.symbol, "SOLUSD");
    assert.equal(d.bot.status.mode, "PAPER");
    assert.equal(d.bot.status.strategy, "OTE Pro Strat (engine)");
    assert.ok(d.bot.status.status_text);
    assert.ok(!JSON.stringify(d.bot).includes(WEBHOOK_SECRET));
  });

  it("live replay: every engine fill reaches ALPHA TERMINAL once; shorts are refused truthfully, the long becomes an ALPHA PAPER trade", needsBroker, async () => {
    assert.ok(longIdx >= 0, "the fixture contains a long trade");
    const lastBar = Math.max(...fillBars.slice(0, (longIdx + 1) * 2)); // through the exit of the first long trade
    while (visible <= lastBar) { visible += 1; await runner.tick(); }
    const out = runner.state.outbox;
    assert.equal(out.length, (longIdx + 1) * 2);
    for (const item of out) assert.ok(["sent", "rejected"].includes(item.status), `${item.id}: ${item.status} ${item.code}`);
    for (const item of out.filter((x) => x.action === "SELL")) assert.equal(item.status, "rejected"); // short selling is disabled
    const buy = out.find((x) => x.action === "BUY");
    const closeOfLong = out[out.indexOf(buy) + 1];
    assert.deepEqual([buy.status, buy.code], ["sent", "DRY_RUN_ACCEPTED"]);
    assert.deepEqual([closeOfLong.action, closeOfLong.status, closeOfLong.code], ["CLOSE", "sent", "DRY_RUN_ACCEPTED"]);

    const [trade] = sqlite(`SELECT * FROM trades WHERE source = 'ALPHA_PAPER'`);
    assert.equal(trade.open_alert_id, buy.id);
    assert.equal(trade.close_alert_id, closeOfLong.id);
    assert.equal(trade.strategy, "OTE Pro Strat (engine)");
    assert.equal(sqlite(`SELECT COUNT(*) AS n FROM alerts WHERE alert_id LIKE 'ENG-%'`)[0].n, out.length);
    assert.equal(sqlite(`SELECT COUNT(*) AS n FROM orders WHERE alpaca_order_id IS NOT NULL`)[0].n, 0);
    assert.equal(new Set(sends).size, sends.length, "no signal id was sent twice");

    const d = await dashboard();
    assert.equal(d.recent.trades[0].source, "ALPHA_PAPER");
    assert.equal(d.bot.status.trades.closed, longIdx + 1);
  });

  it("restart and forced resend change nothing (duplicate protection on both sides)", needsBroker, async () => {
    const alertsBefore = sqlite(`SELECT COUNT(*) AS n FROM alerts`)[0].n;
    const ordersBefore = sqlite(`SELECT COUNT(*) AS n FROM orders`)[0].n;
    const r2 = makeRunner(); // process restart from the saved state file
    await r2.tick();
    assert.equal(r2.state.strategy.bar, runner.state.strategy.bar);
    const buy = r2.state.outbox.find((x) => x.action === "BUY");
    buy.status = "pending"; // simulate a crash after sending but before saving
    await r2.flush();
    assert.deepEqual([buy.status, buy.code], ["sent", "DUPLICATE"]);
    assert.equal(sqlite(`SELECT COUNT(*) AS n FROM alerts`)[0].n, alertsBefore);
    assert.equal(sqlite(`SELECT COUNT(*) AS n FROM orders`)[0].n, ordersBefore);
  });

  it("a silent engine is shown truthfully as STALE, then OFFLINE", needsBroker, async () => {
    const setAge = (sec) => {
      const v = JSON.parse(sqlite(`SELECT value FROM app_meta WHERE key = 'engine_status'`)[0].value);
      v.received_at = new Date(Date.now() - sec * 1000).toISOString();
      sqlite(`UPDATE app_meta SET value = '${JSON.stringify(v).replace(/'/g, "''")}' WHERE key = 'engine_status'`, true);
    };
    setAge(15 * 60);
    assert.equal((await dashboard()).bot.state, "STALE");
    setAge(2 * 3600);
    assert.equal((await dashboard()).bot.state, "OFFLINE");
  });

  it("the status endpoint needs the webhook secret and a supported symbol, and changes nothing else", needsBroker, async () => {
    const post = (body) => fetch(`${BASE}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    assert.equal((await post({ secret: "wrong", status: { symbol: "SOLUSD" } })).status, 401);
    assert.equal((await post({ secret: WEBHOOK_SECRET, status: { symbol: "SPY" } })).status, 400);
    assert.equal((await post("x".repeat(5000))).status, 413);
    const before = sqlite(`SELECT (SELECT COUNT(*) FROM alerts) a, (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM paper_positions) p`)[0];
    assert.equal((await post({ secret: WEBHOOK_SECRET, status: { symbol: "SOLUSD", timeframe: "5m", status_text: "ok", extra: "dropped" } })).status, 200);
    assert.deepEqual(sqlite(`SELECT (SELECT COUNT(*) FROM alerts) a, (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM paper_positions) p`)[0], before);
    const d = await dashboard();
    assert.equal(d.bot.state, "ONLINE");
    assert.equal(d.bot.status.extra, undefined);
  });
});

// Strategy Mirror production rollout, rehearsed (docs/STRATEGY-MIRROR-ROLLOUT-PLAN.md, stages A and B) on a throwaway
// local D1 that starts exactly like production today: schema 4, written by the DEPLOYED Worker (e941387e = 8b188c8),
// MAIN $90 / SOLUSD $10, plus funded activity (refusals and one small accepted round trip) so every funded table has rows.
//   A. migration 0005 on that data: every funded table byte-identical, balances unchanged
//   B. the deployed Worker and the fee-compatible rollback Worker still work on schema 5
//   B. the mirror-capable Worker: security (auth, sessions, no broker, config unchanged), mirror ingestion,
//      idempotency, reconciliation; duplicates cannot change results; the funded books stay identical
// Isolated: port 8809, its own persist dir, Kraken prices from the committed real fixture on 127.0.0.1.
//   node --test test/mirror_rollout.test.mjs

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "./lib/kraken-stub.mjs";
import { DEPLOYED_REF, workerAt } from "./lib/worker-at.mjs";
import { createMirror, mirrorStep } from "../../engine/src/mirror.mjs";
import { loadConfig } from "../../engine/src/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_DIR = join(HERE, "..");
const ENGINE = join(DEV_DIR, "..", "engine");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const PORT = 8809;
const BASE = `http://127.0.0.1:${PORT}`;
const KRAKEN = await startKrakenStub();
const STEP = 300_000;
const work = mkdtempSync(join(tmpdir(), "alpha-mirror-rollout-"));
const persist = join(work, "d1");
const DEPLOYED = workerAt(DEPLOYED_REF);
const ROLLBACK = workerAt("c5bb67e");

// Stage A as executed in production: the migrations of that release (0001-0005). Later migrations (0006, not yet
// approved for production) are left out here, so this stays a faithful rehearsal of what was applied.
const STAGE_A_DIR = join(work, "stage-a");
mkdirSync(join(STAGE_A_DIR, "migrations"), { recursive: true });
copyFileSync(join(DEV_DIR, "wrangler.jsonc"), join(STAGE_A_DIR, "wrangler.jsonc"));
for (const f of readdirSync(join(DEV_DIR, "migrations")).filter((f) => /^000[1-5]_.*\.sql$/.test(f))) copyFileSync(join(DEV_DIR, "migrations", f), join(STAGE_A_DIR, "migrations", f));
const wrangler = (dir, args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
function d1(sql, ...args) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  for (let attempt = 0; ; attempt++) {
    try {
      const db = new DatabaseSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")));
      try { return db.prepare(sql).all(...args).map((r) => ({ ...r })); } finally { db.close(); }
    } catch (e) {
      if (attempt >= 20 || !/disk I\/O|locked|busy/i.test(String(e.message))) throw e;
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 250)"]);
    }
  }
}
let worker = null, cookie = null;
async function start(dir) {
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", "9809", "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, PAPER_MARK_MIN_INTERVAL_SECONDS: "0", ALPACA_KEY: "", ALPACA_SECRET: "" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: dir, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).status === 200) { cookie = null; return; } } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Worker in ${dir} did not start`);
}
async function stop() {
  if (worker && worker.exitCode === null) {
    try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid, "SIGTERM"); } catch { /* gone */ }
  }
  worker = null;
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) }); } catch { return; }
    await new Promise((r) => setTimeout(r, 300));
  }
}
async function login() {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  assert.equal(r.status, 200);
  cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
}
async function get(path, expect = 200) {
  if (!cookie) await login();
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" } });
  assert.equal(r.status, expect, path);
  return (await r.json()).data;
}
async function paperAction(kind, body) {
  if (!cookie) await login();
  const r = await fetch(`${BASE}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
    body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }) });
  assert.equal(r.status, 200);
}
const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { http: r.status, ...(await r.json().catch(() => ({}))) };
};
let n = 0;
const signal = (action, qty) => ({ secret: WEBHOOK_SECRET, id: `ENG-SOLUSD-5-ROLLOUT-${++n}-${action}`, symbol: "SOLUSD", timeframe: "5", action,
  strategy: "OTE Pro Strat (engine)", ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString(), liquidity: "maker" });

// Every funded table and every row (the mirror tables are excluded by name).
const FUNDED = ["portfolio_wallets", "portfolio_entries", "paper_positions", "paper_fills", "trades", "alerts", "orders", "risk_decisions",
  "strategy_settings", "activity_events", "engine_state", "auth_sessions", "backtest_results", "d1_migrations"];
const funded = (skip = []) => JSON.stringify(Object.fromEntries(FUNDED.filter((t) => !skip.includes(t)).map((t) => [t, d1(`SELECT * FROM ${t} ORDER BY rowid`)])));
const appMeta = () => JSON.stringify(d1("SELECT * FROM app_meta WHERE key <> 'schema_version' ORDER BY key"));
const wallets = () => d1("SELECT wallet, available_micro, reserved_micro, realized_pnl_micro, net_funding_micro, fees_micro FROM portfolio_wallets ORDER BY wallet");

// Mirror records: the engine's own replay of a slice of the committed 150-day history.
const P5 = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, ENGINE);
const D150 = JSON.parse(gunzipSync(readFileSync(join(ENGINE, "test", "fixtures", "SOLUSD-5m-150d.rows.json.gz"))).toString("utf8"));
const HASH = "c826d785d58a4a39";
const M = (() => {
  const C = D150.rows.slice(-8640).map(([t, o, h, l, c]) => ({ t, o, h, l, c })); // the last 30 days
  const ctx = { lateMs: 2 * STEP, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, inputsHash: HASH };
  const m = createMirror({ ...ctx, nowMs: C[0].t });
  for (const k of C) mirrorStep(m, k, { ...ctx, nowMs: k.t + STEP + 5_000 });
  return m;
})();
const ITEMS = M.outbox.map(({ status: _s, attempts: _a, ...x }) => x);
const ACCOUNT = { account_id: `MIRROR-SOLUSD-5m-${HASH}`, symbol: "SOLUSD", timeframe: "5m", profile: "solusd-5m", strategy: "OTE Pro Strat (engine)", inputs_hash: HASH,
  engine_version: "0.1.0", engine_release: "rehearsal", engine_commit: null, created_at: "2026-10-10T00:00:00Z", activated_at: "2026-11-09T00:00:00Z",
  last_candle_time: "2026-11-08T23:55:00Z", last_candle_close: 100, candles_processed: 8640, risk_usd: 10, last_seq: M.seq, pending: 0, refused: 0,
  open_position: null, resets: 0, interruptions: 0, skipped_candles: 0, last_error: null, observation_gaps: [], no_trade_intervals: 0 };

before(async () => {
  // Production today: migrations 0001-0004 applied by the deployed release, data written by the deployed Worker.
  wrangler(DEPLOYED, ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  await start(DEPLOYED);
  await paperAction("fund", { action: "deposit", amount_usd: 100 });
  await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 10 });
  for (const [a, q] of [["SELL", 35.61067391], ["BUY", 30.5265509], ["BUY", 87.36]]) assert.equal((await post("/webhook/dry-run", signal(a, q))).http, 422);
  assert.equal((await post("/webhook/dry-run", signal("BUY", 0.1))).code, "DRY_RUN_ACCEPTED");
  assert.equal((await post("/webhook/dry-run", signal("CLOSE"))).code, "DRY_RUN_ACCEPTED");
  await stop();
});
after(async () => { await stop(); await KRAKEN.close(); try { rmSync(work, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

let base, baseMeta, baseWallets;
describe("Stage A: migration 0005 on production-shaped schema-4 data", () => {
  it("the starting point is production's shape: schema 4, 0004 applied, funded rows in every ledger table", () => {
    assert.equal(d1("SELECT value FROM app_meta WHERE key = 'schema_version'")[0].value, "4");
    assert.deepEqual(d1("SELECT name FROM d1_migrations ORDER BY id").map((r) => r.name), ["0001_initial.sql", "0002_alpha_paper_ledger.sql", "0003_paper_portfolio.sql", "0004_paper_execution_costs.sql"]);
    for (const t of ["portfolio_entries", "paper_fills", "trades", "alerts", "orders", "risk_decisions"]) assert.ok(d1(`SELECT COUNT(*) AS n FROM ${t}`)[0].n > 0, t);
    assert.equal(d1("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'mirror_%'")[0].n, 0);
    base = funded(["d1_migrations"]);
    baseMeta = appMeta();
    baseWallets = wallets();
  });

  it("0005 applies alone; every funded table and row is byte-identical; balances unchanged; re-applying is a no-op", () => {
    const out = wrangler(STAGE_A_DIR, ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
    assert.match(out, /0005_strategy_mirror/);
    assert.doesNotMatch(out, /0004_paper_execution_costs\.sql\s*│\s*✅/, "only 0005 was pending");
    assert.equal(d1("SELECT value FROM app_meta WHERE key = 'schema_version'")[0].value, "5");
    assert.equal(funded(["d1_migrations"]), base);
    assert.equal(appMeta(), baseMeta);
    assert.deepEqual(wallets(), baseWallets);
    assert.match(wrangler(STAGE_A_DIR, ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]), /No migrations to apply/i);
    assert.equal(funded(["d1_migrations"]), base);
  });
});

describe("Stage B: Workers on schema 5", () => {
  for (const [name, dir] of [["deployed Worker e941387e (8b188c8)", DEPLOYED], ["fee-compatible rollback Worker (c5bb67e)", ROLLBACK]]) {
    it(`${name}: dashboard consistent, refusals unchanged, no mirror route, books unchanged by reading`, async () => {
      await start(dir);
      const before = funded(["d1_migrations", "alerts", "risk_decisions", "activity_events", "auth_sessions"]);
      const d = await get("/api/dashboard");
      assert.equal(d.portfolio.consistency.ok, true);
      assert.equal(d.enable_trading, false);
      assert.equal((await post("/webhook/dry-run", signal("SELL", 35.61067391))).code, "NO_POSITION");
      assert.equal((await post("/webhook/engine-mirror", { secret: WEBHOOK_SECRET, account: ACCOUNT, items: [] })).http, 404);
      assert.deepEqual(wallets(), baseWallets);
      assert.equal(funded(["d1_migrations", "alerts", "risk_decisions", "activity_events", "auth_sessions"]), before);
      await stop();
    });
  }

  it("mirror-capable Worker: configuration unchanged (trading off, costs none, every limit)", async () => {
    await start(DEV_DIR);
    const h = await (await fetch(`${BASE}/health`)).json();
    assert.equal(h.enable_trading, false);
    assert.equal(h.mode, "PAPER");
    const d = await get("/api/dashboard");
    assert.equal(d.portfolio.costs.profile, "none");
    assert.deepEqual(d.portfolio.limits, { ...d.portfolio.limits, max_order_notional_usd: 5000, short_selling_enabled: false, max_position_exposure_usd: 10000, max_total_exposure_usd: 25000, max_open_positions: 5, daily_loss_limit_usd: 2000 });
    // This Worker also carries notifications (migration 0006): on schema 5 they report "not available" and change nothing.
    const n = await get("/api/notifications/config");
    assert.equal(n.available, false);
    assert.match(n.reason, /not configured|migration/);
    assert.equal((await get("/api/dashboard/events")).items.every((i) => i.source !== "mirror" || i.title), true);
  });

  it("security: every webhook still refuses a wrong secret; mirror routes need a session; nothing secret is returned", async () => {
    for (const p of ["/webhook/dry-run", "/webhook/engine-status", "/webhook/engine-ledger", "/webhook/engine-backtest", "/webhook/engine-mirror"]) {
      const r = await post(p, { secret: "wrong", account: ACCOUNT, items: [], status: { symbol: "SOLUSD" }, symbol: "SOLUSD" });
      assert.equal(r.http, 401, p);
      assert.equal(JSON.stringify(r).includes(WEBHOOK_SECRET), false);
    }
    for (const p of ["/api/dashboard/mirror", "/api/dashboard/mirror/trades", "/api/dashboard/mirror/trade?id=x", "/api/dashboard"]) assert.equal((await fetch(`${BASE}${p}`)).status, 401, p);
    const forged = await fetch(`${BASE}/api/dashboard/mirror`, { headers: { Cookie: "at_session=forged", "X-Alpha-Terminal": "1" } });
    assert.equal(forged.status, 401);
    // Read-only: the dashboard API refuses writes.
    if (!cookie) await login();
    assert.equal((await fetch(`${BASE}/api/dashboard/mirror`, { method: "POST", headers: { Cookie: cookie, "X-Alpha-Terminal": "1" } })).status, 405);
  });

  it("ingestion: stored once, duplicates and replays change nothing, journal reconciles, no broker, no funded change", async () => {
    const before = funded(["d1_migrations", "auth_sessions", "activity_events"]);
    for (let i = 0; i < ITEMS.length; i += 25) {
      const r = await post("/webhook/engine-mirror", { secret: WEBHOOK_SECRET, account: ACCOUNT, items: ITEMS.slice(i, i + 25) });
      assert.equal(r.http, 200);
      assert.equal(r.broker_request_sent, false);
      assert.ok(r.d1_queries <= 9);
      assert.ok(r.results.every((x) => x.status === "stored"));
    }
    const snap = () => JSON.stringify([d1("SELECT * FROM mirror_trades ORDER BY id"), d1("SELECT * FROM mirror_entries ORDER BY id")]);
    const once = snap();
    const summary1 = await get("/api/dashboard/mirror");
    for (let round = 0; round < 3; round++) {
      for (let i = ITEMS.length - 25; i >= 0; i -= 25) { // replays, in reverse order
        const r = await post("/webhook/engine-mirror", { secret: WEBHOOK_SECRET, account: ACCOUNT, items: ITEMS.slice(Math.max(0, i), i + 25) });
        assert.ok(r.results.every((x) => x.status === "duplicate"));
      }
    }
    assert.equal(snap(), once, "duplicates wrote nothing");
    const summary2 = await get("/api/dashboard/mirror");
    assert.deepEqual(summary2.categories, summary1.categories, "results unchanged by duplicates");
    assert.equal(summary2.reconciliation.ok, true);
    assert.equal(summary2.reconciliation.trades, ITEMS.length);
    assert.ok(Math.abs(summary2.reconciliation.journal_total - summary2.reconciliation.trades_gross) < 1e-6);
    assert.equal(summary2.health.state, "OK", JSON.stringify(summary2.health));
    assert.equal(funded(["d1_migrations", "auth_sessions", "activity_events"]), before, "no funded row touched");
    assert.deepEqual(wallets(), baseWallets);
    assert.equal(d1("SELECT COUNT(*) AS n FROM portfolio_entries WHERE kind = 'FEE'")[0].n, 0);
    // The Ndax figures are labelled as a hypothetical comparison, not production fees.
    assert.match(summary2.cost_model.note, /Comparison only/);
    assert.match(summary2.label, /^Hypothetical/);
    assert.equal((await get("/api/dashboard")).portfolio.costs.profile, "none");
  });

  it("existing dashboard endpoints keep working on the mirror-capable Worker", async () => {
    for (const p of ["/api/dashboard", "/api/dashboard/performance", "/api/dashboard/trades?limit=5", "/api/dashboard/activity?limit=5", "/api/dashboard/alerts?limit=5",
      "/api/dashboard/risk?limit=5", "/api/dashboard/orders?limit=5", "/api/dashboard/summary", "/api/dashboard/backtest?strategy=SOLUSD"]) await get(p);
    const t = d1("SELECT id FROM trades ORDER BY id DESC LIMIT 1")[0];
    await get(`/api/dashboard/trade-proof?id=${t.id}`);
    await stop();
  });

  it("rolling back after mirror records exist: both earlier Workers stay consistent with identical books", async () => {
    const snapAll = () => JSON.stringify([funded(["d1_migrations", "auth_sessions", "activity_events", "alerts", "risk_decisions"]), d1("SELECT COUNT(*) AS n FROM mirror_trades")]);
    const before = snapAll();
    for (const dir of [DEPLOYED, ROLLBACK]) {
      await start(dir);
      assert.equal((await get("/api/dashboard")).portfolio.consistency.ok, true);
      await stop();
      assert.equal(snapAll(), before);
    }
  });
});

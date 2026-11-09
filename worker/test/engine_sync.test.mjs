// Development-environment sync test: the OTE engine (engine/) → the real Worker on `wrangler dev --local` with
// throwaway D1 databases. Never touches production. The engine replays real Kraken SOLUSD 5m candles from the
// engine's fixture one completed candle at a time; the Worker prices ALPHA PAPER fills from live Kraken data.
// The Workers run WITHOUT Alpaca keys: the ALPHA PAPER risk account is the D1 strategy balance.
//
// Three isolated Workers: one runs the engine with the Pine default risk ($200, orders far above the $5,000 limit),
// one with the `paper-test` profile ($5 risk), and one with `paper-test` and a funded ALPHA PAPER portfolio.
// Fixture trades (strict pivot rule): SHORT, then LONG, then LONG.

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
function environment(port, profile, extraCfg = {}) {
  const persist = mkdtempSync(join(tmpdir(), "alpha-engine-sync-"));
  const engineData = mkdtempSync(join(tmpdir(), "alpha-engine-sync-state-"));
  temps.push(persist, engineData);
  const base = `http://127.0.0.1:${port}`;
  const env = { persist, base, worker: null, visible: 0, sends: [], cookie: null, skewMs: 0 };
  env.start = async () => {
    wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
    const args = ["wrangler", "dev", "--local", "--port", String(port), "--inspector-port", String(port + 600), "--ip", "127.0.0.1", "--persist-to", persist];
    // Blank Alpaca keys override worker/.dev.vars: no Alpaca account exists for these Workers.
    for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) args.push("--var", `${k}:${v}`);
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
  env.cfg = { ...engineCfg, sync: true, apiBase: base, webhookSecret: WEBHOOK_SECRET, dataDir: engineData, lateBars: 2, pivotTies: PIVOTS, ...extraCfg };
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
  /** Dashboard PAPER action (fund / transfer), confirmed with the passphrase like the website does. */
  env.act = async (path, body) => {
    await env.dashboard(); // signs in
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: env.cookie },
      body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }),
    });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  };
  env.replayTo = async (r, bar) => { while (r.state.strategy.bar < bar) { env.visible += 1; await r.tick(); } };
  return env;
}

const dflt = environment(8797, null); // Pine default risk
const test = environment(8798, "paper-test");
const funded = environment(8796, "paper-test"); // same, with a funded ALPHA PAPER portfolio
// Small-account sizing: 1% of the SOL balance, capped to it; $100 deposited and $10 moved to SOL, like production.
const small = environment(8800, "paper-test", { sizing: { mode: "percent", riskPct: 1, feePct: 0.4, priceBufferPct: 0.5 } });

before(async () => {
  await Promise.all([dflt.start(), test.start(), funded.start(), small.start()]);
});
after(() => {
  dflt.stop();
  test.stop();
  funded.stop();
  small.stop();
  for (const d of temps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
});

describe("funded ALPHA PAPER portfolio: the real engine's trade reserves, releases and credits the SOL balance", () => {
  it("BUY reserves the position value from SOL, CLOSE releases it and credits the ledger P&L; history matches balances", async () => {
    const env = funded;
    assert.equal((await (await fetch(`${env.base}/health`)).json()).alpaca_configured, false);
    await env.act("/api/paper/fund", { action: "deposit", amount_usd: 5000 });
    await env.act("/api/paper/transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 5000 });
    const micro = (v) => Number(v);
    const sol = () => env.sql(`SELECT * FROM portfolio_wallets WHERE wallet = 'SOLUSD'`)[0];
    const booksBalance = () => {
      for (const w of env.sql(`SELECT * FROM portfolio_wallets`)) {
        const e = env.sql(`SELECT COALESCE(SUM(available_change_micro),0) AS a, COALESCE(SUM(reserved_change_micro),0) AS r FROM portfolio_entries WHERE wallet = '${w.wallet}'`)[0];
        assert.equal(micro(w.available_micro), micro(e.a), `${w.wallet} available vs history`);
        assert.equal(micro(w.reserved_micro), micro(e.r), `${w.wallet} reserved vs history`);
      }
    };

    env.visible = FILLS[0];
    const r = env.runner();
    await r.tick(); // warm-up
    await env.replayTo(r, FILLS[2]); // short trade (refused, never touches the balance), then the LONG entry
    const buy = r.state.outbox.find((x) => x.action === "BUY");
    assert.deepEqual([buy.status, buy.code], ["accepted", "DRY_RUN_ACCEPTED"]);
    const [pos] = env.sql(`SELECT * FROM paper_positions WHERE status = 'OPEN'`);
    assert.equal(pos.wallet, "SOLUSD");
    const value = Math.round(pos.qty * pos.avg_entry_price * 1e6);
    assert.ok(Math.abs(micro(pos.reserved_micro) - value) <= 1, "reserved = qty × ledger fill price");
    assert.equal(micro(sol().reserved_micro), micro(pos.reserved_micro));
    assert.equal(micro(sol().available_micro), 5000e6 - micro(pos.reserved_micro));
    booksBalance();
    let d = await env.dashboard();
    assert.equal(d.portfolio.consistency.ok, true, d.portfolio.consistency.issues.join("; "));
    assert.equal(d.bot.status.ledger_check.status, "OK");

    await env.replayTo(r, FILLS[3]); // the LONG exit
    const close = r.state.outbox.find((x) => x.action === "CLOSE" && x.entryId === buy.id);
    assert.deepEqual([close.status, close.code], ["accepted", "DRY_RUN_ACCEPTED"]);
    const [trade] = env.sql(`SELECT * FROM trades WHERE source = 'ALPHA_PAPER'`);
    const pnl = Math.round(Number(trade.realized_pnl) * 1e6); // TEXT column
    const after = sol();
    assert.equal(micro(after.reserved_micro), 0);
    assert.ok(Math.abs(micro(after.realized_pnl_micro) - pnl) <= 1, "realized P&L credited to SOL");
    assert.equal(micro(after.available_micro), 5000e6 + micro(after.realized_pnl_micro));
    assert.equal(micro(after.net_funding_micro), 5000e6, "a trade never counts as funding");
    booksBalance();
    d = await env.dashboard();
    assert.equal(d.portfolio.consistency.ok, true, d.portfolio.consistency.issues.join("; "));
    assert.equal(d.paper.positions.length, 0);
    assert.equal(env.sql(`SELECT COUNT(*) AS n FROM orders WHERE alpaca_order_id IS NOT NULL`)[0].n, 0, "no broker order");
  });
});

describe("small-account sizing: $100 portfolio, $10 SOL, 1% risk, no leverage", () => {
  it("engine and Worker agree on the balance, the size and the position; the result compounds into the next order", async () => {
    const env = small;
    await env.act("/api/paper/fund", { action: "deposit", amount_usd: 100 });
    await env.act("/api/paper/transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 10 });
    const sol = () => env.sql(`SELECT * FROM portfolio_wallets WHERE wallet = 'SOLUSD'`)[0];

    // The ledger view gives the engine the same balance the Worker's risk check uses.
    const view = await (await fetch(`${env.base}/webhook/engine-ledger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: WEBHOOK_SECRET, symbol: "SOLUSD" }) })).json();
    assert.deepEqual([view.balance.available_usd, view.balance.reserved_usd, view.balance.max_order_notional_usd], [10, 0, 5000]);

    env.visible = FILLS[0];
    const r = env.runner();
    await r.tick(); // warm-up
    const last = CANDLES.length;
    while (env.visible < last && !r.state.outbox.some((x) => x.action === "CLOSE" && x.status === "accepted")) { env.visible += 1; await r.tick(); }
    const buy = r.state.outbox.find((x) => x.action === "BUY" && x.status === "accepted");
    assert.ok(buy, "a long entry was sized from $10 and accepted");
    assert.ok(!r.state.outbox.some((x) => x.action === "SELL"), "no short is ever sent");
    assert.equal(r.state.outbox.filter((x) => x.status === "rejected").length, 0, "the Worker refused nothing: sizes always fit");
    const [fill] = env.sql(`SELECT * FROM paper_fills WHERE kind = 'OPEN'`);
    assert.ok(fill.qty * fill.price <= 10 + 1e-6, `ledger cost ${fill.qty * fill.price} within the $10 balance`);
    assert.ok(Number(buy.qty) >= 0.05, "at least Kraken's minimum order");
    assert.equal(Number(buy.qty), fill.qty, "engine and ledger hold the same quantity");
    const close = r.state.outbox.find((x) => x.action === "CLOSE" && x.entryId === buy.id);
    assert.deepEqual([close.status, close.code], ["accepted", "DRY_RUN_ACCEPTED"]);
    const [trade] = env.sql(`SELECT * FROM trades WHERE source = 'ALPHA_PAPER'`);
    const after = sol();
    assert.equal(Number(after.reserved_micro), 0);
    assert.ok(Math.abs(Number(after.available_micro) - (10e6 + Math.round(Number(trade.realized_pnl) * 1e6))) <= 1, "SOL = $10 + the realized PAPER P&L");

    // Next poll: the engine sizes from the new balance, and the dashboard shows the sizing it uses.
    env.visible = Math.min(env.visible + 1, last);
    await r.tick();
    const d = await env.dashboard();
    const sz = d.bot.status.sizing;
    assert.equal(sz.mode, "percent");
    assert.equal(sz.risk_pct, 1);
    assert.ok(Math.abs(sz.capital_usd - Number(after.available_micro) / 1e6) < 0.01, "the engine sizes from the current SOL balance");
    assert.equal(d.portfolio.consistency.ok, true);
    assert.equal(d.bot.status.ledger_check.status, "OK");
    assert.equal(env.sql(`SELECT COUNT(*) AS n FROM orders WHERE alpaca_order_id IS NOT NULL`)[0].n, 0, "no broker order");
  });
});

describe("default strategy risk ($200): truthful rejections, nothing reaches the ledger", () => {
  it("rejected entries are recorded with the Worker's reason, the engine drops them and no exit is ever created", async () => {
    assert.equal(dflt.cfg.inputs.riskUSD, undefined, "Pine default (200) applies");
    dflt.visible = FILLS[0];
    const r = dflt.runner();
    await r.tick(); // warm-up
    await dflt.replayTo(r, FILLS[3]); // the SHORT setup, then the first LONG setup
    const box = r.state.outbox;
    const [sell, buy] = box;
    assert.deepEqual([sell.action, sell.status, sell.positionDropped], ["SELL", "rejected", true]); // short selling is disabled
    assert.deepEqual([buy.action, buy.status, buy.code, buy.positionDropped], ["BUY", "rejected", "MAX_ORDER_NOTIONAL", true]);
    assert.match(buy.reason, /above the limit \$5000/);
    assert.ok(!box.some((x) => x.kind === "EXIT"), "a refused entry gets no exit at all");
    assert.equal(r.statusPayload().position, null, "the engine holds nothing the ledger does not hold");
    assert.equal(r.statusPayload().trades.closed, 0, "refused trades are not engine trades either");
    assert.deepEqual(dflt.sends, [sell.id, buy.id], "only the two entries were submitted");

    assert.equal(dflt.sql(`SELECT COUNT(*) AS n FROM alerts WHERE action = 'close'`)[0].n, 0, "no CLOSE ever hit the ledger");
    assert.equal(dflt.sql(`SELECT COUNT(*) AS n FROM paper_positions`)[0].n, 0);
    assert.equal(dflt.sql(`SELECT COUNT(*) AS n FROM trades`)[0].n, 0);
    const rejected = dflt.sql(`SELECT alert_id, response_code, rejection_reason FROM alerts ORDER BY id`);
    assert.deepEqual(rejected.map((a) => a.alert_id), [sell.id, buy.id]);
    assert.ok(rejected.every((a) => a.rejection_reason));

    const d = await dflt.dashboard();
    assert.equal(d.paper.positions.length, 0);
    assert.deepEqual([d.bot.status.last_rejection.status, d.bot.status.last_rejection.code], ["rejected", "MAX_ORDER_NOTIONAL"]);
    assert.equal(d.bot.status.outbox.rejected, 2);
    assert.equal(d.bot.status.outbox.skipped, 0);
    assert.equal(r.statusPayload().refused_entries, 2); // engine-side count (not yet shown by the Worker)
    assert.equal(d.bot.status.position, null);
    assert.equal(d.bot.status.ledger_check.status, "OK");
  });
});

describe("paper-test profile ($5 risk): engine and ALPHA PAPER ledger stay in step", () => {
  let r;
  it("warm-up sends nothing; the heartbeat shows the engine ONLINE with its profile", async () => {
    assert.deepEqual(test.cfg.inputs, { riskUSD: 5 });
    // PAPER capital for the LONG trades ($5 risk: positions well under $5,000).
    await test.act("/api/paper/fund", { action: "deposit", amount_usd: 5000 });
    await test.act("/api/paper/transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 5000 });
    test.visible = FILLS[0];
    r = test.runner();
    await r.tick();
    assert.equal(test.sends.length, 0);
    const d = await test.dashboard();
    assert.equal(d.bot.state, "ONLINE");
    assert.deepEqual([d.bot.status.profile, d.bot.status.risk_usd, d.bot.status.mode], ["paper-test", 5, "PAPER"]);
    assert.ok(!JSON.stringify(d.bot).includes(WEBHOOK_SECRET));
  });

  it("BUY accepted → the same position is open in the ledger; CLOSE → both flat and one ALPHA PAPER trade", async () => {
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

  it("restart, forced resend and an outage never duplicate a simulated trade", async () => {
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
    assert.deepEqual([entry2.status, entry2.code, entry2.positionDropped], ["skipped", "SIGNAL_EXPIRED", true]);
    assert.equal(r3.statusPayload().position, null, "the expired entry's position is dropped");
    await test.replayTo(r3, FILLS[5]);
    assert.ok(!r3.state.outbox.some((x) => x.entryId === entry2.id), "no exit for an entry the ledger never received");
    assert.equal(test.sql(`SELECT COUNT(*) AS n FROM alerts WHERE alert_id = '${entry2.id}'`)[0].n, 0, "it never reached the ledger");
    assert.deepEqual(counts(), before, "no fill, order or trade was added");
    test.skewMs = 0;
  });

  it("the engine's ledger view is read-only and needs the webhook secret", async () => {
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

  it("a silent engine is shown truthfully as STALE, then OFFLINE", async () => {
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

  it("the status endpoint needs the webhook secret and a supported symbol, and changes nothing else", async () => {
    const post = (body) => fetch(`${test.base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    assert.equal((await post({ secret: "wrong", status: { symbol: "SOLUSD" } })).status, 401);
    assert.equal((await post({ secret: WEBHOOK_SECRET, status: { symbol: "SPY" } })).status, 400);
    assert.equal((await post("x".repeat(9000))).status, 413); // limit 8 KB (status with sizing details fits)
    const snap = () => test.sql(`SELECT (SELECT COUNT(*) FROM alerts) a, (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM paper_positions) p`)[0];
    const before = snap();
    assert.equal((await post({ secret: WEBHOOK_SECRET, status: { symbol: "SOLUSD", timeframe: "5m", status_text: "ok", extra: "dropped" } })).status, 200);
    assert.deepEqual(snap(), before);
    const d = await test.dashboard();
    assert.equal(d.bot.state, "ONLINE");
    assert.equal(d.bot.status.extra, undefined);
  });
});

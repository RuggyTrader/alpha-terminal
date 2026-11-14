// Strategy Mirror V2 on a real local Worker: mirror-only BTCUSD and ETHUSD next to SOLUSD.
//   * the real engine MarketsRunner (BTCUSD + ETHUSD) and a SOLUSD mirror deliver to one Worker
//   * one account per market; ids, sequences and journals independent; every request within the D1 bound
//   * GET /api/dashboard/mirror/overview: one entry per market, per category, no total across markets
//   * session-only routes; funded tables byte-identical (no funded request from a mirror-only market)
// Isolated: port 8810, its own persist dir, Kraken prices from committed fixtures / labelled test quotes on 127.0.0.1.
//   node --test test/mirror_markets.test.mjs

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "./lib/kraken-stub.mjs";
import { loadConfig } from "../../engine/src/config.mjs";
import { runBacktest } from "../../engine/src/cli/backtest.mjs";
import { MarketsRunner } from "../../engine/src/markets.mjs";
import { EngineRunner } from "../../engine/src/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_DIR = join(HERE, "..");
const ENGINE = join(DEV_DIR, "..", "engine");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const PORT = 8810;
const BASE = `http://127.0.0.1:${PORT}`;
const KRAKEN = await startKrakenStub();
const STEP = 300_000;
const work = mkdtempSync(join(tmpdir(), "alpha-mirror-markets-"));
const persist = join(work, "d1");
const FIX = (s) => JSON.parse(readFileSync(join(ENGINE, "test", "fixtures", `${s}-5m-kraken.json`), "utf8")).candles;
const CANDLES = { SOLUSD: FIX("SOLUSD"), BTCUSD: FIX("BTCUSD"), ETHUSD: FIX("ETHUSD") };
const P5 = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, ENGINE);

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
async function start() {
  // A stale process must never satisfy readiness for this test's private D1/secrets.
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
    throw new Error(`port ${PORT} is already in use; refusing to attach to another test Worker`);
  } catch (e) { if (/already in use/.test(String(e.message))) throw e; }
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", "9810", "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, PAPER_MARK_MIN_INTERVAL_SECONDS: "0", ALPACA_KEY: "", ALPACA_SECRET: "" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: DEV_DIR, stdio: ["ignore", "pipe", "pipe"], shell: WIN, detached: !WIN });
  let output = "";
  const capture = (chunk) => { output = (output + String(chunk)).slice(-8000); };
  worker.stdout.on("data", capture); worker.stderr.on("data", capture);
  const diagnostic = () => [WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET].reduce((s, secret) => s.replaceAll(secret, "[REDACTED]"), output);
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    if (worker.exitCode !== null) throw new Error(`Worker exited (${worker.exitCode}) before readiness:\n${diagnostic()}`);
    try { if ((await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) })).status === 200) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Worker did not start:\n${diagnostic()}`);
}
async function stop() {
  if (worker && worker.exitCode === null) {
    try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid, "SIGTERM"); } catch { /* gone */ }
  }
  worker = null;
}
async function get(path, expect = 200) {
  if (!cookie) {
    const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
    assert.equal(r.status, 200);
    cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  }
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" } });
  assert.equal(r.status, expect, path);
  return (await r.json()).data;
}
async function paperAction(kind, body) {
  await get("/api/dashboard");
  const r = await fetch(`${BASE}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
    body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }) });
  assert.equal(r.status, 200);
}
const FUNDED = ["portfolio_wallets", "portfolio_entries", "paper_positions", "paper_fills", "trades", "alerts", "orders", "risk_decisions", "strategy_settings", "engine_state"];
const funded = () => JSON.stringify(Object.fromEntries(FUNDED.map((t) => [t, d1(`SELECT * FROM ${t} ORDER BY rowid`)])));

/** Real http to the local Worker, recording every request path and every mirror response's d1_queries. */
const seen = [];
const http = async (url, init) => {
  const r = await fetch(url, init);
  const body = await r.clone().json().catch(() => ({}));
  seen.push({ path: new URL(url).pathname, status: r.status, items: JSON.parse(init.body).items?.length ?? null, d1: body.d1_queries ?? null });
  return r;
};
/** Feed with a controllable clock per market. */
const feed = (candles, start) => {
  const f = { visible: start };
  f.fetch = async ({ sinceMs }) => candles.slice(0, f.visible).filter((k) => sinceMs === null || k.t > sinceMs);
  f.now = () => candles[f.visible - 1].t + STEP + 10_000;
  return f;
};

before(async () => {
  execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", "d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist], { cwd: DEV_DIR, stdio: "ignore", shell: WIN, timeout: 120000 });
  await start();
  await paperAction("fund", { action: "deposit", amount_usd: 100 });
  await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 10 });
});
after(async () => { await stop(); await KRAKEN.close(); try { rmSync(work, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

let fundedBefore, markets, sol;
describe("Strategy Mirror V2 on the Worker: BTCUSD and ETHUSD (mirror-only) next to SOLUSD", () => {
  it("the real MarketsRunner and a SOLUSD mirror deliver; mirror-only markets never send a funded request", async () => {
    fundedBefore = funded();
    const dir = mkdtempSync(join(tmpdir(), "alpha-v2-engine-"));
    const feeds = { BTCUSD: feed(CANDLES.BTCUSD, 200), ETHUSD: feed(CANDLES.ETHUSD, 200) };
    const cfgOf = (s) => ({ ...loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m", ENGINE_SYMBOL: s, ENGINE_FUNDED: "off", ENGINE_MIRROR: "on" }, ENGINE),
      sync: true, apiBase: BASE, webhookSecret: WEBHOOK_SECRET, dataDir: dir, krakenBase: "" });
    markets = new MarketsRunner(["BTCUSD", "ETHUSD"].map(cfgOf), {
      makeRunner: (cfg) => new EngineRunner(cfg, { fetchCandles: feeds[cfg.symbol].fetch, http, now: feeds[cfg.symbol].now, log: () => {} }), sleep: async () => {}, log: () => {},
    });
    await markets.round();
    for (let i = 0; i < 518; i++) { for (const f of Object.values(feeds)) f.visible += 1; await markets.round(); }
    assert.deepEqual([...new Set(seen.map((x) => x.path))], ["/webhook/engine-mirror"], "mirror-only markets: no dry-run, ledger or engine-status request");
    // A SOLUSD mirror account from the same engine code (funded track answered by the real Worker).
    const solFeed = feed(CANDLES.SOLUSD, 200);
    sol = new EngineRunner({ symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, sync: true, apiBase: BASE, webhookSecret: WEBHOOK_SECRET, dataDir: dir, lateBars: 2, krakenBase: "", mirror: true, profile: "solusd-5m" },
      { fetchCandles: solFeed.fetch, http, now: solFeed.now, log: () => {} });
    await sol.tick();
    while (solFeed.visible < CANDLES.SOLUSD.length) { solFeed.visible += 1; await sol.tick(); }
    for (const m of markets.markets) assert.equal(m.runner.mirror.outbox.length, 0, `${m.symbol} delivered everything`);
  });

  it("one account per market; each market's trades = its own backtest; independent sequences; every request ≤ 9 D1 queries and ≤ 25 records", () => {
    const accounts = d1("SELECT account_id, symbol, last_contiguous_seq, max_seq_seen, engine_last_seq, conflicts FROM mirror_accounts ORDER BY symbol");
    assert.deepEqual(accounts.map((a) => a.symbol), ["BTCUSD", "ETHUSD", "SOLUSD"]);
    for (const a of accounts) {
      assert.equal(a.conflicts, 0);
      assert.equal(a.last_contiguous_seq, a.max_seq_seen);
      assert.equal(a.engine_last_seq, a.max_seq_seen);
      const rows = d1("SELECT * FROM mirror_trades WHERE account_id = ? ORDER BY seq", a.account_id);
      assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => i + 1), `${a.symbol} sequence starts at 1`);
      assert.ok(rows.every((r) => r.trade_id.startsWith(`MIR-${a.symbol}-5-`)));
      const n = a.symbol === "SOLUSD" ? CANDLES.SOLUSD.length : 719;
      const ref = runBacktest({ candles: CANDLES[a.symbol].slice(0, n), symbol: a.symbol, intervalMin: 5, inputs: P5.inputs }).trades;
      assert.deepEqual(rows.map((r) => [r.side, r.entry_time, r.exit_time, r.entry_price, r.exit_price]),
        ref.map((t) => [t.side, t.entryTime.replace(".000Z", "Z"), t.exitTime.replace(".000Z", "Z"), t.entryPrice, t.exitPrice]), a.symbol);
      assert.ok(rows.filter((r) => r.classification === "live").every((r) => r.reference_price > 0), "live trades carry a reference price, stored apart from the strategy's fill prices");
      assert.ok(rows.filter((r) => r.classification !== "live").every((r) => r.reference_price === null), "historical trades get none");
    }
    const mirrorPosts = seen.filter((x) => x.path === "/webhook/engine-mirror");
    assert.ok(mirrorPosts.every((x) => x.status === 200));
    assert.ok(Math.max(...mirrorPosts.map((x) => x.d1)) <= 9, `max ${Math.max(...mirrorPosts.map((x) => x.d1))} queries`);
    assert.ok(Math.max(...mirrorPosts.map((x) => x.items)) <= 25);
  });

  it("overview: one entry per market, each category separate, no total across markets; health OK; reconciled", async () => {
    const o = await get("/api/dashboard/mirror/overview");
    assert.match(o.label, /^Hypothetical/);
    assert.match(o.note, /Nothing is added across markets/);
    assert.deepEqual(o.markets.map((m) => m.symbol), ["BTCUSD", "ETHUSD", "SOLUSD"]);
    assert.equal(JSON.stringify(o).includes("total"), false, "no total field anywhere");
    for (const m of o.markets) {
      const db = d1("SELECT classification, COUNT(*) AS n, SUM(gross_pnl) AS g FROM mirror_trades WHERE account_id = ? GROUP BY 1", m.account_id);
      for (const c of ["historical", "catch_up", "live"]) {
        const r = db.find((x) => x.classification === c);
        assert.equal(m.categories[c].trades, r ? r.n : 0, `${m.symbol} ${c}`);
        assert.ok(Math.abs(m.categories[c].gross_pnl - (r ? r.g : 0)) < 1e-6);
      }
      assert.equal(m.reconciled, true);
      assert.equal(m.health.state, "OK", JSON.stringify(m.health));
    }
    // Each market's detail view and trade proof by account.
    const btc = o.markets.find((m) => m.symbol === "BTCUSD");
    const detail = await get(`/api/dashboard/mirror?account=${btc.account_id}`);
    assert.equal(detail.account.symbol, "BTCUSD");
    const list = await get(`/api/dashboard/mirror/trades?account=${btc.account_id}&category=historical&limit=5`);
    if (list.trades.length) {
      const p = await get(`/api/dashboard/mirror/trade?id=${encodeURIComponent(list.trades[0].trade_id)}&account=${btc.account_id}`);
      assert.equal(p.account.account_id, btc.account_id);
      assert.deepEqual(p.checks, { gross_equals_price_move: true, journal_matches: true, net_equals_gross_minus_costs: true });
    }
  });

  it("routes need a session; the funded books are exactly as before (only SOLUSD's funded track spoke to the ledger)", async () => {
    for (const p of ["/api/dashboard/mirror/overview", "/api/dashboard/mirror?account=x"]) assert.equal((await fetch(`${BASE}${p}`)).status, 401, p);
    const after = JSON.parse(funded());
    const before = JSON.parse(fundedBefore);
    for (const t of ["portfolio_wallets", "portfolio_entries", "paper_positions", "paper_fills", "trades", "strategy_settings", "engine_state"]) assert.deepEqual(after[t], before[t], t);
    assert.ok(after.alerts.every((a) => a.symbol === "SOLUSD" || a.symbol === "SPY"), "only SOLUSD's funded signals reached the ledger");
    assert.equal(d1("SELECT COUNT(*) AS n FROM portfolio_entries WHERE kind = 'FEE'")[0].n, 0);
  });
});

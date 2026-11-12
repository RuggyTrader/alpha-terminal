// Strategy Mirror V1 on a real local Worker (wrangler dev, local D1 with migrations 0001-0005), production-shaped
// funded data (MAIN $90, SOLUSD $10, costs none, trading off). Covers:
//   * POST /webhook/engine-mirror: authentication, strict validation, idempotency, conflicts, sequence gaps
//   * the 150-day mirror (579 trades) stored and summarised: gross +$150.24, PF 1.076, max DD $225.97 (Model A),
//     cost comparison equal to Model B (Ndax), separate categories, reconciliation
//   * funded-ledger isolation: every funded table byte-identical before/after; production-style refusals unchanged
//   * the real engine runner (mirror on) against this Worker end to end
//   * rollback compatibility: the deployed Worker (e941387e = 8b188c8) and the fee-compatible rollback Worker (c5bb67e)
//     run on schema 5 with mirror rows; the books stay identical
// Isolated: port 8807, its own persist dir, Kraken prices from the committed real fixture on 127.0.0.1.
//   node --test test/mirror.test.mjs

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "./lib/kraken-stub.mjs";
import { createMirror, mirrorStep } from "../../engine/src/mirror.mjs";
import { loadConfig } from "../../engine/src/config.mjs";
import { runBacktest } from "../../engine/src/cli/backtest.mjs";
import { tradeCosts } from "../../engine/src/cli/baseline.mjs";
import { VENUES } from "../../engine/src/costs.mjs";
import { EngineRunner } from "../../engine/src/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_DIR = join(HERE, "..");
const REPO = join(DEV_DIR, "..");
const ENGINE = join(REPO, "engine");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const PORT = 8807;
const BASE = `http://127.0.0.1:${PORT}`;
const KRAKEN = await startKrakenStub();
const STEP = 300_000;
const work = mkdtempSync(join(tmpdir(), "alpha-mirror-worker-"));
const persist = join(work, "d1");
const P5 = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, ENGINE);

// ---------------------------------------------------------------- Worker plumbing (as deploy_rehearsal.test.mjs)

const link = (target, path) => (WIN ? execFileSync("cmd", ["/c", "mklink", "/J", path, target], { stdio: "ignore" }) : execFileSync("ln", ["-s", target, path]));
function extract(ref, name) {
  const root = join(work, name);
  for (const f of execFileSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", ref, "worker"], { encoding: "utf8" }).trim().split("\n")) {
    if (f.startsWith("worker/test/")) continue;
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), execFileSync("git", ["-C", REPO, "show", `${ref}:${f}`], { maxBuffer: 64 * 1024 * 1024 }));
  }
  link(join(DEV_DIR, "node_modules"), join(root, "worker", "node_modules"));
  link(join(REPO, "frontend"), join(root, "frontend"));
  return join(root, "worker");
}
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
  let busy = false;
  try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) }); busy = true; } catch { /* free */ }
  if (busy) throw new Error(`port ${PORT} is already in use`);
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", "9807", "--ip", "127.0.0.1", "--persist-to", persist];
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
  const j = await r.json();
  return j.data ?? j;
}
async function paperAction(kind, body) {
  if (!cookie) await login();
  const r = await fetch(`${BASE}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
    body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }) });
  assert.equal(r.status, 200);
}
const postJson = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { http: r.status, ...(await r.json()) };
};
// Every mirror response reports how many D1 queries it used; the suite checks the Workers Free bound (50) with margin.
const QUERY_COUNTS = [];
const mirrorPost = async (account, items, s = WEBHOOK_SECRET) => {
  const r = await postJson("/webhook/engine-mirror", { secret: s, account, items });
  if (typeof r.d1_queries === "number") QUERY_COUNTS.push(r.d1_queries);
  return r;
};
const signal = (id, action, qty) => ({ secret: WEBHOOK_SECRET, id, symbol: "SOLUSD", timeframe: "5", action, strategy: "OTE Pro Strat (engine)", ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString(), liquidity: "maker" });

/** Every funded table, every row: the books the mirror must never touch. */
const FUNDED = ["portfolio_wallets", "portfolio_entries", "paper_positions", "paper_fills", "trades", "alerts", "orders", "risk_decisions", "strategy_settings", "activity_events", "engine_state"];
const funded = () => JSON.stringify(Object.fromEntries(FUNDED.map((t) => [t, d1(`SELECT * FROM ${t} ORDER BY rowid`)])));

// ---------------------------------------------------------------- the mirror records under test

const D150 = JSON.parse(gunzipSync(readFileSync(join(ENGINE, "test", "fixtures", "SOLUSD-5m-150d.rows.json.gz"))).toString("utf8"));
const C150 = D150.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const HASH = "0150d0150d0150d0"; // a test account of its own (the end-to-end engine run below reports into its real one)
function replay150() {
  const ctx = { lateMs: 2 * STEP, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, inputsHash: HASH };
  const M = createMirror({ ...ctx, nowMs: C150[0].t });
  for (const k of C150) mirrorStep(M, k, { ...ctx, nowMs: k.t + STEP + 5_000 });
  return M;
}
const M150 = replay150();
const ITEMS = M150.outbox.map(({ status: _s, attempts: _a, ...x }) => x);
const account = (over = {}) => ({
  account_id: `MIRROR-SOLUSD-5m-${HASH}`, symbol: "SOLUSD", timeframe: "5m", profile: "solusd-5m", strategy: "OTE Pro Strat (engine)",
  inputs_hash: HASH, engine_version: "0.1.0", engine_release: null, engine_commit: null, created_at: "2026-06-12T00:00:00Z",
  activated_at: null, last_candle_time: "2026-11-08T23:55:00Z", last_candle_close: C150.at(-1).c, candles_processed: C150.length, risk_usd: 10,
  last_seq: M150.seq, pending: 0, refused: 0, open_position: null, resets: 0, interruptions: 0, skipped_candles: 0, last_error: null, ...over,
});

before(async () => {
  execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", "d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist], { cwd: DEV_DIR, stdio: "ignore", shell: WIN, timeout: 120000 });
  await start(DEV_DIR);
  await paperAction("fund", { action: "deposit", amount_usd: 100 });
  await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 10 });
});
after(async () => { await stop(); await KRAKEN.close(); try { rmSync(work, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

let fundedBefore;
describe("Strategy Mirror on the Worker", () => {
  it("setup equals production apart from the schema (development schema 7: 0007 bots), costs none, trading off, MAIN $90 / SOLUSD $10, consistent", async () => {
    assert.equal(d1("SELECT value FROM app_meta WHERE key = 'schema_version'")[0].value, "7");
    const d = await get("/api/dashboard");
    assert.equal(d.enable_trading, false);
    assert.equal(d.portfolio.costs.profile, "none");
    assert.equal(d.portfolio.consistency.ok, true);
    fundedBefore = funded();
  });

  it("authentication: a wrong or missing secret is refused and stores nothing; the dashboard routes need a session", async () => {
    assert.equal((await mirrorPost(account(), ITEMS.slice(0, 2), "wrong")).http, 401);
    assert.equal((await postJson("/webhook/engine-mirror", { account: account(), items: [] })).http, 401);
    assert.equal(d1("SELECT COUNT(*) AS n FROM mirror_accounts")[0].n, 0);
    for (const p of ["/api/dashboard/mirror", "/api/dashboard/mirror/trades", "/api/dashboard/mirror/trade?id=x"]) assert.equal((await fetch(`${BASE}${p}`)).status, 401, p);
    assert.equal((await postJson("/webhook/engine-mirror", "nope")).http, 400);
  });

  it("strict validation: a malformed record is refused per item, with its reason; nothing of it is stored", async () => {
    const t = ITEMS[0];
    const bad = [
      { ...t, seq: 900001, gross_pnl: t.gross_pnl + 5 },
      { ...t, seq: 900002, exit_price: t.exit_candle.h + 1, gross_pnl: (t.exit_candle.h + 1 - t.entry_price) * t.qty * (t.side === "LONG" ? 1 : -1) },
      { ...t, seq: 900003, processed_at: t.exit_time },
      { ...t, seq: 900004, trade_id: t.trade_id.replace("SOLUSD", "BTCUSD") },
      { ...t, seq: 900005, classification: "funded" },
      { ...t, seq: 0 },
      { ...t, seq: 900006, type: "DEPOSIT" },
    ];
    const r = await mirrorPost(account({ inputs_hash: "aaaaaaaaaaaaaaaa", account_id: "MIRROR-SOLUSD-5m-aaaaaaaaaaaaaaaa" }), bad);
    assert.equal(r.http, 200);
    assert.deepEqual(r.results.map((x) => x.status), Array(7).fill("invalid"));
    assert.match(r.results.find((x) => x.seq === 900001).message, /gross_pnl/);
    assert.match(r.results.find((x) => x.seq === 900002).message, /outside/);
    assert.match(r.results.find((x) => x.seq === 900003).message, /lookahead/);
    assert.equal(d1("SELECT COUNT(*) AS n FROM mirror_trades")[0].n, 0);
    assert.equal((await mirrorPost({ ...account(), account_id: "MIRROR-SOLUSD-5m-other" }, [])).code, "INVALID_ACCOUNT");
  });

  it("the 150-day mirror (579 trades) is stored once; a full re-delivery is all duplicates", async () => {
    for (let i = 0; i < ITEMS.length; i += 25) {
      const r = await mirrorPost(account(), ITEMS.slice(i, i + 25));
      assert.equal(r.http, 200);
      assert.ok(r.results.every((x) => x.status === "stored"), JSON.stringify(r.results.find((x) => x.status !== "stored")));
    }
    assert.equal(d1("SELECT COUNT(*) AS n FROM mirror_trades WHERE account_id = ?", account().account_id)[0].n, 579);
    for (let i = 0; i < ITEMS.length; i += 25) {
      const r = await mirrorPost(account(), ITEMS.slice(i, i + 25));
      assert.ok(r.results.every((x) => x.status === "duplicate"));
      assert.deepEqual([r.account.last_contiguous_seq, r.account.max_seq_seen, r.account.missing], [579, 579, 0]);
    }
    assert.equal(d1("SELECT COUNT(*) AS n FROM mirror_trades")[0].n, 579, "no duplicate rows");
    assert.equal(d1("SELECT COUNT(*) AS n FROM mirror_entries WHERE kind = 'REALIZED_GROSS_PNL'")[0].n, 579);
  });

  it("changed content under a stored id, or a reused sequence number, is a conflict: refused, counted, never overwritten", async () => {
    const t = ITEMS[10];
    const r1 = await mirrorPost(account(), [{ ...t, exit_r: 99 }]);
    assert.deepEqual([r1.results[0].status, r1.results[0].code], ["conflict", "TRADE_CONFLICT"]);
    const other = { ...ITEMS[11], seq: ITEMS[10].seq, trade_id: `MIR-SOLUSD-5-2026-11-08T00:00:00Z-LONG`, entry_time: "2026-11-08T00:00:00Z" };
    const r2 = await mirrorPost(account(), [other]);
    assert.ok(["conflict", "invalid"].includes(r2.results[0].status));
    const stored = d1("SELECT exit_r FROM mirror_trades WHERE trade_id = ?", t.trade_id)[0];
    assert.equal(stored.exit_r, t.exit_r, "not overwritten");
    assert.ok(d1("SELECT conflicts FROM mirror_accounts WHERE account_id = ?", account().account_id)[0].conflicts >= 1);
  });

  it("dashboard: the historical category reproduces Model A; costs are a separate comparison equal to Model B (Ndax)", async () => {
    const m = await get("/api/dashboard/mirror");
    assert.equal(m.label, "Hypothetical — unlimited buying power, not executable performance");
    assert.match(m.disclosure, /margin-0/);
    const h = m.categories.historical;
    assert.deepEqual([h.trades, h.longs, h.shorts], [579, 308, 271]);
    assert.equal(Math.round(h.gross_pnl * 100) / 100, 150.24);
    assert.equal(h.profit_factor, 1.076);
    assert.equal(h.max_drawdown, 225.97);
    assert.equal(h.wins, 217);
    assert.deepEqual([Math.round(h.long.gross * 100) / 100, Math.round(h.short.gross * 100) / 100], [230.97, -80.73]);
    assert.deepEqual(h.exits, { tp2: 127, stop_loss: 121, trailing: 261, break_even: 47, time_exit: 0, same_bar: 23, unlabelled: 0 });
    // Model B (STRATEGY-AUDIT section 3): the same trades with Ndax costs, computed independently by the research code.
    const modelB = M150.outbox.reduce((s, t) => s + t.gross_pnl - tradeCosts({ side: t.side, qty: t.qty, entryPrice: t.entry_price, exitPrice: t.exit_price, exitKind: t.exit_kind }, VENUES.ndax).total, 0);
    assert.ok(Math.abs(modelB - -9594.13) < 0.01, `research Model B ${modelB}`);
    assert.ok(Math.abs(h.net_modelled_pnl - modelB) < 0.05, `mirror net ${h.net_modelled_pnl} vs Model B ${modelB}`);
    assert.equal(m.cost_model.id, "ndax");
    assert.match(m.cost_model.note, /Comparison only/);
    assert.ok(Math.abs(h.gross_pnl - h.est_fees - h.est_slippage - h.net_modelled_pnl) < 0.01);
    // Risk reporting on the $10,000 reporting baseline (Model A never fell below about $9,846 there).
    assert.equal(h.risk.reporting_equity_usd, 10000);
    assert.equal(h.risk.negative_equity, false);
    assert.ok(h.risk.min_equity > 9840 && h.risk.min_equity < 9850, String(h.risk.min_equity));
    assert.ok(h.risk.max_notional_usd > 15000 && h.risk.max_notional_usd < 15100, "largest position about $15,061");
    assert.equal(h.risk.margin_required_usd["10x"], Math.round(h.risk.max_notional_usd / 10 * 100) / 100);
    assert.ok(h.risk.max_implied_leverage > 1);
    assert.equal(h.risk.fixed_risk_usd, 10);
    assert.ok(h.curve.length > 10 && h.curve.length <= 401);
    // Live and catch-up are empty: nothing historical is presented as live.
    assert.equal(m.categories.live.trades, 0);
    assert.equal(m.categories.catch_up.trades, 0);
    assert.equal(m.reconciliation.ok, true);
    assert.equal(m.reconciliation.trades, 579);
    assert.equal(m.health.state, "DIVERGED", "the conflicts above are reported");
    assert.ok(m.health.issues.some((i) => /conflicting/.test(i)));
  });

  it("trade list and trade proof: candles, provenance, journal entry and checks", async () => {
    const list = await get("/api/dashboard/mirror/trades?category=historical&limit=5");
    assert.equal(list.total, 579);
    assert.equal(list.trades.length, 5);
    await get("/api/dashboard/mirror/trades?category=funded", 400);
    const p = await get(`/api/dashboard/mirror/trade?id=${encodeURIComponent(ITEMS[0].trade_id)}`);
    assert.equal(p.trade.trade_id, ITEMS[0].trade_id);
    assert.deepEqual(p.candles.exit, ITEMS[0].exit_candle);
    assert.deepEqual(p.candles.entry, ITEMS[0].entry_candle);
    assert.deepEqual(p.checks, { gross_equals_price_move: true, journal_matches: true, net_equals_gross_minus_costs: true });
    assert.equal(p.trade.inputs_hash, HASH);
    assert.equal(p.trade.reference_price, null, "historical trades get no live reference price");
    await get("/api/dashboard/mirror/trade?id=MIR-SOLUSD-5-2020-01-01T00:00:00Z-LONG", 404);
    await get("/api/dashboard/mirror/trade?id=../etc", 400);
  });

  it("sequence gap: a record numbered but never stored is detected and reported", async () => {
    const acc = account({ inputs_hash: "bbbbbbbbbbbbbbbb", account_id: "MIRROR-SOLUSD-5m-bbbbbbbbbbbbbbbb", last_seq: 3 });
    const r = await mirrorPost(acc, []);
    assert.equal(r.http, 200);
    const ev = { type: "POSITION_INTERRUPTED", seq: 2, event_id: `${acc.account_id}:INTERRUPTED:2026-11-01T00:00:00Z`, trade_id: "MIR-SOLUSD-5-2026-11-01T00:00:00Z-LONG",
      side: "LONG", qty: 30, entry_time: "2026-11-01T00:00:00Z", entry_price: 95, stop_price: 94.7, tp2_price: 96, last_candle: "2026-11-01T01:00:00Z", last_close: 95.2,
      reason: "gap of 30 candles after 2026-11-01T01:00:00Z", processed_at: "2026-11-03T00:00:00Z", classification: "live" };
    const r2 = await mirrorPost(acc, [ev]);
    assert.equal(r2.results[0].status, "stored");
    assert.deepEqual([r2.account.last_contiguous_seq, r2.account.max_seq_seen, r2.account.missing], [0, 2, 1], "seq 1 is missing");
    assert.equal((await mirrorPost(acc, [ev])).results[0].status, "duplicate");
    const m = await get(`/api/dashboard/mirror?account=${acc.account_id}`);
    assert.equal(m.health.state, "DIVERGED");
    assert.ok(m.health.issues.some((i) => /sequence gap/.test(i)));
    assert.ok(m.health.issues.some((i) => /interrupted/.test(i)));
    assert.equal(m.interruptions.length, 1);
    assert.equal(d1("SELECT COUNT(*) AS n FROM mirror_entries WHERE kind = 'POSITION_INTERRUPTED' AND amount_usd <> 0")[0].n, 0, "no P&L for an interruption");
  });

  it("Workers Free bounds: at most 25 records per request; every request used at most 9 D1 queries (limit 50)", async () => {
    const r = await mirrorPost(account(), ITEMS.slice(0, 26));
    assert.deepEqual([r.http, r.code], [400, "INVALID_ITEMS"]);
    // A worst-case mixed request: 25 records, new + duplicate + conflicting + invalid, in one call.
    const acc = account({ inputs_hash: "dddddddddddddddd", account_id: "MIRROR-SOLUSD-5m-dddddddddddddddd" });
    const fresh = ITEMS.slice(100, 125);
    const first = await mirrorPost(acc, fresh.slice(0, 10));
    assert.ok(first.results.every((x) => x.status === "stored"));
    const mixed = [...fresh.slice(0, 5), { ...fresh[5], exit_r: 42 }, ...fresh.slice(10, 22), { ...fresh[22], gross_pnl: 1e6 }, { ...fresh[23], seq: fresh[0].seq }, fresh[24]];
    const m = await mirrorPost(acc, mixed);
    assert.equal(m.http, 200);
    assert.ok(m.d1_queries <= 9, `used ${m.d1_queries} queries`);
    const by = (st) => m.results.filter((x) => x.status === st).length;
    assert.deepEqual([by("duplicate"), by("conflict"), by("invalid"), by("stored")], [5, 2, 1, 13]);
    assert.ok(QUERY_COUNTS.length > 30 && Math.max(...QUERY_COUNTS) <= 9, `max ${Math.max(...QUERY_COUNTS)} over ${QUERY_COUNTS.length} requests`);
  });

  it("dashboard with thousands of trades: 5,000+ stored in bounded requests; summary served, figures exact, response size measured", async () => {
    const acc = account({ inputs_hash: "eeeeeeeeeeeeeeee", account_id: "MIRROR-SOLUSD-5m-eeeeeeeeeeeeeeee" });
    const shift = (iso, k) => new Date(Date.parse(iso) + k * 150 * 86_400_000).toISOString().replace(".000Z", "Z");
    const copies = 9;
    const many = [];
    for (let k = 0; k < copies; k++) {
      for (const t of ITEMS) {
        const e = shift(t.entry_time, k), x = shift(t.exit_time, k);
        many.push({ ...t, seq: k * ITEMS.length + t.seq, trade_id: t.trade_id.replace(t.entry_time, e), entry_time: e, exit_time: x,
          entry_candle: { ...t.entry_candle, t: e }, exit_candle: { ...t.exit_candle, t: x }, processed_at: shift(t.processed_at, k), entry_processed_at: shift(t.entry_processed_at, k) });
      }
    }
    const t0 = Date.now();
    for (let i = 0; i < many.length; i += 25) {
      const r = await mirrorPost(acc, many.slice(i, i + 25));
      assert.ok(r.results.every((x) => x.status === "stored"), JSON.stringify(r.results.find((x) => x.status !== "stored")));
    }
    const ingestMs = Date.now() - t0;
    const t1 = Date.now();
    if (!cookie) await login();
    const res = await fetch(`${BASE}/api/dashboard/mirror?account=${acc.account_id}`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" } });
    const text = await res.text();
    const dashMs = Date.now() - t1;
    const d = JSON.parse(text).data;
    assert.equal(d.categories.historical.trades, ITEMS.length * copies);
    assert.equal(Math.round(d.categories.historical.gross_pnl * 100) / 100, Math.round(150.24 * copies * 100) / 100);
    assert.equal(d.reconciliation.ok, true);
    assert.ok(d.categories.historical.curve.length <= 401, "chart points are bounded");
    assert.ok(text.length < 200_000, `summary ${text.length} bytes`);
    const list = await get(`/api/dashboard/mirror/trades?account=${acc.account_id}&category=historical&limit=500`);
    assert.equal(list.trades.length, 500, "trade list is paginated (max 500 per page)");
    console.log(`# capacity: ${many.length} trades stored in ${Math.ceil(many.length / 25)} requests (${ingestMs} ms locally); dashboard summary ${text.length} bytes in ${dashMs} ms locally`);
  });

  it("activation is set once: another activation time for the same account is refused", async () => {
    const acc = account({ inputs_hash: "cccccccccccccccc", account_id: "MIRROR-SOLUSD-5m-cccccccccccccccc", activated_at: "2026-11-10T00:00:00Z" });
    assert.equal((await mirrorPost(acc, [])).http, 200);
    const r = await mirrorPost({ ...acc, activated_at: "2026-11-11T00:00:00Z" }, []);
    assert.deepEqual([r.http, r.code], [409, "ACTIVATION_CONFLICT"]);
  });

  it("funded isolation: every funded table is byte-identical after all mirror activity; refusals and limits unchanged", async () => {
    assert.equal(funded(), fundedBefore, "funded wallets, entries, positions, fills, trades, alerts, orders, risk decisions, settings");
    const codes = [];
    for (const [id, action, qty] of [["ISO-short", "SELL", 35.61067391], ["ISO-long", "BUY", 30.5265509], ["ISO-big", "BUY", 87.36]]) codes.push((await postJson("/webhook/dry-run", signal(`ENG-SOLUSD-5-${id}`, action, qty))).code);
    assert.deepEqual(codes, ["NO_POSITION", "INSUFFICIENT_PAPER_CAPITAL", "MAX_ORDER_NOTIONAL"], "same refusals as production (paper_fidelity_probe)");
    const d = await get("/api/dashboard");
    assert.equal(d.portfolio.consistency.ok, true);
    assert.deepEqual(d.portfolio.wallets.filter((w) => ["MAIN", "SOLUSD"].includes(w.wallet)).map((w) => [w.wallet, w.available_usd]), [["MAIN", 90], ["SOLUSD", 10]]);
    assert.equal(d.portfolio.limits.max_order_notional_usd, 5000);
    assert.equal(d.portfolio.limits.short_selling_enabled, false);
    assert.equal(d.portfolio.totals.fees_usd, 0);
    assert.equal(d1("SELECT COUNT(*) AS n FROM portfolio_entries WHERE kind = 'FEE'")[0].n, 0);
  });
});

describe("the real engine runner (mirror on) against this Worker, end to end", () => {
  it("live candles: mirror trades in D1 = the strategy replay; funded entries refused by the real Worker; books unchanged", async () => {
    const C720 = JSON.parse(readFileSync(join(ENGINE, "test", "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;
    const dataDir = mkdtempSync(join(tmpdir(), "alpha-mirror-e2e-"));
    const cfg = { symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, sync: true, apiBase: BASE, webhookSecret: WEBHOOK_SECRET, dataDir, lateBars: 2, krakenBase: "", mirror: true, profile: "solusd-5m" };
    let visible = 200;
    const now = () => C720[visible - 1].t + STEP + 10_000;
    const fetchCandles = async ({ sinceMs }) => C720.slice(0, visible).filter((k) => sinceMs === null || k.t > sinceMs);
    const booksBefore = JSON.stringify([d1("SELECT * FROM portfolio_wallets ORDER BY wallet"), d1("SELECT * FROM portfolio_entries ORDER BY id"), d1("SELECT * FROM paper_fills"), d1("SELECT * FROM paper_positions")]);
    const r = new EngineRunner(cfg, { fetchCandles, now, log: () => {} });
    await r.tick();
    while (visible < C720.length) { visible += 1; await r.tick(); }
    const acc = r.mirror.accountId;
    const ref = runBacktest({ candles: C720, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs }).trades;
    const rows = d1("SELECT * FROM mirror_trades WHERE account_id = ? ORDER BY seq", acc);
    assert.equal(rows.length, ref.length, JSON.stringify({ lastError: r.mirror.lastError, refused: r.mirror.outbox.filter((x) => x.status !== "pending").slice(0, 2).map((x) => [x.refused_code, x.refused_reason]), pending: r.mirror.outbox.length }));
    rows.forEach((t, i) => {
      const a = ref[i];
      assert.deepEqual([t.side, t.qty, t.entry_time, t.entry_price, t.exit_time, t.exit_price, t.result],
        [a.side, a.qty, a.entryTime.replace(".000Z", "Z"), a.entryPrice, a.exitTime.replace(".000Z", "Z"), a.exitPrice, a.result], `trade ${i + 1}`);
    });
    assert.ok(rows.some((t) => t.classification === "live") && rows.some((t) => t.classification === "historical"));
    assert.ok(rows.filter((t) => t.classification === "live").every((t) => t.reference_price > 0), "live trades carry the Kraken reference price, stored separately");
    assert.ok(r.state.refusedEntries > 0, "the funded track's entries were refused by the real Worker");
    const codes = new Set(d1("SELECT response_code FROM alerts WHERE alert_id LIKE 'ENG-SOLUSD-5-2026-11-0%'").map((x) => x.response_code));
    assert.ok([...codes].every((c) => ["NO_POSITION", "INSUFFICIENT_PAPER_CAPITAL", "MAX_ORDER_NOTIONAL"].includes(c)), [...codes].join(","));
    assert.equal(JSON.stringify([d1("SELECT * FROM portfolio_wallets ORDER BY wallet"), d1("SELECT * FROM portfolio_entries ORDER BY id"), d1("SELECT * FROM paper_fills"), d1("SELECT * FROM paper_positions")]), booksBefore);
    const m = await get(`/api/dashboard/mirror?account=${acc}`);
    assert.equal(m.health.state, "OK", JSON.stringify(m.health));
    assert.equal(m.account.activated_at, r.mirror.activatedAt);
    assert.equal(m.categories.live.trades + m.categories.historical.trades + m.categories.catch_up.trades, ref.length);
    assert.equal(r.mirror.outbox.length, 0);
  });
});

describe("rollback compatibility on schema 5 with mirror rows", () => {
  const snap = () => JSON.stringify([funded(), d1("SELECT COUNT(*) AS n FROM mirror_trades"), d1("SELECT COUNT(*) AS n FROM mirror_entries")]);
  for (const [name, ref] of [["deployed Worker e941387e (8b188c8)", "8b188c8"], ["fee-compatible rollback Worker (c5bb67e)", "c5bb67e"]]) {
    it(`${name}: runs, books consistent and identical, mirror rows kept, mirror endpoint absent (engine keeps records pending)`, async () => {
      const before = snap();
      await stop();
      await start(extract(ref, ref));
      const d = await get("/api/dashboard");
      assert.equal(d.portfolio.consistency.ok, true);
      assert.equal(d.enable_trading, false);
      assert.equal((await mirrorPost(account(), [])).http, 404);
      assert.equal(snap(), before);
      await stop();
      await start(DEV_DIR);
      assert.equal((await get("/api/dashboard")).portfolio.consistency.ok, true);
      assert.equal(snap(), before);
      assert.equal((await get("/api/dashboard/mirror")).reconciliation.ok, true);
    });
  }
});

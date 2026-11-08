// ALPHA PAPER portfolio end to end on the real Worker (`wrangler dev --local`) with a throwaway D1:
// funding, transfers, reservations by fills, realized P&L attribution, insufficient capital, duplicates,
// concurrent transfers, the versioned risk setting with engine confirmation, and the backtest cache.
// Prices come from a local Kraken Ticker fixture (stated below). The Worker runs WITHOUT Alpaca keys: the
// ALPHA PAPER risk account is the D1 strategy balance. No broker order is ever sent; all money here is simulated.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret();
const DASHBOARD_PASSPHRASE = secret();
const ADMIN_SECRET = secret();
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

const market = { prices: { SOLUSD: 100, ETHUSD: 2000 } };
const KEYS = { SOLUSD: "SOLUSD", ETHUSD: "XETHZUSD" };
const fixture = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "GET" || url.pathname !== "/0/public/Ticker") { res.writeHead(404).end(); return; }
  const result = {};
  for (const pair of (url.searchParams.get("pair") ?? "").split(",")) if (market.prices[pair]) result[KEYS[pair]] = { c: [String(market.prices[pair]), "1.0"] };
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result }));
});

const persist = mkdtempSync(join(tmpdir(), "alpha-portfolio-test-"));
let worker;
const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 90000 });
function d1(sql) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  const db = new DatabaseSync(join(dir, file), { readOnly: true });
  try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); }
}
const W = (w) => d1(`SELECT * FROM portfolio_wallets WHERE wallet = '${w}'`)[0];
const usd = (m) => Number(m) / 1e6;

let cookie = null;
async function login() {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  assert.equal(r.status, 200);
  cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
}
async function action(path, body, { pass = DASHBOARD_PASSPHRASE, withCookie = true, header = true } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(header ? { "X-Alpha-Terminal": "1" } : {}), ...(withCookie && cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ ...body, passphrase: pass }),
  });
  return { status: r.status, json: await r.json() };
}
const rid = () => randomBytes(9).toString("hex");
let n = 0;
async function signal(action_, qty, id) {
  const body = { secret: WEBHOOK_SECRET, id: id ?? `PF-SOL-${action_}-${++n}`, symbol: "SOLUSD", timeframe: "5", action: action_, strategy: "OTE Pro Strat", ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString() };
  const r = await fetch(`${BASE}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json(), id: body.id };
}
async function dash() {
  const r = await fetch(`${BASE}/api/dashboard`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" } });
  assert.equal(r.status, 200);
  return (await r.json()).data;
}
async function heartbeat(settings) {
  const status = { engine: "alpha-engine", symbol: "SOLUSD", timeframe: "5m", profile: "solusd-5m", risk_usd: settings?.risk_usd ?? 10, remote_settings: true, settings };
  const r = await fetch(`${BASE}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: WEBHOOK_SECRET, status }) });
  assert.equal(r.status, 200);
  return (await r.json()).settings;
}
/** Every accounting identity, straight from D1. */
function assertBooksBalance() {
  const ws = d1(`SELECT * FROM portfolio_wallets`);
  for (const w of ws) {
    const e = d1(`SELECT COALESCE(SUM(available_change_micro),0) AS a, COALESCE(SUM(reserved_change_micro),0) AS r FROM portfolio_entries WHERE wallet = '${w.wallet}'`)[0];
    assert.equal(Number(w.available_micro), Number(e.a), `${w.wallet} available vs history`);
    assert.equal(Number(w.reserved_micro), Number(e.r), `${w.wallet} reserved vs history`);
    assert.ok(Number(w.available_micro) >= 0 && Number(w.reserved_micro) >= 0, `${w.wallet} never negative`);
  }
  const book = ws.reduce((s, w) => s + Number(w.available_micro) + Number(w.reserved_micro), 0);
  const ident = ws.reduce((s, w) => s + Number(w.net_funding_micro) + Number(w.realized_pnl_micro), 0);
  assert.equal(book, ident, "book balance = funding + realized P&L");
}

before(async () => {
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  const vars = { WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: `http://127.0.0.1:${fixture.address().port}`, PAPER_MARK_MIN_INTERVAL_SECONDS: "0", ALPACA_KEY: "", ALPACA_SECRET: "" };
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`); // blank Alpaca keys override worker/.dev.vars
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).status === 200) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  await login();
});
after(() => {
  if (worker && worker.exitCode === null) {
    try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid, "SIGTERM"); } catch { /* gone */ }
  }
  fixture.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked on Windows until workerd exits */ }
});

describe("ALPHA PAPER portfolio", () => {
  it("actions need the header, a session and the passphrase; a wrong passphrase changes nothing (403, not a sign-out)", async () => {
    const body = { action: "deposit", amount_usd: 100, request_id: rid() };
    assert.equal((await action("/api/paper/fund", body, { header: false })).status, 403);
    assert.equal((await action("/api/paper/fund", body, { withCookie: false })).status, 401);
    const wrong = await action("/api/paper/fund", body, { pass: "not-the-passphrase" });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.code, "INVALID_PASSPHRASE");
    assert.equal(d1(`SELECT COUNT(*) AS n FROM portfolio_entries`)[0].n, 0);
  });

  it("before funding, a BUY is refused: an unfunded balance cannot spend money it does not have", async () => {
    assert.equal((await (await fetch(`${BASE}/health`)).json()).alpaca_configured, false);
    const buy = await signal("BUY", 0.5); // $50 against a $0 SOL balance
    assert.equal(buy.status, 422, JSON.stringify(buy.json));
    assert.equal(buy.json.code, "INSUFFICIENT_PAPER_CAPITAL");
    assert.equal(buy.json.broker_request_sent, false);
    const [rd] = d1(`SELECT checks_json FROM risk_decisions ORDER BY id DESC LIMIT 1`);
    assert.match(rd.checks_json, /SOLUSD PAPER balance available/, "buying power came from the D1 balance");
    assert.equal(d1(`SELECT COUNT(*) AS n FROM paper_positions`)[0].n, 0);
    assert.equal(d1(`SELECT COUNT(*) AS n FROM paper_fills`)[0].n, 0);
    assert.equal(d1(`SELECT COUNT(*) AS n FROM portfolio_entries`)[0].n, 0);
    assert.equal((await signal("CLOSE")).json.code, "NO_POSITION");
  });

  it("deposits are idempotent per request id, and a reused id cannot change meaning", async () => {
    const id = rid();
    assert.equal((await action("/api/paper/fund", { action: "deposit", amount_usd: 100, request_id: id })).status, 200);
    const again = await action("/api/paper/fund", { action: "deposit", amount_usd: 100, request_id: id });
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true);
    assert.equal((await action("/api/paper/fund", { action: "deposit", amount_usd: 50, request_id: id })).json.code, "REQUEST_ID_REUSED");
    assert.equal(usd(W("MAIN").available_micro), 100);
    assertBooksBalance();
  });

  it("transfers move available funds atomically and refuse to overdraw", async () => {
    const ok = await action("/api/paper/transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 20, request_id: rid() });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(usd(W("MAIN").available_micro), 80);
    assert.equal(usd(W("SOLUSD").available_micro), 20);
    const over = await action("/api/paper/transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 80.01, request_id: rid() });
    assert.equal(over.status, 409);
    assert.equal(over.json.code, "INSUFFICIENT_AVAILABLE");
    assert.equal((await action("/api/paper/transfer", { from: "MAIN", to: "MAIN", amount_usd: 1, request_id: rid() })).status, 400);
    assertBooksBalance();
  });

  it("a BUY reserves its full position value; reserved funds cannot be transferred; a duplicate signal reserves once", async () => {
    market.prices.SOLUSD = 100;
    const buy = await signal("BUY", 0.15); // $15 position from a $20 balance
    assert.equal(buy.status, 200, JSON.stringify(buy.json));
    let sol = W("SOLUSD");
    assert.equal(usd(sol.available_micro), 5);
    assert.equal(usd(sol.reserved_micro), 15);
    const dup = await signal("BUY", 0.15, buy.id);
    assert.equal(dup.json.code, "DUPLICATE");
    assert.equal(usd(W("SOLUSD").reserved_micro), 15);
    const blocked = await action("/api/paper/transfer", { from: "SOLUSD", to: "MAIN", amount_usd: 10, request_id: rid() });
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.message, /reserved/);
    sol = W("SOLUSD");
    assert.equal(usd(sol.available_micro), 5);
    assertBooksBalance();
  });

  it("a BUY larger than the strategy balance is rejected with INSUFFICIENT_PAPER_CAPITAL (no leverage)", async () => {
    const big = await signal("BUY", 1); // $100 more, $5 available
    assert.equal(big.status, 422);
    assert.equal(big.json.code, "INSUFFICIENT_PAPER_CAPITAL");
    assert.equal(d1(`SELECT status, response_code FROM alerts WHERE alert_id = '${big.id}'`)[0].status, "rejected");
    assert.equal(d1(`SELECT qty FROM paper_positions WHERE status = 'OPEN'`)[0].qty, 0.15);
    assertBooksBalance();
  });

  it("closing credits realized P&L to the strategy balance; transfers never count as profit", async () => {
    market.prices.SOLUSD = 110;
    const close = await signal("CLOSE");
    assert.equal(close.status, 200, JSON.stringify(close.json));
    const sol = W("SOLUSD");
    assert.equal(usd(sol.reserved_micro), 0);
    assert.equal(usd(sol.realized_pnl_micro), 1.5); // 0.15 × (110 − 100)
    assert.equal(usd(sol.available_micro), 21.5);
    assert.equal(usd(sol.net_funding_micro), 20);
    assert.equal(usd(W("MAIN").realized_pnl_micro), 0);
    const back = await action("/api/paper/transfer", { from: "SOLUSD", to: "MAIN", amount_usd: 21.5, request_id: rid() });
    assert.equal(back.status, 200);
    assert.equal(usd(W("SOLUSD").realized_pnl_micro), 1.5, "moving profit out does not change realized P&L");
    assert.equal(usd(W("MAIN").available_micro), 101.5);
    assertBooksBalance();
  });

  it("concurrent transfers never overdraw: exactly the affordable ones succeed", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      action("/api/paper/transfer", { from: "MAIN", to: "ETHUSD", amount_usd: 10, request_id: rid() })));
    const ok = results.filter((r) => r.status === 200).length;
    assert.equal(ok, 10, results.map((r) => `${r.status} ${r.json.code ?? ""}`).join(", "));
    assert.ok(results.every((r) => r.status === 200 || r.json.code === "INSUFFICIENT_AVAILABLE"));
    assert.equal(usd(W("MAIN").available_micro), 1.5);
    assert.equal(usd(W("ETHUSD").available_micro), 100);
    assertBooksBalance();
  });

  it("risk per trade: validated against the allocation, PENDING until the engine confirms, versioned", async () => {
    const tooBig = await action("/api/paper/risk", { strategy: "SOLUSD", risk_usd: 10, request_id: rid() });
    assert.equal(tooBig.json.code, "RISK_EXCEEDS_ALLOCATION"); // SOLUSD balance is $0 now
    assert.equal((await action("/api/paper/transfer", { from: "ETHUSD", to: "SOLUSD", amount_usd: 30, request_id: rid() })).status, 200);
    // The engine first sees the initial v1 ($10), applies it and confirms.
    let next = await heartbeat(null);
    assert.deepEqual([next.version, next.risk_usd, next.status], [1, 10, "PENDING"]);
    next = await heartbeat({ version: 1, risk_usd: 10 });
    assert.equal(next.status, "APPLIED");
    const set = await action("/api/paper/risk", { strategy: "SOLUSD", risk_usd: 12.5, request_id: rid() });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    let s = (await dash()).portfolio.strategies.SOLUSD.settings;
    assert.equal(s.applied.risk_usd, 10);
    assert.equal(s.pending.risk_usd, 12.5);
    // A stale confirmation (old version) does not apply the new one.
    next = await heartbeat({ version: 1, risk_usd: 10 });
    assert.deepEqual([next.version, next.status], [2, "PENDING"]);
    next = await heartbeat({ version: 2, risk_usd: 12.5 });
    assert.equal(next.status, "APPLIED");
    s = (await dash()).portfolio.strategies.SOLUSD.settings;
    assert.equal(s.applied.version, 2);
    assert.equal(s.pending, null);
    assert.deepEqual(s.history.map((h) => h.status), ["APPLIED", "SUPERSEDED"]);
    assert.equal((await action("/api/paper/risk", { strategy: "SOLUSD", risk_usd: 0.5, request_id: rid() })).status, 400);
  });

  it("simultaneous fills competing for one balance: the funds are spent at most once and the books stay consistent", async () => {
    market.prices.SOLUSD = 100;
    const before = W("SOLUSD");
    assert.equal(usd(before.available_micro), 30);
    assert.equal(usd(before.reserved_micro), 0);
    const fills0 = d1(`SELECT COUNT(*) AS n FROM paper_fills`)[0].n;
    // Round 1: four $20 BUYs at once against $30 → exactly one fits.
    const round1 = await Promise.all([1, 2, 3, 4].map(() => signal("BUY", 0.2)));
    const ok1 = round1.filter((r) => r.status === 200);
    const no1 = round1.filter((r) => r.status !== 200);
    assert.equal(ok1.length, 1, round1.map((r) => `${r.status} ${r.json.code}`).join(", "));
    for (const r of no1) {
      assert.equal(r.status, 422);
      assert.equal(r.json.code, "INSUFFICIENT_PAPER_CAPITAL");
      assert.equal(d1(`SELECT status FROM alerts WHERE alert_id = '${r.id}'`)[0].status, "rejected");
    }
    let sol = W("SOLUSD");
    assert.equal(usd(sol.reserved_micro), 20);
    assert.equal(usd(sol.available_micro), 10);
    assert.equal(d1(`SELECT COUNT(*) AS n FROM paper_fills`)[0].n, fills0 + 1);
    assert.equal(d1(`SELECT qty FROM paper_positions WHERE symbol = 'SOLUSD' AND status = 'OPEN'`)[0].qty, 0.2);
    assertBooksBalance();

    const mainBefore = usd(W("MAIN").available_micro);
    // Round 2: two $8 BUYs (adding to the position) and an $8 transfer out, all at once, against the $10 left →
    // exactly one of the three can be paid; nothing goes negative.
    const [b1, b2, t1] = await Promise.all([
      signal("BUY", 0.08), signal("BUY", 0.08),
      action("/api/paper/transfer", { from: "SOLUSD", to: "MAIN", amount_usd: 8, request_id: rid() }),
    ]);
    const paid = [b1.status, b2.status, t1.status].filter((s) => s === 200).length;
    assert.equal(paid, 1, `${b1.status} ${b1.json.code} / ${b2.status} ${b2.json.code} / ${t1.status} ${t1.json.code}`);
    for (const r of [b1, b2]) if (r.status !== 200) assert.equal(r.json.code, "INSUFFICIENT_PAPER_CAPITAL");
    if (t1.status !== 200) assert.equal(t1.json.code, "INSUFFICIENT_AVAILABLE");
    sol = W("SOLUSD");
    assert.equal(usd(sol.available_micro), 2);
    const buyWon = t1.status !== 200;
    assert.equal(usd(sol.reserved_micro), buyWon ? 28 : 20);
    assert.equal(usd(W("MAIN").available_micro), mainBefore + (buyWon ? 0 : 8));
    assert.equal(d1(`SELECT COUNT(*) AS n FROM paper_fills`)[0].n, fills0 + (buyWon ? 2 : 1));
    console.log(`round 2 winner: ${buyWon ? "a BUY" : "the transfer"}; refusals: ${[b1, b2, t1].filter((r) => r.status !== 200).map((r) => r.json.message).join(" | ")}`);
    assertBooksBalance();

    // Close at the entry price (no P&L) so the later checks keep their totals; everything reserved comes back.
    const close = await signal("CLOSE");
    assert.equal(close.status, 200, JSON.stringify(close.json));
    sol = W("SOLUSD");
    assert.equal(usd(sol.reserved_micro), 0);
    if (t1.status === 200) {
      assert.equal(usd(sol.available_micro), 22);
      assert.equal((await action("/api/paper/transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 8, request_id: rid() })).status, 200);
    }
    assert.equal(usd(W("SOLUSD").available_micro), 30);
    assert.equal(usd(W("SOLUSD").realized_pnl_micro), 1.5);
    assertBooksBalance();
  });

  it("the dashboard reports balances, a passing consistency check and the history", async () => {
    const p = (await dash()).portfolio;
    assert.equal(p.active, true);
    assert.equal(p.consistency.ok, true, p.consistency.issues.join("; "));
    assert.equal(p.totals.book_balance_usd, 101.5);
    assert.equal(p.totals.realized_pnl_usd, 1.5);
    assert.equal(p.totals.net_funding_usd, 100);
    assert.ok(p.history.some((h) => h.kind === "REALIZED_PNL" && h.wallet === "SOLUSD" && h.available_change_usd === 1.5));
    assert.equal(p.limits.short_selling_enabled, false);
  });

  it("backtest cache: only the engine secret can upload; the dashboard reads it", async () => {
    const result = { strategy: "SOLUSD", profile: "solusd-5m", config_hash: "abcdef0123456789", risk_basis_usd: 10, data: { from: "2026-10-13T00:00:00Z", to: "2026-11-07T00:00:00Z" }, execution: [], trades: [] };
    const bad = await fetch(`${BASE}/webhook/engine-backtest`, { method: "POST", body: JSON.stringify({ secret: "x", result }) });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${BASE}/webhook/engine-backtest`, { method: "POST", body: JSON.stringify({ secret: WEBHOOK_SECRET, result }) });
    assert.equal(ok.status, 200);
    const r = await fetch(`${BASE}/api/dashboard/backtest?strategy=SOLUSD`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" } });
    assert.equal((await r.json()).data.result.config_hash, "abcdef0123456789");
  });
});

// The ALPHA PAPER risk account comes from D1, not a broker: no Alpaca keys, today's P&L and the daily loss limit
// from PAPER fills, and a safe rejection whenever the account data is missing or unreliable.
//
// Real Worker (`wrangler dev --local`) with a throwaway D1 and NO Alpaca keys. Prices are REAL Kraken SOLUSD
// closes: a loopback server answers Kraken's Ticker API with closes taken from the engine's Kraken fixture
// (test/fixtures/SOLUSD-5m-2026-10-19_2026-11-07.json, rebuilt from Kraken's public trades). Only the time is
// replayed; no price is made up. The scenario uses a real one-hour fall, 2026-11-05 14:20 → 15:20 UTC.
// This isolated Worker sets DAILY_LOSS_LIMIT to $25 so a position under the $5,000 order limit can reach it;
// production keeps its own limit ($2,000). No broker order is ever sent.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const PORT = 8794, BASE = `http://127.0.0.1:${PORT}`;
const DAILY_LOSS_LIMIT = 25;

// Real Kraken closes (fixture rows are [t, o, h, l, c]).
const FIX = JSON.parse(readFileSync(join(WORKER_DIR, "..", "engine", "test", "fixtures", "SOLUSD-5m-2026-10-19_2026-11-07.json"), "utf8"));
const close = (iso) => {
  const row = FIX.rows.find((r) => r[0] === Date.parse(iso));
  assert.ok(row, `no Kraken candle at ${iso}`);
  return row[4];
};
const ENTRY = close("2026-11-05T14:20:00Z"); // 95.11
const EXIT = close("2026-11-05T15:20:00Z"); // 90.37
const QTY = 10;

const market = { price: ENTRY, fail: false };
const ticker = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "GET" || url.pathname !== "/0/public/Ticker") { res.writeHead(404).end(); return; }
  if (market.fail) { res.writeHead(503, { "Content-Type": "application/json" }).end("{}"); return; }
  const result = (url.searchParams.get("pair") ?? "").split(",").includes("SOLUSD") ? { SOLUSD: { c: [String(market.price), "1.0"] } } : {};
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result }));
});

const persist = mkdtempSync(join(tmpdir(), "alpha-paper-account-"));
let worker, cookie;
const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 90000 });
function db(write = false) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  return new DatabaseSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")), { readOnly: !write });
}
const d1 = (sql) => { const c = db(); try { return c.prepare(sql).all().map((r) => ({ ...r })); } finally { c.close(); } };
const sol = () => d1(`SELECT * FROM portfolio_wallets WHERE wallet = 'SOLUSD'`)[0];
const usd = (m) => Number(m) / 1e6;

let n = 0;
async function signal(action, qty) {
  const body = { secret: WEBHOOK_SECRET, id: `ACCT-${action}-${++n}`, symbol: "SOLUSD", timeframe: "5", action, strategy: "OTE Pro Strat", ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString() };
  const r = await fetch(`${BASE}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json(), id: body.id };
}
async function paper(kind, body) {
  const r = await fetch(`${BASE}/api/paper/${kind}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
    body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }),
  });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
}
async function dashboard() {
  const r = await fetch(`${BASE}/api/dashboard`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" } });
  assert.equal(r.status, 200);
  return (await r.json()).data;
}
const lastChecks = () => JSON.parse(d1(`SELECT checks_json FROM risk_decisions ORDER BY id DESC LIMIT 1`)[0].checks_json);
const counts = () => d1(`SELECT (SELECT COUNT(*) FROM paper_fills) AS fills, (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM portfolio_entries) AS entries`)[0];

before(async () => {
  await new Promise((r) => ticker.listen(0, "127.0.0.1", r));
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  const vars = {
    WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: `http://127.0.0.1:${ticker.address().port}`,
    PAPER_MARK_MIN_INTERVAL_SECONDS: "0", DAILY_LOSS_LIMIT: String(DAILY_LOSS_LIMIT), ALPACA_KEY: "", ALPACA_SECRET: "",
  };
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 60000;
  let up = false;
  while (!up && Date.now() < end) {
    try { up = (await fetch(`${BASE}/health`)).status === 200; } catch { /* starting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error("Worker did not start");
  const l = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  cookie = l.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
});
after(() => {
  if (worker && worker.exitCode === null) {
    try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid, "SIGTERM"); } catch { /* gone */ }
  }
  ticker.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

describe("ALPHA PAPER risk account from D1 (no Alpaca, real Kraken closes)", () => {
  it("no Alpaca keys; the real prices make a loss larger than this Worker's daily limit", async () => {
    assert.equal((await (await fetch(`${BASE}/health`)).json()).alpaca_configured, false);
    assert.equal([ENTRY, EXIT].join(), "95.11,90.37");
    assert.ok(QTY * (ENTRY - EXIT) > DAILY_LOSS_LIMIT);
    await paper("fund", { action: "deposit", amount_usd: 5000 });
    await paper("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 5000 });
  });

  it("BUY 10 SOL at the 14:20 close: approved on the D1 balance and reserved from it", async () => {
    market.price = ENTRY;
    const r = await signal("BUY", QTY);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.broker_request_sent, false);
    const checks = lastChecks();
    const bp = checks.find((c) => c.check === "buying_power");
    assert.equal(bp.passed, true);
    assert.match(bp.detail, /<= 5000 \(SOLUSD PAPER balance available\)/);
    assert.match(checks.find((c) => c.check === "daily_loss_limit").detail, /ALPHA PAPER realized today/);
    assert.ok(checks.find((c) => c.check === "account_active").detail.startsWith("ALPHA_PAPER_D1"));
    assert.equal(usd(sol().reserved_micro), +(QTY * ENTRY).toFixed(6));
  });

  it("unreliable data: with the open position's mark failing, a new entry is refused, nothing assumed", async () => {
    market.fail = true;
    try {
      const d = await dashboard(); // marks the open position; Kraken (the loopback server) now fails
      assert.equal(d.paper.positions[0].mark_status, "STALE");
      const before = counts();
      const r = await signal("BUY", 1);
      assert.equal(r.status, 502, JSON.stringify(r.json)); // retryable: no price for the new order either
      assert.equal(r.json.code, "MARKET_DATA_UNAVAILABLE");
      market.fail = false;
      // Price back, but the position's last mark is still flagged: today's P&L is unknown → refused.
      const r2 = await signal("BUY", 1);
      assert.equal(r2.status, 422, JSON.stringify(r2.json));
      assert.equal(r2.json.code, "ACCOUNT_DATA_UNAVAILABLE");
      assert.match(r2.json.message, /no current mark for the open SOLUSD PAPER position/);
      assert.deepEqual(counts(), before, "no fill, order or balance change");
    } finally {
      market.fail = false;
    }
  });

  it("CLOSE at the 15:20 close: the real loss returns to the SOL balance as realized P&L", async () => {
    market.price = EXIT;
    const r = await signal("CLOSE");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const pnl = +(QTY * (EXIT - ENTRY)).toFixed(6); // −47.40
    const w = sol();
    assert.equal(usd(w.reserved_micro), 0);
    assert.equal(usd(w.realized_pnl_micro), pnl);
    assert.equal(usd(w.available_micro), +(5000 + pnl).toFixed(6));
    assert.equal(usd(w.net_funding_micro), 5000, "a loss is not funding");
    const [t] = d1(`SELECT realized_pnl FROM trades WHERE source = 'ALPHA_PAPER'`);
    assert.equal(Number(t.realized_pnl), pnl);
  });

  it("daily loss limit: today's D1 P&L (−$47.40) is past −$25, so the next entry is refused; CLOSE is never blocked", async () => {
    const before = counts();
    const r = await signal("BUY", 1);
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, "DAILY_LOSS_LIMIT");
    assert.match(r.json.message, /-47\.4/);
    assert.deepEqual(counts(), before);
    assert.equal((await signal("CLOSE")).json.code, "NO_POSITION"); // nothing open; a CLOSE is checked, not limited
  });

  it("missing account data: without the SOL balance row the BUY is refused, never given invented buying power", async () => {
    const c = db(true);
    try { c.exec("PRAGMA foreign_keys = OFF; DELETE FROM portfolio_wallets WHERE wallet = 'SOLUSD'"); } finally { c.close(); } // test-only tampering
    const before = counts();
    const r = await signal("BUY", 1);
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, "ACCOUNT_DATA_UNAVAILABLE");
    assert.match(r.json.message, /SOLUSD PAPER balance was not found/);
    assert.deepEqual(counts(), before);
    assert.equal(d1(`SELECT COUNT(*) AS n FROM orders WHERE alpaca_order_id IS NOT NULL`)[0].n, 0);
  });
});

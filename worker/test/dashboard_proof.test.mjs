// Verified Performance and Trade Proof routes (read-only), against a real Worker (`wrangler dev --local`, throwaway
// D1, no Alpaca keys). Prices are REAL Kraken SOLUSD closes from the engine's Kraken fixture, served by a loopback
// Ticker stand-in: BUY 10 at the 2026-11-05 14:20 close (95.11), CLOSE at 15:20 (90.37). A closed trade without the
// ALPHA PAPER source is written straight into this test's own database to prove it is never counted as verified.

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
const PORT = 8796, BASE = `http://127.0.0.1:${PORT}`;

const FIX = JSON.parse(readFileSync(join(WORKER_DIR, "..", "engine", "test", "fixtures", "SOLUSD-5m-2026-10-19_2026-11-07.json"), "utf8"));
const close = (iso) => FIX.rows.find((r) => r[0] === Date.parse(iso))[4];
const ENTRY = close("2026-11-05T14:20:00Z"); // 95.11
const EXIT = close("2026-11-05T15:20:00Z"); // 90.37
const QTY = 10;

const market = { price: ENTRY };
const ticker = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/0/public/Ticker") { res.writeHead(404).end(); return; }
  const result = (url.searchParams.get("pair") ?? "").split(",").includes("SOLUSD") ? { SOLUSD: { c: [String(market.price), "1.0"] } } : {};
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result }));
});

const persist = mkdtempSync(join(tmpdir(), "alpha-proof-"));
let worker, cookie;
const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 90000 });
function db(write = false) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  return new DatabaseSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")), { readOnly: !write });
}
const get = async (path, auth = true) => {
  const r = await fetch(`${BASE}${path}`, { headers: auth ? { Cookie: cookie, "X-Alpha-Terminal": "1" } : { "X-Alpha-Terminal": "1" } });
  return { status: r.status, json: await r.json() };
};
let n = 0;
async function signal(action, qty) {
  const body = { secret: WEBHOOK_SECRET, id: `PROOF-${action}-${++n}`, symbol: "SOLUSD", timeframe: "5", action, strategy: "OTE Pro Strat (engine)", ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString() };
  const r = await fetch(`${BASE}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  return body.id;
}
async function paper(kind, body) {
  const r = await fetch(`${BASE}/api/paper/${kind}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
    body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }),
  });
  assert.equal(r.status, 200);
}

before(async () => {
  await new Promise((r) => ticker.listen(0, "127.0.0.1", r));
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  const vars = { WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: `http://127.0.0.1:${ticker.address().port}`, PAPER_MARK_MIN_INTERVAL_SECONDS: "0", ALPACA_KEY: "", ALPACA_SECRET: "" };
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

describe("verified performance and trade proof", () => {
  let buyId, closeId, verifiedId, otherId;

  it("an empty ledger has no verified trades", async () => {
    const r = await get("/api/dashboard/performance");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.trades, []);
    assert.equal(r.json.data.excluded_closed_trades, 0);
  });

  it("a real-price BUY → CLOSE becomes one verified trade; a trade from another source is excluded", async () => {
    await paper("fund", { action: "deposit", amount_usd: 5000 });
    await paper("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 5000 });
    market.price = ENTRY;
    buyId = await signal("BUY", QTY);
    market.price = EXIT;
    closeId = await signal("CLOSE");
    const c = db(true);
    try {
      c.prepare(`INSERT INTO trades (symbol, direction, status, strategy, entry_qty, entry_avg_price, exit_qty, exit_avg_price, open_qty, realized_pnl, opened_at, closed_at)
        VALUES ('SPY', 'LONG', 'CLOSED', 'TEST', '1', '100', '1', '200', '0', '100', '2026-10-31T00:00:00Z', '2026-10-31T01:00:00Z')`).run();
      verifiedId = c.prepare(`SELECT id FROM trades WHERE source = 'ALPHA_PAPER'`).get().id;
      otherId = c.prepare(`SELECT id FROM trades WHERE source IS NULL`).get().id;
    } finally { c.close(); }

    const r = (await get("/api/dashboard/performance")).json.data;
    assert.equal(r.trades.length, 1);
    assert.equal(r.excluded_closed_trades, 1);
    const t = r.trades[0];
    assert.equal(t.id, verifiedId);
    assert.equal(t.symbol, "SOLUSD");
    assert.equal(Math.round(t.realized_pnl * 100) / 100, Math.round((EXIT - ENTRY) * QTY * 100) / 100); // −47.40
    assert.equal(Math.round(t.cost_basis * 100) / 100, Math.round(ENTRY * QTY * 100) / 100);
  });

  it("trade proof lists the real fills, signals, risk decisions and dry-run intents", async () => {
    const r = await get(`/api/dashboard/trade-proof?id=${verifiedId}`);
    assert.equal(r.status, 200);
    const p = r.json.data;
    assert.equal(p.verified, true);
    assert.deepEqual(p.fills.map((f) => [f.kind, f.side, f.qty, f.price, f.alert_id]), [["OPEN", "buy", QTY, ENTRY, buyId], ["CLOSE", "sell", QTY, EXIT, closeId]]);
    for (const f of p.fills) { assert.match(f.price_source, /kraken/i); assert.ok(f.price_at); }
    assert.deepEqual(p.alerts.map((a) => [a.alert_id, a.action, a.response_code]), [[buyId, "buy", "DRY_RUN_ACCEPTED"], [closeId, "close", "DRY_RUN_ACCEPTED"]]);
    assert.deepEqual(p.risk_decisions.map((d) => [d.alert_id, d.approved, Number(d.reference_price)]), [[buyId, true, ENTRY], [closeId, true, EXIT]]);
    assert.ok(p.risk_decisions.every((d) => Array.isArray(d.checks) && d.checks.length > 0));
    assert.deepEqual(p.orders.map((o) => [o.alert_id, o.side, o.broker_request_sent]), [[buyId, "buy", false], [closeId, "sell", false]]);
    assert.equal(Math.round(Number(p.trade.realized_pnl) * 100), Math.round((EXIT - ENTRY) * QTY * 100));
  });

  it("a trade from another source has no verified proof; bad ids and signed-out requests are refused", async () => {
    const o = await get(`/api/dashboard/trade-proof?id=${otherId}`);
    assert.equal(o.status, 200);
    assert.equal(o.json.data.verified, false);
    assert.deepEqual(o.json.data.fills, []);
    assert.equal((await get("/api/dashboard/trade-proof?id=abc")).status, 400);
    assert.equal((await get("/api/dashboard/trade-proof?id=999999")).status, 404);
    assert.equal((await get("/api/dashboard/performance", false)).status, 401);
    assert.equal((await get(`/api/dashboard/trade-proof?id=${verifiedId}`, false)).status, 401);
  });

  it("the dashboard reports the enforced risk limits read-only", async () => {
    const l = (await get("/api/dashboard")).json.data.portfolio.limits;
    assert.deepEqual(l, {
      max_order_notional_usd: 5000, max_position_exposure_usd: 10000, max_total_exposure_usd: 25000,
      max_open_positions: 5, daily_loss_limit_usd: 2000, short_selling_enabled: false,
    });
  });
});

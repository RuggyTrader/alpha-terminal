// ALPHA PAPER ledger end to end: webhook → risk → dry-run intent → internal position → marks → close → trade.
//
// Runs the real Worker (`wrangler dev --local`) against a throwaway D1. Market data comes from a local
// fixture that answers Kraken's public Ticker API on 127.0.0.1 (KRAKEN_API_BASE accepts only loopback
// besides the real Kraken), so every price below is controlled and stated. The Alpaca PAPER account is read
// (GET only) for account checks, so these cases need PAPER keys in worker/.dev.vars; without them they skip.
// No broker order is ever sent.

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

const devVarKeys = existsSync(join(WORKER_DIR, ".dev.vars"))
  ? readFileSync(join(WORKER_DIR, ".dev.vars"), "utf8").split(/\r?\n/).map((l) => l.split("=")[0].trim())
  : [];
const needsBroker = devVarKeys.includes("ALPACA_KEY") && devVarKeys.includes("ALPACA_SECRET")
  ? {} : { skip: "ALPACA_KEY / ALPACA_SECRET (PAPER) not in worker/.dev.vars" };

// ---------------------------------------------------------------- Kraken Ticker fixture (127.0.0.1)

const KEYS = { XBTUSD: "XXBTZUSD", ETHUSD: "XETHZUSD", SOLUSD: "SOLUSD", HYPEUSD: "HYPEUSD", KAITOUSD: "KAITOUSD" };
const market = { prices: { SOLUSD: 100, ETHUSD: 2000 }, fail: false, requests: [] };
const fixture = http.createServer((req, res) => {
  market.requests.push(`${req.method} ${req.url}`);
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "GET" || url.pathname !== "/0/public/Ticker") { res.writeHead(404).end(); return; }
  if (market.fail) { res.writeHead(503, { "Content-Type": "application/json" }).end("{}"); return; }
  const result = {};
  for (const pair of (url.searchParams.get("pair") ?? "").split(",")) {
    const p = market.prices[pair === "XBTUSD" ? "BTCUSD" : pair];
    if (p) result[KEYS[pair]] = { c: [String(p), "1.0"] };
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result }));
});

// ---------------------------------------------------------------- Worker + D1 helpers

const persist = mkdtempSync(join(tmpdir(), "alpha-ledger-test-"));
const BASE = "http://127.0.0.1:8795";
let worker;

function wrangler(args) {
  return execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], {
    cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 90000,
  });
}

function d1(sql) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  const db = new DatabaseSync(join(dir, file), { readOnly: true });
  try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); }
}

let n = 0;
const signal = (symbol, action, qty) => ({
  secret: WEBHOOK_SECRET, id: `LEDGER-${symbol}-${action}-${++n}`, symbol, timeframe: "1",
  action, strategy: "OTE Pro Strat", ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString(),
});
async function post(body) {
  const r = await fetch(`${BASE}/webhook/dry-run`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  return { status: r.status, json: await r.json() };
}

let cookie = null;
async function dashboard() {
  if (!cookie) {
    const r = await fetch(`${BASE}/auth/login`, {
      method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }), signal: AbortSignal.timeout(30000),
    });
    assert.equal(r.status, 200);
    cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  }
  const r = await fetch(`${BASE}/api/dashboard`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" }, signal: AbortSignal.timeout(30000) });
  assert.equal(r.status, 200);
  const j = await r.json();
  return j.data ?? j;
}

const openSol = () => d1(`SELECT * FROM paper_positions WHERE symbol = 'SOLUSD' AND status = 'OPEN'`);
const fillCount = () => d1(`SELECT COUNT(*) AS n FROM paper_fills`)[0].n;
const close8 = (a, b) => assert.ok(Math.abs(Number(a) - b) < 1e-6, `${a} != ${b}`);

before(async () => {
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const krakenBase = `http://127.0.0.1:${fixture.address().port}`;
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  const args = ["wrangler", "dev", "--local", "--port", "8795", "--inspector-port", "9395", "--ip", "127.0.0.1", "--persist-to", persist];
  const vars = { WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: krakenBase, PAPER_MARK_MIN_INTERVAL_SECONDS: "0" };
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
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
    try {
      if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-worker.pid, "SIGTERM");
    } catch { /* gone */ }
  }
  fixture.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

describe("migrations", () => {
  it("create the ledger tables and columns", () => {
    const tables = d1(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name);
    for (const t of ["paper_positions", "paper_fills", "trades", "activity_events"]) assert.ok(tables.includes(t), t);
    const cols = (t) => d1(`PRAGMA table_info(${t})`).map((c) => c.name);
    for (const c of ["source", "position_fk", "close_alert_id", "price_sources"]) assert.ok(cols("trades").includes(c), c);
    assert.ok(cols("activity_events").includes("position_fk"));
  });
});

describe("ALPHA PAPER lifecycle (fixture prices)", () => {
  let openAlertId;
  let addBody;

  it("OPEN: BUY 0.5 SOLUSD at 100 → dry-run intent → internal position", needsBroker, async () => {
    market.prices.SOLUSD = 100;
    const body = signal("SOLUSD", "BUY", 0.5);
    openAlertId = body.id;
    const r = await post(body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.code, "DRY_RUN_ACCEPTED");
    assert.equal(r.json.broker_request_sent, false);
    assert.equal(r.json.risk.referencePrice, 100);
    assert.equal(r.json.risk.priceSource, "kraken:SOLUSD");
    assert.equal(r.json.paper.label, "ALPHA PAPER");
    assert.equal(r.json.paper.kind, "OPEN");
    const [p] = openSol();
    assert.equal(p.qty, 0.5);
    assert.equal(p.avg_entry_price, 100);
    assert.equal(p.mark_price, 100);
    assert.equal(p.open_alert_id, openAlertId);
    const [fill] = d1(`SELECT * FROM paper_fills`);
    assert.deepEqual([fill.kind, fill.side, fill.qty, fill.price, fill.price_source, fill.alert_id], ["OPEN", "buy", 0.5, 100, "kraken:SOLUSD", openAlertId]);
    const [order] = d1(`SELECT id, alpaca_order_id, status FROM orders`);
    assert.equal(fill.order_fk, order.id);
    assert.equal(order.alpaca_order_id, null);
  });

  it("MARK: price 110 then 90 → unrealized P&L = (mark − avg) × qty × 1", needsBroker, async () => {
    market.prices.SOLUSD = 110;
    let d = await dashboard();
    let pos = d.paper.positions.find((p) => p.symbol === "SOLUSD");
    assert.equal(pos.label, "ALPHA PAPER");
    assert.equal(pos.mark_price, 110);
    assert.equal(pos.mark_source, "kraken:SOLUSD");
    assert.equal(pos.mark_status, "FRESH");
    close8(pos.unrealized_pnl, 5);
    close8(pos.unrealized_pct, 10);
    market.prices.SOLUSD = 90;
    d = await dashboard();
    pos = d.paper.positions.find((p) => p.symbol === "SOLUSD");
    close8(pos.unrealized_pnl, -5);
    close8(pos.unrealized_pct, -10);
    assert.equal(d.paper.broker_positions, false);
    assert.ok(d.recent.activity.some((e) => e.category === "paper" && /mark 90 \(kraken:SOLUSD\) · unrealized -\$5\.00/.test(e.message)));
  });

  it("ADD: BUY 1.5 at 120 → qty 2, weighted average entry 115", needsBroker, async () => {
    market.prices.SOLUSD = 120;
    addBody = signal("SOLUSD", "BUY", 1.5);
    const r = await post(addBody);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.paper.kind, "ADD");
    const [p] = openSol();
    close8(p.qty, 2);
    close8(p.avg_entry_price, 115); // (0.5 × 100 + 1.5 × 120) / 2
    assert.equal(fillCount(), 2);
  });

  it("DUPLICATE: the same alert again changes nothing", needsBroker, async () => {
    const before = openSol()[0];
    const r = await post(addBody);
    assert.equal(r.json.code, "DUPLICATE");
    const after = openSol()[0];
    assert.equal(after.qty, before.qty);
    assert.equal(after.avg_entry_price, before.avg_entry_price);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(fillCount(), 2);
    assert.equal(d1(`SELECT COUNT(*) AS n FROM orders`)[0].n, 2);
  });

  it("REJECTION: BUY 100 SOLUSD ($12,000) and SELL ETHUSD with no position change nothing", needsBroker, async () => {
    const before = openSol()[0];
    let r = await post(signal("SOLUSD", "BUY", 100));
    assert.equal(r.status, 422);
    assert.equal(r.json.code, "MAX_ORDER_NOTIONAL");
    r = await post(signal("ETHUSD", "SELL", 1));
    assert.equal(r.status, 422);
    assert.equal(r.json.code, "NO_POSITION"); // never opens a short
    assert.deepEqual(openSol()[0], before);
    assert.equal(fillCount(), 2);
    assert.equal(d1(`SELECT COUNT(*) AS n FROM paper_positions WHERE symbol = 'ETHUSD'`)[0].n, 0);
  });

  it("MARKET DATA FAILURE: position kept, last mark kept and flagged, nothing invented; CLOSE refused", needsBroker, async () => {
    const before = openSol()[0];
    market.fail = true;
    try {
    const d = await dashboard();
    const pos = d.paper.positions.find((p) => p.symbol === "SOLUSD");
    assert.equal(pos.mark_price, before.mark_price); // 120, the last truthful price (the ADD fill)
    assert.equal(pos.mark_at, before.mark_at);
    assert.equal(pos.mark_status, "STALE");
    assert.match(pos.mark_error, /HTTP 503/);
    close8(pos.unrealized_pnl, 10); // from the last real mark, flagged stale
    assert.equal(d.paper.performance.marks_stale, true);
    assert.ok(d.recent.activity.some((e) => e.category === "market" && /Market data unavailable/.test(e.message)));

    const r = await post(signal("SOLUSD", "CLOSE"));
    assert.equal(r.status, 502);
    assert.equal(r.json.code, "MARKET_DATA_UNAVAILABLE");
    const after = openSol()[0];
    assert.equal(after.qty, before.qty);
    assert.equal(after.status, "OPEN");
    assert.equal(fillCount(), 2);
    } finally {
      market.fail = false;
    }
  });

  it("REDUCE: SELL 0.5 at 130 → realized (130 − 115) × 0.5 = 7.5, qty 1.5", needsBroker, async () => {
    market.prices.SOLUSD = 130;
    const r = await post(signal("SOLUSD", "SELL", 0.5));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.paper.kind, "REDUCE");
    const [p] = openSol();
    close8(p.qty, 1.5);
    close8(p.avg_entry_price, 115);
    close8(p.realized_pnl, 7.5);
    assert.equal(p.mark_error, null);
  });

  it("CLOSE at 140 → position CLOSED, realized 45, ALPHA PAPER trade recorded, activity populated", needsBroker, async () => {
    market.prices.SOLUSD = 140;
    const closeBody = signal("SOLUSD", "CLOSE");
    const r = await post(closeBody);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.paper.kind, "CLOSE");
    assert.equal(openSol().length, 0);
    const [p] = d1(`SELECT * FROM paper_positions WHERE symbol = 'SOLUSD'`);
    assert.equal(p.status, "CLOSED");
    assert.equal(p.qty, 0);
    close8(p.realized_pnl, 45); // 7.5 + (140 − 115) × 1.5

    const [t] = d1(`SELECT * FROM trades`);
    assert.equal(t.source, "ALPHA_PAPER");
    assert.equal(t.direction, "LONG");
    assert.equal(t.status, "CLOSED");
    assert.equal(t.strategy, "OTE Pro Strat");
    close8(t.entry_qty, 2);
    close8(t.entry_avg_price, 115);
    close8(t.exit_qty, 2);
    close8(t.exit_avg_price, 137.5); // (0.5 × 130 + 1.5 × 140) / 2
    close8(t.realized_pnl, 45);
    close8(t.return_pct, (45 / 230) * 100);
    assert.equal(t.open_alert_id, openAlertId);
    assert.equal(t.close_alert_id, closeBody.id);
    assert.equal(t.position_fk, p.id);
    assert.equal(JSON.parse(t.leg_order_ids_json).length, 4);
    assert.equal(t.price_sources, "kraken:SOLUSD");
    assert.ok(t.opened_at && t.closed_at);

    const d = await dashboard();
    assert.equal(d.paper.positions.length, 0);
    close8(d.paper.performance.realized_pnl, 45);
    assert.equal(d.paper.performance.closed_trades, 1);
    assert.equal(d.recent.trades[0].source, "ALPHA_PAPER");
    const msgs = d.recent.activity.map((e) => `${e.category}:${e.message}`);
    for (const re of [/^paper:ALPHA PAPER position opened/, /^paper:ALPHA PAPER position increased/, /^paper:ALPHA PAPER position reduced/,
      /^paper:ALPHA PAPER position closed .* realized \+\$45\.00 \(\+19\.57%\) · trade recorded/, /^alert:Alert accepted/,
      /^risk:Risk approved/, /^risk:Risk rejected · MAX_ORDER_NOTIONAL/, /^order:Dry-run order intent created/, /^alert:Duplicate alert ignored/]) {
      assert.ok(msgs.some((m) => re.test(m)), `missing activity ${re}`);
    }
  });

  it("a new BUY after the close opens a new position lifecycle", needsBroker, async () => {
    const r = await post(signal("SOLUSD", "BUY", 0.1));
    assert.equal(r.json.paper.kind, "OPEN");
    assert.equal(d1(`SELECT COUNT(*) AS n FROM paper_positions WHERE symbol = 'SOLUSD'`)[0].n, 2);
  });

  it("UNSUPPORTED FUTURES: MES / MNQ stay MARKET_DATA_UNAVAILABLE and never open a position", needsBroker, async () => {
    for (const s of ["MES1!", "MNQ1!"]) {
      const r = await post(signal(s, "BUY", 1));
      assert.equal(r.status, 422);
      assert.equal(r.json.code, "MARKET_DATA_UNAVAILABLE");
    }
    assert.equal(d1(`SELECT COUNT(*) AS n FROM paper_positions WHERE symbol IN ('MES', 'MNQ')`)[0].n, 0);
    assert.ok(!market.requests.some((q) => /MES|MNQ/.test(q)), "no price was requested for futures");
  });

  it("no broker order: every intent has no Alpaca id, and market data was only read", needsBroker, async () => {
    assert.equal(d1(`SELECT COUNT(*) AS n FROM orders WHERE alpaca_order_id IS NOT NULL`)[0].n, 0);
    assert.ok(market.requests.length > 0);
    assert.ok(market.requests.every((q) => q.startsWith("GET /0/public/Ticker?pair=")), market.requests.join("\n"));
    const h = await (await fetch(`${BASE}/health`)).json();
    assert.equal(h.enable_trading, false);
  });
});

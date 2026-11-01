// Pine strategy → /webhook/dry-run → validation → PAPER risk → dry-run order intent → D1 → dashboard.
//
// Runs the real Worker with `wrangler dev --local` against a throwaway D1 database. Each request body is
// built from the alert text in tradingview/ote_pd_array_strategy.pine, wrapped the way the TradingView
// alert message wraps it. The webhook secret and dashboard passphrase are random values for this run only.
//
// The risk engine reads the real Alpaca PAPER account (GET only). Those cases need ALPACA_KEY and
// ALPACA_SECRET for the PAPER account in worker/.dev.vars; without them they are skipped.
// No broker order is ever sent: the dry-run path has no order endpoint.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(WORKER_DIR, "..");
const PINE = join(ROOT, "tradingview", "ote_pd_array_strategy.pine");
const WIN = process.platform === "win32";

const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret();
const DASHBOARD_PASSPHRASE = secret();
const ADMIN_SECRET = secret();

const devVarKeys = existsSync(join(WORKER_DIR, ".dev.vars"))
  ? readFileSync(join(WORKER_DIR, ".dev.vars"), "utf8").split(/\r?\n/).map((l) => l.split("=")[0].trim())
  : [];
const HAS_PAPER_KEYS = devVarKeys.includes("ALPACA_KEY") && devVarKeys.includes("ALPACA_SECRET");
const needsBroker = HAS_PAPER_KEYS ? {} : { skip: "ALPACA_KEY / ALPACA_SECRET (PAPER) not in worker/.dev.vars" };

// ---------------------------------------------------------------- Pine alert → webhook body

const pine = readFileSync(PINE, "utf8");

/** The Pine hookMsg() function, evaluated as JS (its body is plain string concatenation). */
function pineHookMsg() {
  const m = pine.match(/^hookMsg\(string action, string qtyField\) =>\n((?: {4,}.*\n)+)/m);
  assert.ok(m, "hookMsg() not found in the Pine script");
  const expr = m[1].split("\n").map((l) => l.trim()).join(" ");
  return new Function("action", "qtyField", `return ${expr};`);
}

/** What TradingView sends: the alert message template with the Pine fragment and placeholders filled. */
function tradingViewBody(fragment, { ticker = "SPY", interval = "1", timenow = new Date().toISOString().slice(0, 19) + "Z" } = {}) {
  const template = '{"secret":"<WEBHOOK_SECRET>",{{strategy.order.alert_message}}}';
  return template
    .replace("<WEBHOOK_SECRET>", WEBHOOK_SECRET)
    .replace("{{strategy.order.alert_message}}", fragment)
    .replaceAll("{{ticker}}", ticker)
    .replaceAll("{{interval}}", interval)
    .replaceAll("{{timenow}}", timenow);
}

const hookMsg = pineHookMsg();
const buyFragment = (qty) => hookMsg("BUY", `,"qty":${qty}`);
const closeFragment = () => hookMsg("CLOSE", "");

describe("Pine alert matches the webhook contract", () => {
  it("produces the fields the Worker reads, and nothing secret", () => {
    const body = JSON.parse(tradingViewBody(buyFragment(1), { timenow: "2026-11-02T14:31:05Z" }));
    assert.deepEqual(Object.keys(body), ["secret", "id", "symbol", "timeframe", "action", "strategy", "qty", "timestamp"]);
    assert.equal(body.id, "OTE-SPY-1-2026-11-02T14:31:05Z-BUY");
    assert.match(body.id, /^[\x21-\x7E]{1,128}$/);
    assert.equal(body.action, "BUY");
    assert.equal(body.qty, 1);
    assert.deepEqual(Object.keys(JSON.parse(tradingViewBody(closeFragment()))).includes("qty"), false);
  });

  it("entries send BUY/SELL with whole-share qty, every exit sends CLOSE", () => {
    assert.match(pine, /entryMsg = hookMsg\(dir == 1 \? "BUY" : "SELL", ",\\"qty\\":" \+ str\.tostring\(math\.floor\(qty\)\)\)/);
    for (const v of ["tpMsg", "slMsg", "timeMsg"]) assert.match(pine, new RegExp(`string ${v}\\s+= hookMsg\\("CLOSE", ""\\)`));
    assert.match(pine, /strategy\.entry\(eid, [^\n]*alert_message=entryMsg\)/);
    assert.match(pine, /strategy\.exit\([^\n]*alert_profit=tpMsg, alert_loss=slMsg\)/);
    assert.match(pine, /strategy\.close_all\([^\n]*alert_message=timeMsg/);
  });

  it("the Pine source holds no webhook secret", () => {
    assert.ok(!/"secret"\s*:/.test(pine.replace(/^\s*\/\/.*$/gm, "")), "secret field outside comments");
  });
});

// ---------------------------------------------------------------- real Worker + local D1

const persist = mkdtempSync(join(tmpdir(), "alpha-pine-test-"));
const BASE = "http://127.0.0.1:8792";
let worker;

function wrangler(args) {
  return execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], {
    cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 60000,
  });
}

// Read the Worker's local D1 database file directly (read-only). `wrangler d1 execute` can stall on
// Windows while `wrangler dev` holds the same database open.
function d1(sql) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  const db = new DatabaseSync(join(dir, file), { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

async function post(body) {
  const r = await fetch(`${BASE}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(30000) });
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

before(async () => {
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  const args = ["wrangler", "dev", "--local", "--port", "8792", "--inspector-port", "9392", "--ip", "127.0.0.1", "--persist-to", persist];
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
    try {
      if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-worker.pid, "SIGTERM");
    } catch { /* gone */ }
  }
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

describe("Pine signal through the PAPER dry-run pipeline", () => {
  const validBody = tradingViewBody(buyFragment(1), { ticker: "SPY", timenow: "2026-11-02T14:31:05Z" });
  const validId = JSON.parse(validBody).id;

  it("health reports PAPER with trading disabled", async () => {
    const h = await (await fetch(`${BASE}/health`)).json();
    assert.equal(JSON.stringify(h).includes('"enable_trading":false'), true, JSON.stringify(h));
  });

  let spyBefore;
  const spyQty = (d) => (d.broker?.positions ?? []).find((p) => p.symbol === "SPY")?.qty ?? null;

  it("VALID: BUY 1 SPY → risk APPROVED → DRY_RUN_ACCEPTED, intent saved, no broker request", needsBroker, async () => {
    spyBefore = spyQty(await dashboard());
    const r = await post(validBody);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.code, "DRY_RUN_ACCEPTED");
    assert.equal(r.json.broker_request_sent, false);
    assert.equal(r.json.risk.approved, true);
    assert.equal(r.json.intent.side, "buy");
    assert.equal(r.json.intent.qty, 1);

    const [alert] = d1(`SELECT status, response_code, validation_result, strategy, action FROM alerts WHERE alert_id = '${validId}'`);
    assert.deepEqual(alert, { status: "dry_run", response_code: "DRY_RUN_ACCEPTED", validation_result: "passed", strategy: "OTE Pro Strat", action: "buy" });
    const orders = d1(`SELECT o.side, o.qty, o.alpaca_order_id FROM orders o JOIN alerts a ON a.id = o.alert_fk WHERE a.alert_id = '${validId}'`);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].alpaca_order_id, null);
    const [risk] = d1(`SELECT r.approved, r.code FROM risk_decisions r JOIN alerts a ON a.id = r.alert_fk WHERE a.alert_id = '${validId}'`);
    assert.equal(risk.code, "APPROVED");
  });

  it("DUPLICATE: same id again → DUPLICATE, still one order intent", needsBroker, async () => {
    const r = await post(validBody);
    assert.equal(r.status, 200);
    assert.equal(r.json.code, "DUPLICATE");
    assert.equal(r.json.broker_request_sent, false);
    const [{ n }] = d1(`SELECT COUNT(*) AS n FROM orders o JOIN alerts a ON a.id = o.alert_fk WHERE a.alert_id = '${validId}'`);
    assert.equal(n, 1);
    const [{ duplicate_count }] = d1(`SELECT duplicate_count FROM alerts WHERE alert_id = '${validId}'`);
    assert.equal(duplicate_count, 1);
  });

  it("REJECTED: BUY 11 SPY breaks MAX_ORDER_QTY=10 → 422 with the reason, no intent", needsBroker, async () => {
    const body = tradingViewBody(buyFragment(11), { ticker: "SPY", timenow: "2026-11-02T14:32:05Z" });
    const id = JSON.parse(body).id;
    const r = await post(body);
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, "MAX_ORDER_QTY");
    assert.equal(r.json.broker_request_sent, false);
    const [alert] = d1(`SELECT status, response_code, rejection_reason FROM alerts WHERE alert_id = '${id}'`);
    assert.equal(alert.status, "rejected");
    assert.equal(alert.response_code, "MAX_ORDER_QTY");
    assert.ok(alert.rejection_reason.length > 0);
    const [{ n }] = d1(`SELECT COUNT(*) AS n FROM orders o JOIN alerts a ON a.id = o.alert_fk WHERE a.alert_id = '${id}'`);
    assert.equal(n, 0);
  });

  it("CLOSE with no PAPER position → NO_POSITION, no intent", needsBroker, async (t) => {
    const held = new Set(((await dashboard()).broker?.positions ?? []).map((p) => p.symbol));
    const symbol = ["QQQ", "AAPL", "NVDA", "SPY"].find((s) => !held.has(s));
    if (!symbol) return t.skip("PAPER account holds every allowed symbol");
    const body = tradingViewBody(closeFragment(), { ticker: symbol, timenow: "2026-11-02T14:33:05Z" });
    const id = JSON.parse(body).id;
    const r = await post(body);
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, "NO_POSITION");
    assert.equal(r.json.broker_request_sent, false);
    const [{ n }] = d1(`SELECT COUNT(*) AS n FROM orders o JOIN alerts a ON a.id = o.alert_fk WHERE a.alert_id = '${id}'`);
    assert.equal(n, 0);
  });

  it("dashboard shows the persisted alerts, risk decisions and the one dry-run intent", needsBroker, async () => {
    const d = await dashboard();
    const alerts = d.recent.alerts;
    const accepted = alerts.find((a) => a.alert_id === validId);
    assert.equal(accepted.response_code, "DRY_RUN_ACCEPTED");
    assert.equal(accepted.strategy, "OTE Pro Strat");
    assert.equal(accepted.duplicate_count, 1);
    const rejected = alerts.find((a) => a.response_code === "MAX_ORDER_QTY");
    assert.ok(rejected?.rejection_reason, "rejection reason on the dashboard");
    assert.ok(alerts.some((a) => a.response_code === "NO_POSITION" && a.action === "close"));
    assert.ok(d.recent.risk.some((r) => r.code === "APPROVED"));
    assert.ok(d.recent.risk.some((r) => r.code === "MAX_ORDER_QTY"));
    assert.equal(d.recent.orders.length, 1);
    assert.equal(d.recent.orders[0].broker_request_sent, false);
    assert.equal(d.recent.orders[0].alpaca_order_id, null);
    // The dashboard's positions come from the PAPER broker; a dry-run intent does not change them.
    assert.equal(spyQty(d), spyBefore);
  });
});

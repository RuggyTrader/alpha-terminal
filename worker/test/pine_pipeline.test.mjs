// Pine strategy → /webhook/dry-run → validation → PAPER risk → dry-run order intent → D1 → dashboard.
//
// Runs the real Worker with `wrangler dev --local` against a throwaway D1 database. Each request body is
// the alert_message that the Pine hookMsg() builds from Pine values, inserted into the TradingView alert
// dialog message exactly as TradingView does (only {{strategy.order.alert_message}} is substituted). The webhook secret and dashboard passphrase are random values for this run only.
//
// The Worker runs WITHOUT Alpaca keys: the ALPHA PAPER risk account comes from D1 (the SOL balance is funded
// with $100 of PAPER capital first), prices from the real Kraken public ticker.
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

// ---------------------------------------------------------------- Pine alert → webhook body

const pine = readFileSync(PINE, "utf8");

const TS_LINE = `string ts = str.format_time(timenow, "yyyy-MM-dd'T'HH:mm:ss'Z'", "UTC")`;

/**
 * The Pine hookMsg() function, evaluated the way Pine evaluates it: with the bar's real
 * syminfo.ticker, timeframe.period and timenow. Its result is the order's alert_message.
 */
function pineHookMsg() {
  const m = pine.replace(/\r\n/g, "\n").match(/^hookMsg\(string action, string qtyField\) =>\n((?: {4,}.*\n)+)/m);
  assert.ok(m, "hookMsg() not found in the Pine script");
  const [tsLine, ...rest] = m[1].trimEnd().split("\n").map((l) => l.trim());
  assert.equal(tsLine, TS_LINE, "timestamp is formatted in Pine as ISO-8601 UTC");
  const fn = new Function("action", "qtyField", "ts", "syminfo", "timeframe", "alphaSupported", `return ${rest.join(" ")};`);
  // str.format_time(timenow, "yyyy-MM-dd'T'HH:mm:ss'Z'", "UTC")
  const formatTime = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";
  return (action, qtyField, bar) =>
    fn(action, qtyField, formatTime(bar.timenow), { ticker: bar.ticker }, { period: bar.period }, PINE_SUPPORTED.includes(bar.ticker));
}

// The chart symbols the Pine script sends orders for (its `bool alphaSupported = ...` line).
const supportedLine = pine.replace(/\r\n/g, "\n").match(/^bool alphaSupported = (.*)$/m);
assert.ok(supportedLine, "alphaSupported not found in the Pine script");
const PINE_SUPPORTED = [...supportedLine[1].matchAll(/syminfo\.ticker == "([^"]+)"/g)].map((m) => m[1]);
assert.equal(supportedLine[1].replace(/syminfo\.ticker == "[^"]+"/g, "X"), Array(PINE_SUPPORTED.length).fill("X").join(" or "));

/**
 * What TradingView sends: the alert dialog message with {{strategy.order.alert_message}} replaced by the
 * order's alert_message. That is the only placeholder in the dialog, and nothing else is substituted.
 */
const DIALOG_MESSAGE = '{"secret":"<WEBHOOK_SECRET>",{{strategy.order.alert_message}}}';
function tradingViewBody(alertMessage) {
  return DIALOG_MESSAGE
    .replace("<WEBHOOK_SECRET>", WEBHOOK_SECRET) // typed by the user in the dialog, not a placeholder
    .replace("{{strategy.order.alert_message}}", alertMessage);
}

const hookMsg = pineHookMsg();
// syminfo.type: "crypto" for the crypto pairs, "futures" for MES/MNQ, "cfd" for TVC:GOLD.
const bar = (ticker, isoTime, type = "crypto") => ({ ticker, type, period: "1", timenow: Date.parse(isoTime) });
// hookQty = syminfo.type == "futures" ? str.tostring(math.floor(qty))
//         : str.tostring(qty, "0.########")
const pineQty = (qty, type) =>
  type === "futures" ? String(Math.floor(qty)) : qty.toFixed(8).replace(/\.?0+$/, "");
const buyAlert = (qty, b) => hookMsg("BUY", `,"qty":${pineQty(qty, b.type)}`, b);
const closeAlert = (b) => hookMsg("CLOSE", "", b);

describe("Pine alert matches the webhook contract", () => {
  it("produces the fields the Worker reads, and nothing secret", () => {
    const body = JSON.parse(tradingViewBody(buyAlert(0.5, bar("SOLUSD", "2026-11-02T14:31:05Z"))));
    assert.deepEqual(Object.keys(body), ["secret", "id", "symbol", "timeframe", "action", "strategy", "qty", "timestamp"]);
    assert.equal(body.id, "OTE-SOLUSD-1-2026-11-02T14:31:05Z-BUY");
    assert.match(body.id, /^[!-~]{1,128}$/);
    assert.equal(body.symbol, "SOLUSD");
    assert.equal(body.timeframe, "1");
    assert.equal(body.action, "BUY");
    assert.equal(body.qty, 0.5);
    assert.equal(body.timestamp, "2026-11-02T14:31:05Z");
    assert.equal("qty" in JSON.parse(tradingViewBody(closeAlert(bar("SOLUSD", "2026-11-02T14:31:05Z")))), false);
  });

  it("crypto qty keeps 8 decimals; futures send whole contracts", () => {
    const t = "2026-11-02T14:31:05Z";
    assert.equal(JSON.parse(tradingViewBody(buyAlert(0.0347123446, bar("BTCUSD", t)))).qty, 0.03471234);
    assert.equal(JSON.parse(tradingViewBody(buyAlert(4123.98, bar("KAITOUSD", t)))).qty, 4123.98);
    const mes = JSON.parse(tradingViewBody(buyAlert(3.9, bar("MES1!", t, "futures"))));
    assert.equal(mes.qty, 3);
    assert.equal(mes.symbol, "MES1!");
  });

  it("alert_message holds no ordinary TradingView placeholders (they are not expanded inside it)", () => {
    for (const msg of [buyAlert(1, bar("BTCUSD", "2026-11-02T14:31:05Z")), closeAlert(bar("MES1!", "2026-11-02T14:31:05Z", "futures"))]) {
      for (const ph of ["{{ticker}}", "{{interval}}", "{{timenow}}"]) assert.ok(!msg.includes(ph), `${ph} in alert_message`);
      assert.ok(!msg.includes("{{"), `placeholder in alert_message: ${msg}`);
    }
    const code = pine.replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!code.includes("{{"), "the Pine code (outside comments) contains a TradingView placeholder");
    assert.deepEqual(DIALOG_MESSAGE.match(/\{\{[^}]*\}\}/g), ["{{strategy.order.alert_message}}"]);
    assert.ok(!tradingViewBody(closeAlert(bar("ETHUSD", "2026-11-02T14:31:05Z"))).includes("{{"));
  });

  it("entries send BUY/SELL with the instrument's qty format, every exit sends CLOSE", () => {
    assert.ok(pine.includes('string hookQty = syminfo.type == "futures" ? str.tostring(math.floor(qty)) : str.tostring(qty, "0.########")'));
    assert.ok(pine.includes('string entryMsg = hookMsg(dir == 1 ? "BUY" : "SELL", ",\\"qty\\":" + hookQty)'));
    for (const v of ["tpMsg", "slMsg", "timeMsg"]) assert.match(pine, new RegExp(`string ${v}\\s+= hookMsg\\("CLOSE", ""\\)`));
    assert.match(pine, /strategy\.entry\(eid, [^\n]*alert_message=entryMsg\)/);
    assert.match(pine, /strategy\.exit\([^\n]*alert_profit=tpMsg, alert_loss=slMsg\)/);
    assert.match(pine, /strategy\.close_all\([^\n]*alert_message=timeMsg/);
  });

  it("Pine sends orders only for the same 8 chart symbols the Worker accepts", () => {
    const backend = [...readFileSync(join(WORKER_DIR, "src", "instruments.ts"), "utf8").matchAll(/\["([^"]+)", "[A-Z]+"\],/g)].map((m) => m[1]);
    assert.deepEqual(PINE_SUPPORTED, ["MNQ1!", "MES1!", "GOLD", "BTCUSD", "ETHUSD", "SOLUSD", "HYPEUSD", "KAITOUSD"]);
    assert.deepEqual(backend, PINE_SUPPORTED);
    assert.ok(pine.includes('string status = not alphaSupported ? "UNSUPPORTED SYMBOL (no ALPHA TERMINAL orders)"'));
  });

  it("on an unsupported chart Pine emits no order: no id, symbol, action or qty", () => {
    const t = "2026-11-02T14:31:05Z";
    for (const ticker of ["SPY", "QQQ", "AAPL", "NVDA", "DOGEUSD", "BTCUSDT", "ES1!", "MES2!"]) {
      for (const msg of [buyAlert(1, bar(ticker, t, "stock")), closeAlert(bar(ticker, t, "stock")), hookMsg("SELL", ',"qty":1', bar(ticker, t))]) {
        const body = JSON.parse(tradingViewBody(msg));
        assert.deepEqual(Object.keys(body), ["secret", "alpha_terminal", "chart"], ticker);
        assert.equal(body.alpha_terminal, "UNSUPPORTED_SYMBOL");
        assert.equal(body.chart, ticker);
      }
    }
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
  // ALPACA_KEY / ALPACA_SECRET blank: overrides any keys in worker/.dev.vars.
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, ALPACA_KEY: "", ALPACA_SECRET: "" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 60000;
  let up = false;
  while (!up && Date.now() < end) {
    try { up = (await fetch(`${BASE}/health`)).status === 200; } catch { /* starting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error("Worker did not start");
  await dashboard(); // signs in
  for (const [kind, body] of [["fund", { action: "deposit", amount_usd: 100 }], ["transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 100 }]]) {
    const r = await fetch(`${BASE}/api/paper/${kind}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
      body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }),
    });
    assert.equal(r.status, 200);
  }
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
  // SOLUSD: priced from Kraken; balance and positions from the ALPHA PAPER ledger in D1.
  const validBody = tradingViewBody(buyAlert(0.5, bar("SOLUSD", "2026-11-02T14:31:05Z")));
  const validId = JSON.parse(validBody).id;
  const ordersFor = (id) => d1(`SELECT COUNT(*) AS n FROM orders o JOIN alerts a ON a.id = o.alert_fk WHERE a.alert_id = '${id}'`)[0].n;

  it("health reports PAPER with trading disabled", async () => {
    const h = await (await fetch(`${BASE}/health`)).json();
    assert.equal(JSON.stringify(h).includes('"enable_trading":false'), true, JSON.stringify(h));
    assert.equal(h.alpaca_configured, false);
  });

  let solBefore;
  const solQty = (d) => (d.broker?.positions ?? []).find((p) => p.symbol === "SOLUSD")?.qty ?? null;

  it("VALID: BUY 0.5 SOLUSD → risk APPROVED (Kraken price) → DRY_RUN_ACCEPTED, intent saved, no broker request", async () => {
    solBefore = solQty(await dashboard());
    const r = await post(validBody);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.code, "DRY_RUN_ACCEPTED");
    assert.equal(r.json.broker_request_sent, false);
    assert.equal(r.json.risk.approved, true);
    assert.ok(r.json.risk.referencePrice > 0);
    assert.equal(r.json.risk.estimatedNotional, Math.round(0.5 * r.json.risk.referencePrice * 100) / 100);
    assert.equal(r.json.intent.symbol, "SOLUSD");
    assert.equal(r.json.intent.side, "buy");
    assert.equal(r.json.intent.qty, 0.5);

    const [alert] = d1(`SELECT status, response_code, validation_result, strategy, action FROM alerts WHERE alert_id = '${validId}'`);
    assert.deepEqual(alert, { status: "dry_run", response_code: "DRY_RUN_ACCEPTED", validation_result: "passed", strategy: "OTE Pro Strat", action: "buy" });
    const orders = d1(`SELECT o.symbol, o.side, o.qty, o.alpaca_order_id FROM orders o JOIN alerts a ON a.id = o.alert_fk WHERE a.alert_id = '${validId}'`);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].symbol, "SOLUSD");
    assert.equal(orders[0].alpaca_order_id, null);
    const [risk] = d1(`SELECT r.approved, r.code FROM risk_decisions r JOIN alerts a ON a.id = r.alert_fk WHERE a.alert_id = '${validId}'`);
    assert.equal(risk.code, "APPROVED");
  });

  it("DUPLICATE: same id again → DUPLICATE, still one order intent", async () => {
    const r = await post(validBody);
    assert.equal(r.status, 200);
    assert.equal(r.json.code, "DUPLICATE");
    assert.equal(r.json.broker_request_sent, false);
    assert.equal(ordersFor(validId), 1);
    const [{ duplicate_count }] = d1(`SELECT duplicate_count FROM alerts WHERE alert_id = '${validId}'`);
    assert.equal(duplicate_count, 1);
  });

  it("REJECTED: BUY 1 BTCUSD breaks MAX_ORDER_NOTIONAL=$5,000 → 422 with the reason, no intent", async () => {
    const body = tradingViewBody(buyAlert(1, bar("BTCUSD", "2026-11-02T14:32:05Z")));
    const id = JSON.parse(body).id;
    const r = await post(body);
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, "MAX_ORDER_NOTIONAL");
    assert.equal(r.json.broker_request_sent, false);
    const [alert] = d1(`SELECT status, response_code, rejection_reason FROM alerts WHERE alert_id = '${id}'`);
    assert.equal(alert.status, "rejected");
    assert.equal(alert.response_code, "MAX_ORDER_NOTIONAL");
    assert.match(alert.rejection_reason, /above the limit \$5000/);
    assert.equal(ordersFor(id), 0);
  });

  it("CLOSE KAITOUSD with no ALPHA PAPER position → NO_POSITION, no intent", async () => {
    const body = tradingViewBody(closeAlert(bar("KAITOUSD", "2026-11-02T14:33:05Z")));
    const id = JSON.parse(body).id;
    const r = await post(body);
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, "NO_POSITION");
    assert.match(r.json.message, /no open ALPHA PAPER position in KAITOUSD to close/);
    assert.equal(r.json.broker_request_sent, false);
    assert.equal(ordersFor(id), 0);
  });

  it("MES1!, MNQ1! and GOLD BUY → MARKET_DATA_UNAVAILABLE with the reason; no price is invented", async () => {
    for (const [ticker, type, sym, why] of [["MES1!", "futures", "MES", /licensed CME/], ["MNQ1!", "futures", "MNQ", /licensed CME/], ["GOLD", "cfd", "GOLD", /Gold\.com, Inc\. stock, not gold/]]) {
      const body = tradingViewBody(buyAlert(1, bar(ticker, "2026-11-02T14:34:05Z", type)));
      const r = await post(body);
      assert.equal(r.status, 422, JSON.stringify(r.json));
      assert.equal(r.json.code, "MARKET_DATA_UNAVAILABLE");
      assert.match(r.json.message, why);
      assert.equal(r.json.risk.referencePrice, null);
      assert.equal(r.json.risk.estimatedNotional, null);
      assert.equal(r.json.broker_request_sent, false);
      assert.equal(ordersFor(JSON.parse(body).id), 0);
      const [alert] = d1(`SELECT symbol FROM alerts WHERE alert_id = '${JSON.parse(body).id}'`);
      assert.equal(alert.symbol, sym);
    }
  });

  it("unsupported chart: the Pine message is rejected and nothing is recorded", async () => {
    const before = d1(`SELECT COUNT(*) AS n FROM alerts`)[0].n;
    for (const ticker of ["SPY", "DOGEUSD", "ES1!"]) {
      const r = await post(tradingViewBody(buyAlert(1, bar(ticker, "2026-11-02T14:35:05Z", "stock"))));
      assert.equal(r.status, 400);
      assert.equal(r.json.code, "INVALID_ALERT_ID");
      assert.equal(r.json.broker_request_sent, false);
    }
    assert.equal(d1(`SELECT COUNT(*) AS n FROM alerts`)[0].n, before);
  });

  it("Pine bypassed: the Worker itself rejects every other symbol as INVALID_SYMBOL", async () => {
    let i = 0;
    for (const symbol of ["SPY", "QQQ", "AAPL", "NVDA", "DOGEUSD", "XRPUSD", "BTCUSDT", "ES1!", "GC1!", "MES2!", "MESZ2026", "MES", "KRAKEN:SOLUSD", "SOL/USD", "btcusd"]) {
      const r = await post(JSON.stringify({ secret: WEBHOOK_SECRET, id: `bypass-${++i}`, symbol, action: "BUY", qty: 1, strategy: "OTE Pro Strat" }));
      assert.equal(r.status, 400, symbol);
      assert.equal(r.json.code, "INVALID_SYMBOL", symbol);
      assert.equal(d1(`SELECT COUNT(*) AS n FROM orders o JOIN alerts a ON a.id = o.alert_fk WHERE a.alert_id = 'bypass-${i}'`)[0].n, 0);
    }
  });

  it("validation: fractional futures are INVALID_QUANTITY", async () => {
    const frac = JSON.parse(tradingViewBody(buyAlert(1, bar("MNQ1!", "2026-11-02T14:36:05Z", "futures"))));
    frac.qty = 1.5;
    const r = await post(JSON.stringify(frac));
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "INVALID_QUANTITY");
  });

  it("dashboard shows the persisted alerts, risk decisions and the one dry-run intent", async () => {
    const d = await dashboard();
    const alerts = d.recent.alerts;
    const accepted = alerts.find((a) => a.alert_id === validId);
    assert.equal(accepted.response_code, "DRY_RUN_ACCEPTED");
    assert.equal(accepted.symbol, "SOLUSD");
    assert.equal(accepted.strategy, "OTE Pro Strat");
    assert.equal(accepted.duplicate_count, 1);
    assert.ok(alerts.find((a) => a.response_code === "MAX_ORDER_NOTIONAL")?.rejection_reason);
    assert.ok(alerts.some((a) => a.response_code === "NO_POSITION" && a.action === "close" && a.symbol === "KAITOUSD"));
    assert.ok(alerts.some((a) => a.response_code === "MARKET_DATA_UNAVAILABLE" && a.symbol === "MES"));
    assert.ok(d.recent.risk.some((r) => r.code === "APPROVED"));
    assert.ok(d.recent.risk.some((r) => r.code === "MAX_ORDER_NOTIONAL"));
    assert.equal(d.recent.orders.length, 1);
    assert.equal(d.recent.orders[0].broker_request_sent, false);
    assert.equal(d.recent.orders[0].alpaca_order_id, null);
    // Broker positions (optional Alpaca, not configured here) are never changed by a dry-run intent.
    assert.equal(solQty(d), solBefore);
  });
});

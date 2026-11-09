// ALPHA PAPER execution costs end to end: simulated exchange fees, slippage, minimum orders and fee-inclusive capital
// checks on the real Worker (`wrangler dev --local`) against a throwaway D1. Isolated: port 8801, its own persist dir.
//
// Prices are real Kraken SOLUSD 5-minute closes from the engine's committed fixture (engine/test/fixtures), served by a
// local stand-in for Kraken's public Ticker API on 127.0.0.1. The same D1 is used through three Worker runs:
//   1. PAPER_COST_PROFILE=ndax           (0.20% maker and taker, 0.10% taker slippage, $5 minimum)
//   2. PAPER_COST_PROFILE=kraken_pro_t1  (restart on the same state: 0.40% maker, 0.80% taker, 0.03% slippage, 0.05 SOL)
//   3. PAPER_COST_PROFILE=bogus          (restart: every fill refused)
// No broker order is ever sent.

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

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(HERE, "..");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret();
const DASHBOARD_PASSPHRASE = secret();
const ADMIN_SECRET = secret();
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;

// Real Kraken SOLUSD 5m closes (fixture candles 200 and 260).
const CANDLES = JSON.parse(readFileSync(join(WORKER_DIR, "..", "engine", "test", "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;
const P_ENTRY = CANDLES[200].c; // 95.25
const P_EXIT = CANDLES[260].c; // 94.33
assert.equal(P_ENTRY, 95.25);
assert.equal(P_EXIT, 94.33);

// ---------------------------------------------------------------- Kraken Ticker stand-in (127.0.0.1)

const market = { SOLUSD: P_ENTRY };
const fixture = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "GET" || url.pathname !== "/0/public/Ticker") { res.writeHead(404).end(); return; }
  const result = {};
  for (const pair of (url.searchParams.get("pair") ?? "").split(",")) if (market[pair]) result[pair] = { c: [String(market[pair]), "1.0"] };
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result }));
});

// ---------------------------------------------------------------- Worker + D1 helpers

const persist = mkdtempSync(join(tmpdir(), "alpha-costs-test-"));
let worker = null;
let krakenBase = "";

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

async function start(profile) {
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", "9801", "--ip", "127.0.0.1", "--persist-to", persist];
  const vars = { WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: krakenBase, PAPER_MARK_MIN_INTERVAL_SECONDS: "0", ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: profile };
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 60000;
  let up = false;
  while (!up && Date.now() < end) {
    try { up = (await fetch(`${BASE}/health`)).status === 200; } catch { /* starting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error("Worker did not start");
  cookie = null;
}

async function stop() {
  if (worker && worker.exitCode === null) {
    try {
      if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-worker.pid, "SIGTERM");
    } catch { /* gone */ }
  }
  worker = null;
  // Wait until the port is free again.
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) }); } catch { return; }
    await new Promise((r) => setTimeout(r, 300));
  }
}

let n = 0;
const signal = (action, qty, extra = {}) => ({
  secret: WEBHOOK_SECRET, id: `COST-SOLUSD-${action}-${++n}`, symbol: "SOLUSD", timeframe: "5",
  action, strategy: "OTE Pro Strat (engine)", ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString(), ...extra,
});
async function post(body) {
  const r = await fetch(`${BASE}/webhook/dry-run`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  return { status: r.status, json: await r.json() };
}

let cookie = null;
async function api(path) {
  if (!cookie) {
    const r = await fetch(`${BASE}/auth/login`, {
      method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }), signal: AbortSignal.timeout(30000),
    });
    assert.equal(r.status, 200);
    cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  }
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" }, signal: AbortSignal.timeout(30000) });
  assert.equal(r.status, 200, path);
  const j = await r.json();
  return j.data ?? j;
}
const dashboard = () => api("/api/dashboard");

async function paperAction(kind, body) {
  await dashboard(); // signs in
  const r = await fetch(`${BASE}/api/paper/${kind}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
    body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }),
  });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
}

const near = (a, b, tol = 1e-6, msg = "") => assert.ok(Math.abs(Number(a) - b) <= tol, `${msg} ${a} != ${b}`);
const microNear = (a, b, msg = "") => assert.ok(Math.abs(Number(a) - b) <= 1, `${msg} ${a} != ${b} (micro-USD)`);
const wallet = () => d1(`SELECT available_micro, reserved_micro, realized_pnl_micro, net_funding_micro, fees_micro FROM portfolio_wallets WHERE wallet = 'SOLUSD'`)[0];
const feeEntries = () => d1(`SELECT entry_key, available_change_micro, reserved_change_micro, ref, note FROM portfolio_entries WHERE kind = 'FEE' ORDER BY id`);
const fills = () => d1(`SELECT * FROM paper_fills ORDER BY id`);
const ledgerSnapshot = () => ({ wallet: wallet(), fees: feeEntries().length, fills: fills().length, entries: d1(`SELECT COUNT(*) AS n FROM portfolio_entries`)[0].n });

// The identity every read must satisfy: available + reserved = funding + realized - fees, and no negative balance.
function assertIdentity() {
  const w = wallet();
  assert.equal(w.available_micro + w.reserved_micro, w.net_funding_micro + w.realized_pnl_micro - w.fees_micro, JSON.stringify(w));
  assert.ok(w.available_micro >= 0 && w.reserved_micro >= 0);
  const sum = d1(`SELECT COALESCE(SUM(available_change_micro), 0) AS a FROM portfolio_entries WHERE wallet = 'SOLUSD'`)[0].a;
  assert.equal(sum, w.available_micro, "the entry history equals the balance");
  const fee = d1(`SELECT COALESCE(-SUM(available_change_micro), 0) AS f FROM portfolio_entries WHERE wallet = 'SOLUSD' AND kind = 'FEE'`)[0].f;
  assert.equal(fee, w.fees_micro, "FEE entries equal the wallet's fees");
}

before(async () => {
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  krakenBase = `http://127.0.0.1:${fixture.address().port}`;
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  await start("ndax");
  await paperAction("fund", { action: "deposit", amount_usd: 200 });
  await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 100 });
});

after(async () => {
  await stop();
  fixture.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

// ---------------------------------------------------------------- 1. Ndax

describe("Ndax profile (0.20% / 0.20%, 0.10% taker slippage, $5 minimum)", () => {
  let buyBody;

  it("schema 4 is applied and the dashboard reports the profile with its Ndax caveat", async () => {
    assert.equal(d1(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0].value, "4");
    const c = (await dashboard()).portfolio.costs;
    assert.deepEqual([c.profile, c.maker_pct, c.taker_pct, c.taker_slippage_pct, c.min_notional_usd], ["ndax", 0.2, 0.2, 0.1, 5]);
    assert.match(c.caveat, /not verified Ndax SOL\/CAD executions/);
    assert.match(c.slippage_source, /ESTIMATE/);
    assert.match(c.fill_disclosure, /Kraken reference price when the signal is processed/);
    assert.match(c.fill_disclosure, /not verified against a live exchange order book/);
  });

  it("BUY 0.5 maker at 95.25: executes at the reference, pays 0.20% ($0.09525) as a FEE entry", async () => {
    market.SOLUSD = P_ENTRY;
    buyBody = signal("BUY", 0.5, { liquidity: "maker" });
    const r = await post(buyBody);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.code, "DRY_RUN_ACCEPTED");
    assert.equal(r.json.broker_request_sent, false);
    const [f] = fills();
    assert.deepEqual([f.side, f.liquidity, f.cost_profile, f.price, f.reference_price, f.slippage_micro], ["buy", "MAKER", "ndax", 95.25, 95.25, 0]);
    microNear(f.fee_micro, 95250, "entry fee");
    const fe = feeEntries();
    assert.equal(fe.length, 1);
    assert.equal(fe[0].entry_key, `FEE:${f.client_order_id}`);
    microNear(fe[0].available_change_micro, -95250);
    assert.equal(fe[0].reserved_change_micro, 0);
    const w = wallet();
    microNear(w.reserved_micro, 47625000, "reserved = 0.5 x 95.25");
    microNear(w.available_micro, 100e6 - 47625000 - 95250, "available = 100 - value - fee");
    microNear(w.fees_micro, 95250);
    assertIdentity();
  });

  it("the same signal again is a duplicate: no second fill, no second fee", async () => {
    const before = ledgerSnapshot();
    const r = await post(buyBody);
    assert.equal(r.json.code, "DUPLICATE", JSON.stringify(r.json));
    assert.deepEqual(ledgerSnapshot(), before);
  });

  it("an invalid liquidity hint is refused", async () => {
    const before = ledgerSnapshot();
    const r = await post(signal("BUY", 0.1, { liquidity: "rebate" }));
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.code, "INVALID_LIQUIDITY");
    assert.deepEqual(ledgerSnapshot(), before);
  });

  it("a BUY below the $5 minimum is refused (BELOW_MIN_ORDER), nothing filled", async () => {
    const before = ledgerSnapshot();
    const r = await post(signal("BUY", 0.04, { liquidity: "maker" })); // $3.81
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, "BELOW_MIN_ORDER");
    assert.match(r.json.message, /below the Ndax \(0\.20% flat\) minimum of \$5/);
    assert.deepEqual(ledgerSnapshot(), before);
  });

  it("the capital check includes the fee: a BUY whose value fits but value + fee does not is refused", async () => {
    const before = ledgerSnapshot();
    const avail = before.wallet.available_micro / 1e6; // 52.27975
    const qty = 0.548; // value 52.197 <= 52.27975, value + fee 52.301394 > 52.27975
    assert.ok(qty * P_ENTRY <= avail && qty * P_ENTRY * 1.002 > avail);
    const r = await post(signal("BUY", qty, { liquidity: "maker" }));
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, "INSUFFICIENT_PAPER_CAPITAL");
    assert.match(r.json.message, /simulated fee/);
    assert.deepEqual(ledgerSnapshot(), before);
  });

  it("CLOSE taker at 94.33: executes 0.10% worse (94.23567), pays 0.20% on the proceeds; trade records gross, fees, slippage, net", async () => {
    market.SOLUSD = P_EXIT;
    const r = await post(signal("CLOSE")); // no hint: taker
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const f = fills()[1];
    assert.deepEqual([f.side, f.kind, f.liquidity, f.reference_price], ["sell", "CLOSE", "TAKER", 94.33]);
    near(f.price, 94.23567, 1e-8, "execution price");
    microNear(f.fee_micro, 94236, "exit fee 0.2% x 47.117835");
    microNear(f.slippage_micro, 47165, "slippage 0.5 x 0.09433");
    const [t] = d1(`SELECT * FROM trades WHERE source = 'ALPHA_PAPER'`);
    near(t.gross_pnl, -0.46, 1e-6, "gross = (94.33 - 95.25) x 0.5");
    near(t.slippage_usd, 0.047165, 1e-6);
    near(t.fees_usd, 0.189486, 1e-6);
    near(t.realized_pnl, -0.696651, 1e-6, "net = gross - slippage - fees");
    assert.equal(t.cost_profile, "ndax");
    const w = wallet();
    assert.equal(w.reserved_micro, 0);
    microNear(w.available_micro, 100e6 - 696651, "the coin balance moved by the NET result");
    microNear(w.realized_pnl_micro, -507165, "realized at execution prices");
    microNear(w.fees_micro, 189486);
    assert.equal(feeEntries().length, 2);
    assertIdentity();
  });

  it("dashboard, verified performance and trade proof show the same numbers, and the books balance", async () => {
    const d = await dashboard();
    assert.equal(d.portfolio.consistency.ok, true, JSON.stringify(d.portfolio.consistency.issues));
    const sw = d.portfolio.wallets.find((w) => w.wallet === "SOLUSD");
    near(sw.fees_usd, 0.189486);
    near(sw.net_realized_pnl_usd, -0.696651);
    near(d.paper.performance.fees_usd, 0.189486);
    near(d.paper.performance.realized_pnl, -0.696651);
    assert.ok(d.portfolio.history.some((e) => e.kind === "FEE"));
    const perf = await api("/api/dashboard/performance");
    const vt = perf.trades.at(-1);
    assert.deepEqual([vt.cost_profile, vt.gross_pnl, vt.fees_usd, vt.slippage_usd], ["ndax", -0.46, 0.189486, 0.047165]);
    near(vt.realized_pnl, -0.696651);
    const proof = await api(`/api/dashboard/trade-proof?id=${vt.id}`);
    assert.equal(proof.verified, true);
    assert.deepEqual(proof.fills.map((x) => [x.liquidity, x.reference_price, x.cost_profile]), [["MAKER", 95.25, "ndax"], ["TAKER", 94.33, "ndax"]]);
    // net recomputed from the fills, as the dashboard does: sells - buys - fees.
    const net = proof.fills.reduce((s, x) => s + (x.side === "sell" ? 1 : -1) * x.qty * x.price - x.fee_micro / 1e6, 0);
    near(net, Number(proof.trade.realized_pnl), 1e-6);
  });

  it("a CLOSE below the minimum is never blocked (no trapped position)", async () => {
    market.SOLUSD = P_ENTRY;
    const r1 = await post(signal("BUY", 0.0525, { liquidity: "maker" })); // $5.0006
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    market.SOLUSD = P_EXIT;
    const r2 = await post(signal("CLOSE", undefined, { liquidity: "maker" })); // $4.95 < $5
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    const f = fills().at(-1);
    assert.deepEqual([f.kind, f.liquidity, f.price, f.slippage_micro], ["CLOSE", "MAKER", 94.33, 0]);
    assertIdentity();
  });
});

// ---------------------------------------------------------------- 2. Restart with Kraken Pro Tier 1

describe("restart on the same D1 with Kraken Pro Tier 1 (0.40% / 0.80%, 0.03% slippage, 0.05 SOL minimum)", () => {
  let before;

  it("a restart keeps every balance, fee and fill; old fills keep their Ndax costs", async () => {
    before = ledgerSnapshot();
    const feesBefore = (await dashboard()).portfolio.totals.fees_usd;
    await stop();
    await start("kraken_pro_t1");
    assert.deepEqual(ledgerSnapshot(), before);
    const d = await dashboard();
    assert.equal(d.portfolio.totals.fees_usd, feesBefore);
    assert.equal(d.portfolio.costs.profile, "kraken_pro_t1");
    assert.equal(d.portfolio.consistency.ok, true);
    assert.ok(fills().every((f) => f.cost_profile === "ndax"), "no retroactive change");
  });

  it("a signal replayed after the restart is still a duplicate (no double fee)", async () => {
    const id = d1(`SELECT alert_id FROM paper_fills ORDER BY id LIMIT 1`)[0].alert_id;
    const r = await post({ ...signal("BUY", 0.5, { liquidity: "maker" }), id });
    assert.equal(r.json.code, "DUPLICATE");
    assert.deepEqual(ledgerSnapshot(), before);
  });

  it("a BUY below 0.05 SOL is refused", async () => {
    market.SOLUSD = P_ENTRY;
    const r = await post(signal("BUY", 0.04, { liquidity: "maker" }));
    assert.equal(r.json.code, "BELOW_MIN_ORDER", JSON.stringify(r.json));
    assert.deepEqual(ledgerSnapshot(), before);
  });

  it("BUY 0.1 taker: pays 0.03% slippage and the 0.80% taker fee; partial SELL below the minimum refused; maker CLOSE pays 0.40%", async () => {
    market.SOLUSD = P_ENTRY;
    const r = await post(signal("BUY", 0.1)); // no hint: taker
    assert.equal(r.status, 200, JSON.stringify(r.json));
    let f = fills().at(-1);
    near(f.price, 95.278575, 1e-8);
    microNear(f.fee_micro, 76223, "0.8% x 9.5278575");
    microNear(f.slippage_micro, 2858, "0.1 x 0.028575");
    const partial = await post(signal("SELL", 0.04, { liquidity: "maker" }));
    assert.equal(partial.json.code, "BELOW_MIN_ORDER", JSON.stringify(partial.json));
    market.SOLUSD = 96;
    const c = await post(signal("CLOSE", undefined, { liquidity: "maker" }));
    assert.equal(c.status, 200, JSON.stringify(c.json));
    f = fills().at(-1);
    assert.deepEqual([f.liquidity, f.price, f.cost_profile], ["MAKER", 96, "kraken_pro_t1"]);
    microNear(f.fee_micro, 38400, "0.4% x 9.6");
    const t = d1(`SELECT * FROM trades ORDER BY id DESC LIMIT 1`)[0];
    near(t.gross_pnl, 0.075, 1e-6, "(96 - 95.25) x 0.1");
    near(t.slippage_usd, 0.0028575, 2e-6);
    near(t.fees_usd, 0.114623, 2e-6);
    near(t.realized_pnl, 0.075 - 0.0028575 - 0.114623, 3e-6, "a gross winner that is a net loser");
    assert.ok(Number(t.realized_pnl) < 0);
    assertIdentity();
    assert.equal((await dashboard()).portfolio.consistency.ok, true);
  });
});

// ---------------------------------------------------------------- 3. Invalid profile

describe("an unknown cost profile refuses every fill", () => {
  it("BUY is refused with COST_PROFILE_INVALID and nothing changes", async () => {
    await stop();
    await start("bogus");
    const before = ledgerSnapshot();
    market.SOLUSD = P_ENTRY;
    const r = await post(signal("BUY", 0.1, { liquidity: "maker" }));
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, "COST_PROFILE_INVALID");
    assert.deepEqual(ledgerSnapshot(), before);
    const c = (await dashboard()).portfolio.costs;
    assert.deepEqual([c.profile, c.invalid], ["bogus", true]);
    assertIdentity();
  });
});

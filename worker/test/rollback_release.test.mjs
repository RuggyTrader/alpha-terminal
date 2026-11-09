// Rollback rehearsal for the fee-compatible rollback Worker (branch rollback/worker-fee-compat) on real local Workers
// and throwaway D1s. Three code versions are rebuilt from git with `git show` (this checkout is not touched):
//   PROD     cde07af  the Worker in production today (schema 3, no costs)
//   DEV      this checkout's worker/ (PAPER execution costs, Ndax profile)
//   ROLLBACK rollback/worker-fee-compat (cde07af + fee compatibility; charges no fees)
// Sequence: PROD data on schema 3 → migration 0004 (interrupted rollout: PROD keeps running) → DEV charges fees →
// ROLLBACK (no warnings, no lost or new fees, duplicates, restart, partial exit, positions opened before) →
// DEV again. Plus ROLLBACK on an unmigrated schema-3 database (rollout interrupted before the migration).
//   node --test test/rollback_release.test.mjs        (ROLLBACK_REF=<commit> to test another build)

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_DIR = join(HERE, "..");
const REPO = join(DEV_DIR, "..");
const PROD_REF = "cde07af";
const ROLLBACK_REF = process.env.ROLLBACK_REF ?? "1694c1f"; // rollback/worker-fee-compat
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const PORT = 8803;
const BASE = `http://127.0.0.1:${PORT}`;

const CANDLES = JSON.parse(readFileSync(join(REPO, "engine", "test", "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;
const P1 = CANDLES[200].c; // 95.25
const P2 = CANDLES[260].c; // 94.33
const market = { SOLUSD: P1 };
const fixture = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "GET" || url.pathname !== "/0/public/Ticker") { res.writeHead(404).end(); return; }
  const result = {};
  for (const pair of (url.searchParams.get("pair") ?? "").split(",")) if (market[pair]) result[pair] = { c: [String(market[pair]), "1.0"] };
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result }));
});

// ---------------------------------------------------------------- code versions from git

const work = mkdtempSync(join(tmpdir(), "alpha-rollback-"));
const link = (target, path) => (WIN ? execFileSync("cmd", ["/c", "mklink", "/J", path, target], { stdio: "ignore" }) : execFileSync("ln", ["-s", target, path]));
function extract(ref, name) {
  const root = join(work, name);
  const files = execFileSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", ref, "worker"], { encoding: "utf8" }).trim().split("\n");
  for (const f of files) {
    if (f.startsWith("worker/test/")) continue;
    const dest = join(root, f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, execFileSync("git", ["-C", REPO, "show", `${ref}:${f}`], { maxBuffer: 64 * 1024 * 1024 }));
  }
  link(join(DEV_DIR, "node_modules"), join(root, "worker", "node_modules"));
  link(join(REPO, "frontend"), join(root, "frontend")); // static assets only; the API under test does not use them
  return join(root, "worker");
}
let PROD_DIR, ROLLBACK_DIR;

function wrangler(dir, args) {
  return execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
}
let persist = join(work, "d1");
function sqliteFile(root = persist) {
  const dir = join(root, "v3", "d1", "miniflare-D1DatabaseObject");
  return join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite"));
}
function d1(sql, root = persist) {
  // Throwaway database, read-only queries (read-write open: a read-only open fails on Windows right after a kill).
  for (let attempt = 0; ; attempt++) {
    try {
      const db = new DatabaseSync(sqliteFile(root));
      try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); }
    } catch (e) {
      if (attempt >= 20 || !/disk I\/O|locked|busy/i.test(String(e.message))) throw e;
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 250)"]);
    }
  }
}

let worker = null, cookie = null;
async function start(dir, profile) {
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", "9803", "--ip", "127.0.0.1", "--persist-to", persist];
  const vars = { WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: `http://127.0.0.1:${fixture.address().port}`, PAPER_MARK_MIN_INTERVAL_SECONDS: "0", ALPACA_KEY: "", ALPACA_SECRET: "", ...(profile ? { PAPER_COST_PROFILE: profile } : {}) };
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: dir, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 90000;
  let up = false;
  while (!up && Date.now() < end) {
    try { up = (await fetch(`${BASE}/health`)).status === 200; } catch { /* starting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`Worker in ${dir} did not start`);
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
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) }); } catch { return; }
    await new Promise((r) => setTimeout(r, 300));
  }
}

let n = 0;
const signal = (action, qty, extra = {}) => ({
  secret: WEBHOOK_SECRET, id: `RB-SOLUSD-${action}-${++n}`, symbol: "SOLUSD", timeframe: "5",
  action, strategy: "OTE Pro Strat (engine)", ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString(), ...extra,
});
async function post(body) {
  const r = await fetch(`${BASE}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return { status: r.status, json: await r.json() };
}
async function api(path) {
  if (!cookie) {
    const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
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
  await dashboard();
  const r = await fetch(`${BASE}/api/paper/${kind}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
    body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }),
  });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
}
const ok = async (body) => { const r = await post(body); assert.equal(r.status, 200, JSON.stringify(r.json)); return r; };

const sum = (sql) => Number(d1(sql)[0].v ?? 0);
const wallet = () => d1(`SELECT * FROM portfolio_wallets WHERE wallet = 'SOLUSD'`)[0];
const feeRows = () => d1(`SELECT id, entry_key, available_change_micro FROM portfolio_entries WHERE kind = 'FEE' ORDER BY id`);
/** Fee-aware ledger identities from raw rows (independent of any Worker's own check). */
function invariants() {
  const out = [];
  const hasFees = d1(`SELECT COUNT(*) AS v FROM pragma_table_info('portfolio_wallets') WHERE name = 'fees_micro'`)[0].v === 1;
  for (const w of d1(`SELECT * FROM portfolio_wallets`)) {
    const fees = hasFees ? Number(w.fees_micro) : 0;
    if (w.available_micro < 0 || w.reserved_micro < 0) out.push(`${w.wallet}: negative balance`);
    if (w.available_micro + w.reserved_micro !== w.net_funding_micro + w.realized_pnl_micro - fees) out.push(`${w.wallet}: identity`);
    if (sum(`SELECT SUM(available_change_micro) AS v FROM portfolio_entries WHERE wallet = '${w.wallet}'`) !== w.available_micro) out.push(`${w.wallet}: available history`);
    if (sum(`SELECT SUM(reserved_change_micro) AS v FROM portfolio_entries WHERE wallet = '${w.wallet}'`) !== w.reserved_micro) out.push(`${w.wallet}: reserved history`);
    if (-sum(`SELECT SUM(available_change_micro) AS v FROM portfolio_entries WHERE wallet = '${w.wallet}' AND kind = 'FEE'`) !== fees) out.push(`${w.wallet}: FEE entries`);
    if (sum(`SELECT SUM(reserved_micro) AS v FROM paper_positions WHERE wallet = '${w.wallet}' AND status = 'OPEN'`) !== w.reserved_micro) out.push(`${w.wallet}: open positions' reserve`);
  }
  return out;
}
const snapshot = () => ({
  wallets: d1(`SELECT * FROM portfolio_wallets ORDER BY wallet`), fees: feeRows(),
  trades: d1(`SELECT id, realized_pnl, gross_pnl, fees_usd, cost_profile FROM trades ORDER BY id`),
  fills: d1(`SELECT id, client_order_id, fee_micro FROM paper_fills ORDER BY id`),
  positions: d1(`SELECT id, status, qty, fees_micro, reserved_micro FROM paper_positions ORDER BY id`),
});
const money = (w) => ({ available: w.available_micro / 1e6, reserved: w.reserved_micro / 1e6, realized: w.realized_pnl_micro / 1e6, fees: Number(w.fees_micro ?? 0) / 1e6, funding: w.net_funding_micro / 1e6 });

const report = {};
before(async () => {
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  PROD_DIR = extract(PROD_REF, "prod");
  ROLLBACK_DIR = extract(ROLLBACK_REF, "rollback");
});
after(async () => {
  await stop();
  fixture.close();
  if (process.env.ROLLBACK_REPORT) writeFileSync(process.env.ROLLBACK_REPORT, JSON.stringify(report, null, 1));
  try { rmSync(work, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

let devTradeOpenAcrossRollback = null;
let beforeRollback = null;

describe("1. production code, schema 3: prior data", () => {
  it("funded; one closed gross trade; one position left open (closes much later, under ROLLBACK)", async () => {
    wrangler(PROD_DIR, ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
    await start(PROD_DIR);
    await paperAction("fund", { action: "deposit", amount_usd: 300 });
    await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 200 });
    market.SOLUSD = P1; await ok(signal("BUY", 0.5));
    market.SOLUSD = P2; await ok(signal("CLOSE"));
    // the pre-migration position is the only open one; it is closed in step 4 by the rollback Worker
    market.SOLUSD = P2; await ok(signal("BUY", 0.25));
    assert.equal((await dashboard()).portfolio.consistency.ok, true);
    await stop();
    report.prior = money(wallet());
  });
});

describe("2. interrupted rollout: migration 0004 applied, production code still running", () => {
  it("before any fee exists the production code stays consistent on schema 4 and keeps trading", async () => {
    wrangler(DEV_DIR, ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
    assert.equal(d1(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0].value, "4");
    await start(PROD_DIR);
    assert.equal((await dashboard()).portfolio.consistency.ok, true);
    await stop();
    assert.deepEqual(invariants(), []);
  });
});

describe("3. development Worker (Ndax): fees recorded", () => {
  it("several lifecycles with maker/taker fees, a partial exit and a duplicate; one fee-paying position left open", async () => {
    await start(DEV_DIR, "ndax");
    market.SOLUSD = P2; await ok(signal("BUY", 0.6, { liquidity: "maker" }));
    market.SOLUSD = P1; await ok(signal("SELL", 0.2));
    const dup = signal("CLOSE", undefined, { liquidity: "maker" });
    await ok(dup);
    assert.equal((await post(dup)).json.code, "DUPLICATE");
    market.SOLUSD = P1; await ok(signal("BUY", 0.3, { liquidity: "maker" }));
    market.SOLUSD = P2; await ok(signal("CLOSE")); // taker
    // a dev-opened position whose ENTRY fee is recorded, left open across the rollback
    market.SOLUSD = P2;
    // first the production-era position (opened in step 1) is still open: this BUY adds to it
    await ok(signal("BUY", 0.2, { liquidity: "maker" }));
    devTradeOpenAcrossRollback = d1(`SELECT id, fees_micro FROM paper_positions WHERE status = 'OPEN'`)[0];
    assert.ok(devTradeOpenAcrossRollback.fees_micro > 0, "open position carries an entry fee");
    const d = await dashboard();
    assert.equal(d.portfolio.consistency.ok, true);
    assert.deepEqual(invariants(), []);
    assert.ok(feeRows().length >= 6);
    await stop();
    beforeRollback = snapshot();
    report.before_rollback = { ...money(wallet()), fee_entries: beforeRollback.fees.length, fee_total: -beforeRollback.fees.reduce((s, f) => s + f.available_change_micro, 0) / 1e6, dashboard_consistency: d.portfolio.consistency };
  });
});

describe("4. ROLLBACK: fee-compatible rollback Worker", () => {
  it("starts with no accounting warning; every balance and fee exactly as before; costs shown as disabled", async () => {
    await start(ROLLBACK_DIR);
    const d = await dashboard();
    assert.deepEqual(d.portfolio.consistency, { ok: true, issues: [] });
    assert.deepEqual(snapshot(), beforeRollback, "the rollback itself changes nothing");
    const sw = d.portfolio.wallets.find((w) => w.wallet === "SOLUSD");
    assert.equal(sw.fees_usd, beforeRollback.wallets.find((w) => w.wallet === "SOLUSD").fees_micro / 1e6);
    assert.equal(d.portfolio.totals.fees_usd, report.before_rollback.fee_total);
    assert.equal(d.portfolio.costs.disabled, true);
    assert.equal(d.portfolio.costs.profile, "none");
    assert.match(d.portfolio.costs.fill_disclosure, /Kraken reference price when the signal is processed/);
    assert.ok(d.portfolio.history.some((e) => e.kind === "FEE"));
    report.after_rollback_start = { ...money(wallet()), dashboard_consistency: d.portfolio.consistency, costs: d.portfolio.costs.name };
  });

  it("a duplicate of a signal processed before the rollback is still a duplicate (no second fill or fee)", async () => {
    const id = d1(`SELECT alert_id FROM paper_fills ORDER BY id DESC LIMIT 1`)[0].alert_id;
    const r = await post({ ...signal("BUY", 0.2, { liquidity: "maker" }), id });
    assert.equal(r.json.code, "DUPLICATE", JSON.stringify(r.json));
    assert.deepEqual(snapshot(), beforeRollback);
  });

  it("closing the position that paid fees before the rollback: no new fee; trade recorded NET of the earlier fees", async () => {
    market.SOLUSD = P1;
    await ok(signal("SELL", 0.15, { liquidity: "taker" })); // partial exit, engine's optional field ignored
    await ok(signal("CLOSE", undefined, { liquidity: "maker" }));
    assert.deepEqual(feeRows(), beforeRollback.fees, "no FEE written, changed or removed");
    const t = d1(`SELECT * FROM trades ORDER BY id DESC LIMIT 1`)[0];
    const p = d1(`SELECT * FROM paper_positions WHERE id = ${t.position_fk}`)[0];
    assert.equal(p.fees_micro, devTradeOpenAcrossRollback.fees_micro, "only the fees paid before the rollback");
    assert.ok(Math.abs(Number(t.realized_pnl) - (p.realized_pnl - p.fees_micro / 1e6)) < 1e-6, "net");
    assert.ok(Math.abs(Number(t.fees_usd) - p.fees_micro / 1e6) < 1e-9);
    assert.equal(t.cost_profile, "none");
    assert.ok(d1(`SELECT * FROM paper_fills WHERE position_fk = ${t.position_fk} ORDER BY id`).slice(-2).every((f) => f.fee_micro === null), "rollback fills carry no fee");
    assert.equal(wallet().reserved_micro, 0);
    assert.deepEqual(invariants(), []);
    report.pre_rollback_position_closed = { trade_net: Number(t.realized_pnl), trade_gross: Number(t.gross_pnl), fees_usd: Number(t.fees_usd), position_opened_by: "production code (step 1), added to by the development Worker (step 3)" };
  });

  it("a new lifecycle after a restart: no fee, gross = net, books consistent; transfers still not P&L", async () => {
    await stop(); await start(ROLLBACK_DIR);
    market.SOLUSD = P2; await ok(signal("BUY", 0.4, { liquidity: "maker" }));
    market.SOLUSD = P1; await ok(signal("CLOSE"));
    const t = d1(`SELECT * FROM trades ORDER BY id DESC LIMIT 1`)[0];
    assert.equal(Number(t.fees_usd), 0);
    assert.equal(Number(t.gross_pnl), Number(t.realized_pnl));
    assert.deepEqual(feeRows(), beforeRollback.fees);
    const w0 = wallet();
    await paperAction("transfer", { from: "SOLUSD", to: "MAIN", amount_usd: 3 });
    await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 3 });
    const w1 = wallet();
    assert.deepEqual([w1.realized_pnl_micro, w1.fees_micro], [w0.realized_pnl_micro, w0.fees_micro]);
    const d = await dashboard();
    assert.deepEqual(d.portfolio.consistency, { ok: true, issues: [] });
    assert.deepEqual(invariants(), []);
    report.after_rollback_trading = { ...money(wallet()), fee_entries: feeRows().length, dashboard_consistency: d.portfolio.consistency };
  });

  it("existing PAPER controls still apply (capital check, no short selling)", async () => {
    const before = snapshot();
    assert.equal((await post(signal("BUY", 50))).status, 422); // far above the balance
    assert.equal((await post(signal("SELL", 1))).status, 422); // nothing held: no short
    assert.deepEqual(snapshot(), before);
  });

  it("dashboard endpoints: performance and trade proof carry gross, fees and net for costed trades", async () => {
    const perf = await api("/api/dashboard/performance");
    assert.ok(perf.trades.some((x) => x.cost_profile === "ndax" && x.fees_usd > 0));
    assert.ok(perf.trades.some((x) => x.cost_profile === "none"));
    assert.ok(perf.trades.some((x) => x.cost_profile === null), "trades from before costs stay gross");
    const id = perf.trades.find((x) => x.cost_profile === "ndax").id;
    const proof = await api(`/api/dashboard/trade-proof?id=${id}`);
    assert.ok(proof.fills.every((f) => f.cost_profile === "ndax"));
    const net = proof.fills.reduce((s, f) => s + (f.side === "sell" ? 1 : -1) * f.qty * f.price - f.fee_micro / 1e6, 0);
    assert.ok(Math.abs(net - Number(proof.trade.realized_pnl)) < 1e-6);
    await stop();
  });
});

describe("5. roll-forward: development Worker again", () => {
  it("consistent; every fee from before the rollback kept once; new fees charged again", async () => {
    const atRollForward = snapshot();
    await start(DEV_DIR, "ndax");
    let d = await dashboard();
    assert.deepEqual(d.portfolio.consistency, { ok: true, issues: [] });
    assert.deepEqual(snapshot(), atRollForward);
    market.SOLUSD = P2; await ok(signal("BUY", 0.2, { liquidity: "maker" }));
    market.SOLUSD = P1; await ok(signal("CLOSE"));
    assert.equal(feeRows().length, beforeRollback.fees.length + 2);
    assert.deepEqual(feeRows().slice(0, beforeRollback.fees.length), beforeRollback.fees);
    d = await dashboard();
    assert.equal(d.portfolio.consistency.ok, true);
    assert.deepEqual(invariants(), []);
    report.roll_forward = { ...money(wallet()), fee_entries: feeRows().length, dashboard_consistency: d.portfolio.consistency };
    await stop();
  });
});

describe("6. interrupted rollout: rollback Worker on an UNMIGRATED (schema 3) database", () => {
  it("runs, trades and reconciles without touching fee columns", async () => {
    persist = join(work, "d1-schema3");
    wrangler(PROD_DIR, ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
    assert.equal(d1(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0].value, "3");
    await start(ROLLBACK_DIR);
    await paperAction("fund", { action: "deposit", amount_usd: 100 });
    await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 100 });
    market.SOLUSD = P1; await ok(signal("BUY", 0.3, { liquidity: "maker" }));
    market.SOLUSD = P2; await ok(signal("CLOSE"));
    const d = await dashboard();
    assert.deepEqual(d.portfolio.consistency, { ok: true, issues: [] });
    assert.equal(d.portfolio.costs.disabled, true);
    assert.match(d.portfolio.costs.caveat, /not been migrated/);
    assert.equal(d.portfolio.totals.fees_usd, 0);
    assert.equal((await api("/api/dashboard/performance")).trades.length, 1);
    assert.deepEqual(invariants(), []);
    report.schema3 = { consistency: d.portfolio.consistency, caveat: d.portfolio.costs.caveat };
    await stop();
  });
});

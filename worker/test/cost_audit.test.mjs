// Independent audit of the PAPER execution-cost release (3ff5717) on real Workers and one throwaway local D1:
//   1. the PRODUCTION Worker code (cde07af, extracted with `git archive`) on schema 3 creates realistic prior data;
//   2. migration 0004 is applied with `wrangler d1 migrations apply`, then checked row by row;
//   3. the NEW Worker (Ndax profile) trades on that data: accounting invariants, concurrency, partial exits;
//   4. ROLLBACK: the production code runs again on the migrated, fee-bearing data;
//   5. ROLL-FORWARD: the new code runs again.
// Isolated: port 8802, its own persist dir, Kraken prices from the committed fixture served on 127.0.0.1.
//   node --test test/cost_audit.test.mjs

import { execFileSync, spawn } from "node:child_process";
import { DEPLOYED_REF, workerAt } from "./lib/worker-at.mjs";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NEW_DIR = join(HERE, "..");
const REPO = join(NEW_DIR, "..");
const PROD_COMMIT = "cde07af"; // deployed Worker version 2cd0119d
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const PORT = 8802;
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

// ---------------------------------------------------------------- production code copy

const work = mkdtempSync(join(tmpdir(), "alpha-cost-audit-"));
const OLD_DIR = join(work, "old", "worker");
// Migrations as released with 0004 (the deployed commit): 0005 and later are covered by their own tests.
const REL_0004 = workerAt(DEPLOYED_REF);
const persist = join(work, "d1");
function extractProduction() {
  // Every tracked file of worker/ at the production commit, written out without touching this checkout.
  const files = execFileSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", PROD_COMMIT, "worker"], { encoding: "utf8" }).trim().split("\n");
  for (const f of files) {
    const dest = join(work, "old", f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, execFileSync("git", ["-C", REPO, "show", `${PROD_COMMIT}:${f}`], { maxBuffer: 64 * 1024 * 1024 }));
  }
  // Same dependencies (worker/package*.json are identical between the two commits).
  // wrangler.jsonc serves ../frontend/dist as static assets; the API under test does not depend on them.
  const link = (target, path) => (WIN ? execFileSync("cmd", ["/c", "mklink", "/J", path, target], { stdio: "ignore" }) : execFileSync("ln", ["-s", target, path]));
  link(join(NEW_DIR, "node_modules"), join(OLD_DIR, "node_modules"));
  link(join(REPO, "frontend"), join(work, "old", "frontend"));
}

function wrangler(dir, args) {
  return execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
}
function sqliteFile(root = persist) {
  const dir = join(root, "v3", "d1", "miniflare-D1DatabaseObject");
  return join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite"));
}
function d1(sql, root = persist) {
  // Throwaway database, read-only queries. Opened read-write because a read-only open fails with "disk I/O error"
  // on Windows right after the Worker process is killed (its WAL index cannot be created read-only).
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
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", "9802", "--ip", "127.0.0.1", "--persist-to", persist];
  const vars = { WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: `http://127.0.0.1:${fixture.address().port}`, PAPER_MARK_MIN_INTERVAL_SECONDS: "0", ALPACA_KEY: "", ALPACA_SECRET: "", ...(profile ? { PAPER_COST_PROFILE: profile } : {}) };
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  // A Worker left over from an interrupted run would silently answer this test's requests: refuse instead.
  let busy = false;
  try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) }); busy = true; } catch { /* free */ }
  if (busy) throw new Error(`port ${PORT} is already in use (a Worker from an interrupted test run?); stop it before running this test`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: dir, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 90000;
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
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) }); } catch { return; }
    await new Promise((r) => setTimeout(r, 300));
  }
}

let n = 0;
const signal = (action, qty, extra = {}) => ({
  secret: WEBHOOK_SECRET, id: `AUDIT-SOLUSD-${action}-${++n}`, symbol: "SOLUSD", timeframe: "5",
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

const wallet = (w = "SOLUSD") => d1(`SELECT * FROM portfolio_wallets WHERE wallet = '${w}'`)[0];
const sum = (sql) => Number(d1(sql)[0].v ?? 0);
/** The ledger's identities, recomputed from raw rows (independent of the Worker's own check). */
function invariants() {
  const out = [];
  for (const w of d1(`SELECT * FROM portfolio_wallets`)) {
    const fees = Number(w.fees_micro ?? 0);
    if (w.available_micro < 0 || w.reserved_micro < 0) out.push(`${w.wallet}: negative balance`);
    if (w.available_micro + w.reserved_micro !== w.net_funding_micro + w.realized_pnl_micro - fees) out.push(`${w.wallet}: available + reserved != funding + realized - fees`);
    if (sum(`SELECT SUM(available_change_micro) AS v FROM portfolio_entries WHERE wallet = '${w.wallet}'`) !== w.available_micro) out.push(`${w.wallet}: available != entry history`);
    if (sum(`SELECT SUM(reserved_change_micro) AS v FROM portfolio_entries WHERE wallet = '${w.wallet}'`) !== w.reserved_micro) out.push(`${w.wallet}: reserved != entry history`);
    if (-sum(`SELECT SUM(available_change_micro) AS v FROM portfolio_entries WHERE wallet = '${w.wallet}' AND kind = 'FEE'`) !== fees) out.push(`${w.wallet}: fees != FEE entries`);
    if (sum(`SELECT SUM(available_change_micro) AS v FROM portfolio_entries WHERE wallet = '${w.wallet}' AND kind = 'REALIZED_PNL'`) !== w.realized_pnl_micro) out.push(`${w.wallet}: realized != REALIZED_PNL entries`);
    if (sum(`SELECT SUM(reserved_micro) AS v FROM paper_positions WHERE wallet = '${w.wallet}' AND status = 'OPEN'`) !== w.reserved_micro) out.push(`${w.wallet}: reserved != open positions' reserved`);
  }
  const fillFees = sum(`SELECT SUM(fee_micro) AS v FROM paper_fills`);
  const walletFees = sum(`SELECT SUM(fees_micro) AS v FROM portfolio_wallets`);
  if (fillFees !== walletFees) out.push(`fill fees ${fillFees} != wallet fees ${walletFees}`);
  const posFees = sum(`SELECT SUM(fees_micro) AS v FROM paper_positions`);
  if (posFees !== fillFees) out.push(`position fees ${posFees} != fill fees ${fillFees}`);
  if (d1(`SELECT COUNT(*) AS v FROM portfolio_entries WHERE kind = 'FEE'`)[0].v !== d1(`SELECT COUNT(*) AS v FROM paper_fills WHERE fee_micro > 0`)[0].v) out.push("FEE entry count != fills with a fee");
  return out;
}
const portfolioSnapshot = () => JSON.stringify([d1(`SELECT * FROM portfolio_wallets ORDER BY wallet`), d1(`SELECT * FROM portfolio_entries ORDER BY id`), d1(`SELECT * FROM paper_positions ORDER BY id`), d1(`SELECT * FROM paper_fills ORDER BY id`), d1(`SELECT * FROM trades ORDER BY id`)]);

const report = {};
before(async () => {
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  extractProduction();
});
after(async () => {
  await stop();
  fixture.close();
  if (process.env.AUDIT_REPORT) {

    writeFileSync(process.env.AUDIT_REPORT, JSON.stringify(report, null, 1));
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

// ---------------------------------------------------------------- 1. production code, schema 3

let before3;
describe("1. production Worker (cde07af) on schema 3 creates the prior data", () => {
  it("schema 3, funded, one closed gross trade and one position left open", async () => {
    wrangler(OLD_DIR, ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
    assert.equal(d1(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0].value, "3");
    await start(OLD_DIR);
    await paperAction("fund", { action: "deposit", amount_usd: 200 });
    await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 100 });
    market.SOLUSD = P1;
    assert.equal((await post(signal("BUY", 0.5))).status, 200);
    market.SOLUSD = P2;
    assert.equal((await post(signal("CLOSE"))).status, 200);
    market.SOLUSD = P2;
    assert.equal((await post(signal("BUY", 0.3))).status, 200); // left OPEN across the migration
    const d = await dashboard();
    assert.equal(d.portfolio.consistency.ok, true);
    await stop();
    before3 = {
      entries: d1(`SELECT * FROM portfolio_entries ORDER BY id`), trades: d1(`SELECT * FROM trades ORDER BY id`),
      wallets: d1(`SELECT * FROM portfolio_wallets ORDER BY wallet`), positions: d1(`SELECT * FROM paper_positions ORDER BY id`),
      fills: d1(`SELECT * FROM paper_fills ORDER BY id`),
      indexes: d1(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`),
      triggers: d1(`SELECT name FROM sqlite_master WHERE type = 'trigger'`),
    };
    report.prior_data = { entries: before3.entries.length, trades: before3.trades.length, positions: before3.positions.length, fills: before3.fills.length };
    assert.ok(before3.entries.length >= 6 && before3.trades.length === 1 && before3.positions.length === 2, JSON.stringify(report.prior_data));
  });
});

// ---------------------------------------------------------------- 2. migration 0004

describe("2. migration 0004 on that data", () => {
  it("applies once through wrangler; every prior row, id, key, amount and index is unchanged", () => {
    const out = wrangler(REL_0004, ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
    assert.match(out, /0004_paper_execution_costs/);
    assert.equal(d1(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0].value, "4");
    assert.deepEqual(d1(`SELECT * FROM portfolio_entries ORDER BY id`), before3.entries);
    const strip = (rows, cols) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !cols.includes(k))));
    assert.deepEqual(strip(d1(`SELECT * FROM trades ORDER BY id`), ["gross_pnl", "fees_usd", "slippage_usd", "cost_profile"]), before3.trades);
    assert.deepEqual(strip(d1(`SELECT * FROM portfolio_wallets ORDER BY wallet`), ["fees_micro"]), before3.wallets);
    assert.deepEqual(strip(d1(`SELECT * FROM paper_positions ORDER BY id`), ["fees_micro", "slippage_micro"]), before3.positions);
    assert.deepEqual(strip(d1(`SELECT * FROM paper_fills ORDER BY id`), ["reference_price", "liquidity", "fee_micro", "slippage_micro", "cost_profile"]), before3.fills);
    assert.ok(d1(`SELECT * FROM trades`).every((t) => t.gross_pnl === null && t.cost_profile === null), "old trades get no cost record");
    assert.deepEqual(d1(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`), before3.indexes);
    assert.deepEqual(d1(`SELECT name FROM sqlite_master WHERE type = 'trigger'`), before3.triggers);
    const fk = d1(`PRAGMA foreign_key_list(portfolio_entries)`);
    assert.deepEqual(fk.map((f) => [f.table, f.from, f.to]), [["portfolio_wallets", "wallet", "wallet"]]);
    assert.equal(d1(`PRAGMA foreign_key_check`).length, 0);
    assert.equal(d1(`SELECT seq FROM sqlite_sequence WHERE name = 'portfolio_entries'`)[0]?.seq, Math.max(...before3.entries.map((e) => e.id)), "AUTOINCREMENT continues after the last id");
    assert.deepEqual(invariants(), []);
    report.migration = { prior_entries: before3.entries.length, prior_trades: before3.trades.length, unchanged: true };
  });

  it("re-applying through wrangler is a no-op", () => {
    const snap = portfolioSnapshot();
    const out = wrangler(REL_0004, ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
    assert.match(out, /No migrations to apply/i);
    assert.equal(portfolioSnapshot(), snap);
  });

  it("running the 0004 file again by hand (on a copy) fails without damaging data", () => {
    const copy = join(work, "d1-copy");
    cpSync(persist, copy, { recursive: true });
    const snap = portfolioSnapshot();
    let err = null;
    try { wrangler(NEW_DIR, ["d1", "execute", "alpha-terminal-db", "--local", "--persist-to", copy, "--file", join("migrations", "0004_paper_execution_costs.sql"), "--yes"]); } catch (e) { err = String(e.stderr ?? e.message); }
    assert.ok(err && /duplicate column/i.test(err), err ?? "expected a failure");
    // Whatever ran before the failing statement must not have changed the books.
    const db = new DatabaseSync(sqliteFile(copy));
    const rows = db.prepare(`SELECT * FROM portfolio_entries ORDER BY id`).all().map((r) => ({ ...r }));
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'portfolio_entries%'`).all().map((r) => r.name);
    db.close();
    report.manual_rerun = { error: err.split("\n").find((l) => /duplicate column/i.test(l)), tables_after: tables, entries_unchanged: JSON.stringify(rows) === JSON.stringify(JSON.parse(snap)[1]) };
    assert.deepEqual(rows, JSON.parse(snap)[1]);
  });
});

// ---------------------------------------------------------------- 3. new code on migrated data

describe("3. new Worker (Ndax) on the migrated data", () => {
  it("starts consistent; the position opened before the migration closes with only its exit costs", async () => {
    await start(NEW_DIR, "ndax");
    assert.equal((await dashboard()).portfolio.consistency.ok, true);
    market.SOLUSD = P1;
    const r = await post(signal("CLOSE")); // pre-migration 0.3 @ 94.33 closes at 95.25 (taker)
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const t = d1(`SELECT * FROM trades ORDER BY id DESC LIMIT 1`)[0];
    const exec = Math.round(95.25 * 0.999 * 1e8) / 1e8;
    const exitFee = Math.round(exec * 0.3 * 0.002 * 1e6);
    assert.equal(Number(t.fees_usd), exitFee / 1e6, "only the exit fee: the entry was filled before costs existed");
    assert.ok(Math.abs(Number(t.gross_pnl) - (95.25 - 94.33) * 0.3) < 1e-6);
    report.pre_migration_position = { trade_cost_profile: t.cost_profile, fees_usd: t.fees_usd, gross: t.gross_pnl, net: t.realized_pnl, note: "entry had no cost; trade is labelled with the exit's profile" };
    assert.deepEqual(invariants(), []);
  });

  it("BUY maker + partial taker SELL + maker CLOSE: three fees, each once; reserve fully released; net = gross - slippage - fees", async () => {
    market.SOLUSD = P2;
    assert.equal((await post(signal("BUY", 0.6, { liquidity: "maker" }))).status, 200);
    market.SOLUSD = P1;
    assert.equal((await post(signal("SELL", 0.2))).status, 200);
    assert.ok(wallet().reserved_micro > 0);
    assert.equal((await post(signal("CLOSE", undefined, { liquidity: "maker" }))).status, 200);
    assert.equal(wallet().reserved_micro, 0);
    const t = d1(`SELECT * FROM trades ORDER BY id DESC LIMIT 1`)[0];
    const fs = d1(`SELECT * FROM paper_fills WHERE position_fk = ${t.position_fk} ORDER BY id`);
    assert.deepEqual(fs.map((f) => [f.kind, f.liquidity]), [["OPEN", "MAKER"], ["REDUCE", "TAKER"], ["CLOSE", "MAKER"]]);
    const fees = fs.reduce((s, f) => s + f.fee_micro, 0);
    assert.equal(Math.round(Number(t.fees_usd) * 1e6), fees);
    const gross = fs.reduce((s, f) => s + (f.side === "sell" ? 1 : -1) * f.qty * f.reference_price, 0);
    assert.ok(Math.abs(Number(t.gross_pnl) - gross) < 2e-6, `gross ${t.gross_pnl} vs ${gross}`);
    const net = fs.reduce((s, f) => s + (f.side === "sell" ? 1 : -1) * f.qty * f.price - f.fee_micro / 1e6, 0);
    assert.ok(Math.abs(Number(t.realized_pnl) - net) < 2e-6, `net ${t.realized_pnl} vs ${net}`);
    assert.ok(Math.abs(Number(t.gross_pnl) - Number(t.slippage_usd) - Number(t.fees_usd) - Number(t.realized_pnl)) < 2e-6);
    assert.deepEqual(invariants(), []);
  });

  it("a retried fill (same id, after a restart too) never charges twice", async () => {
    market.SOLUSD = P2;
    const b = signal("BUY", 0.2, { liquidity: "maker" });
    assert.equal((await post(b)).status, 200);
    const snap = portfolioSnapshot();
    assert.equal((await post(b)).json.code, "DUPLICATE");
    await stop(); await start(NEW_DIR, "ndax");
    assert.equal((await post(b)).json.code, "DUPLICATE");
    assert.equal(portfolioSnapshot(), snap);
    assert.equal((await post(signal("CLOSE"))).status, 200);
    assert.deepEqual(invariants(), []);
  });

  it("concurrent BUYs that each fit but not together: exactly one fills, no overdraft, no partial rows", async () => {
    market.SOLUSD = P2;
    const avail = wallet().available_micro / 1e6;
    const qty = Math.floor(((avail * 0.6) / P2) * 1e4) / 1e4; // each ~60% of the balance
    const before = { fills: d1(`SELECT COUNT(*) AS v FROM paper_fills`)[0].v, fees: d1(`SELECT COUNT(*) AS v FROM portfolio_entries WHERE kind = 'FEE'`)[0].v };
    const rs = await Promise.all([post(signal("BUY", qty, { liquidity: "maker" })), post(signal("BUY", qty, { liquidity: "maker" }))]);
    const ok = rs.filter((r) => r.status === 200).length;
    report.concurrency = { qty, available: avail, statuses: rs.map((r) => `${r.status} ${r.json.code}`) };
    assert.equal(ok, 1, JSON.stringify(rs.map((r) => r.json)));
    assert.equal(d1(`SELECT COUNT(*) AS v FROM paper_fills`)[0].v, before.fills + 1);
    assert.equal(d1(`SELECT COUNT(*) AS v FROM portfolio_entries WHERE kind = 'FEE'`)[0].v, before.fees + 1);
    assert.ok(wallet().available_micro >= 0);
    assert.deepEqual(invariants(), []);
    assert.equal((await post(signal("CLOSE"))).status, 200);
  });

  it("a refused BUY leaves the portfolio, positions, fills and trades exactly as they were", async () => {
    const snap = portfolioSnapshot();
    const r = await post(signal("BUY", 50, { liquidity: "maker" })); // far above the balance
    assert.equal(r.status, 422);
    assert.equal(portfolioSnapshot(), snap);
  });

  it("transfers move funding, never realized P&L or fees", async () => {
    const w0 = wallet();
    await paperAction("transfer", { from: "SOLUSD", to: "MAIN", amount_usd: 5 });
    await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 5 });
    const w1 = wallet();
    assert.deepEqual([w1.realized_pnl_micro, w1.fees_micro, w1.available_micro, w1.net_funding_micro], [w0.realized_pnl_micro, w0.fees_micro, w0.available_micro, w0.net_funding_micro]);
    assert.deepEqual(invariants(), []);
  });

  it("dashboard totals equal the raw ledger", async () => {
    const d = await dashboard();
    const t = d.portfolio.totals;
    const raw = (c) => sum(`SELECT SUM(${c}) AS v FROM portfolio_wallets`) / 1e6;
    assert.equal(t.fees_usd, raw("fees_micro"));
    assert.equal(t.available_usd, raw("available_micro"));
    assert.equal(t.realized_pnl_usd, raw("realized_pnl_micro"));
    assert.equal(t.net_realized_pnl_usd, Math.round((raw("realized_pnl_micro") - raw("fees_micro")) * 1e6) / 1e6);
    assert.equal(d.portfolio.consistency.ok, true);
    const perfFees = (await api("/api/dashboard/performance")).trades.reduce((s, x) => s + (x.fees_usd ?? 0), 0);
    report.new_code = { totals: t, consistency: d.portfolio.consistency, verified_trades_fees: perfFees };
  });
});

// ---------------------------------------------------------------- 4. rollback

describe("4. rollback: production code on the migrated, fee-bearing data", () => {
  it("runs, accepts signals (including the new engine's liquidity field), but reports the books as inconsistent", async () => {
    await stop();
    const snapFees = wallet().fees_micro;
    await start(OLD_DIR);
    const d = await dashboard();
    report.rollback = { dashboard_loads: true, consistency: d.portfolio.consistency };
    market.SOLUSD = P2;
    const b = await post(signal("BUY", 0.2, { liquidity: "maker" }));
    market.SOLUSD = P1;
    const c = await post(signal("CLOSE", undefined, { liquidity: "taker" }));
    report.rollback.signals = [`${b.status} ${b.json.code}`, `${c.status} ${c.json.code}`];
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(wallet().fees_micro, snapFees, "no fee charged by the old code");
    const t = d1(`SELECT * FROM trades ORDER BY id DESC LIMIT 1`)[0];
    report.rollback.trade_written_by_old_code = { cost_profile: t.cost_profile, gross_pnl: t.gross_pnl, realized_pnl: t.realized_pnl };
    // The raw ledger stays coherent under the fee-aware definition...
    assert.deepEqual(invariants(), []);
    // ...but the production code's own check does not know about fees.
    const d2 = await dashboard();
    report.rollback.consistency_after_trading = d2.portfolio.consistency;
    assert.equal(d2.portfolio.consistency.ok, false, "expected the old check to flag the fee-bearing books");
  });
});

// ---------------------------------------------------------------- 5. roll-forward

describe("5. roll-forward: the new code again", () => {
  it("is consistent again and keeps every fee exactly once", async () => {
    await stop();
    await start(NEW_DIR, "ndax");
    const d = await dashboard();
    report.roll_forward = { consistency: d.portfolio.consistency, totals: d.portfolio.totals };
    assert.equal(d.portfolio.consistency.ok, true, JSON.stringify(d.portfolio.consistency.issues));
    assert.deepEqual(invariants(), []);
  });
});

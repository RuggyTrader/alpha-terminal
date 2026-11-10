// Rehearsal of the planned production Worker deployment (docs/RELEASE-RUNBOOK.md sections 3-6) on a throwaway local D1
// shaped like production on 2026-11-10: MAIN $90, SOLUSD $10, no fills or trades, schema 3.
//   1. production Worker (cde07af) on schema 3       2. migration 0004 (every row unchanged)
//   3. fee-aware Worker with the COMMITTED config (no --var override: PAPER_COST_PROFILE from wrangler.jsonc = none)
//   4. an engine-format PAPER lifecycle: no fee, gross = net; duplicates refused; capital check intact
//   5. emergency rollback to the fee-compatible rollback Worker (c5bb67e), then roll-forward
// Isolated: port 8804, its own persist dir, Kraken prices from the committed real fixture on 127.0.0.1.
//   node --test test/deploy_rehearsal.test.mjs

import { execFileSync, spawn } from "node:child_process";
import { DEPLOYED_REF, workerAt } from "./lib/worker-at.mjs";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "./lib/kraken-stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_DIR = join(HERE, "..");
const REPO = join(DEV_DIR, "..");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const PORT = 8804;
const BASE = `http://127.0.0.1:${PORT}`;
const KRAKEN = await startKrakenStub(); // SOLUSD = a real recorded Kraken close

const work = mkdtempSync(join(tmpdir(), "alpha-deploy-rehearsal-"));
const persist = join(work, "d1");
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
let PROD_DIR, ROLLBACK_DIR;

const wrangler = (dir, args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
function d1(sql) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  for (let attempt = 0; ; attempt++) {
    try {
      const db = new DatabaseSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")));
      try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); }
    } catch (e) {
      if (attempt >= 20 || !/disk I\/O|locked|busy/i.test(String(e.message))) throw e;
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 250)"]);
    }
  }
}

let worker = null, cookie = null;
/** Starts a Worker with ONLY the secrets and test plumbing as --var: every other setting comes from that version's wrangler.jsonc. */
async function start(dir) {
  let busy = false;
  try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) }); busy = true; } catch { /* free */ }
  if (busy) throw new Error(`port ${PORT} is already in use`);
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", "9804", "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, PAPER_MARK_MIN_INTERVAL_SECONDS: "0", ALPACA_KEY: "", ALPACA_SECRET: "" })) args.push("--var", `${k}:${v}`);
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
    try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid, "SIGTERM"); } catch { /* gone */ }
  }
  worker = null;
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) }); } catch { return; }
    await new Promise((r) => setTimeout(r, 300));
  }
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
async function paperAction(kind, body) {
  await api("/api/dashboard");
  const r = await fetch(`${BASE}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
    body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }) });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
}
// Engine-format signal (engine/src/runner.mjs flush): id, symbol, timeframe, action, strategy, qty, timestamp, liquidity.
let n = 0;
const engineSignal = (action, qty, liquidity) => ({ secret: WEBHOOK_SECRET, id: `ENG-SOLUSD-5-REHEARSAL-${++n}-${action}`, symbol: "SOLUSD", timeframe: "5",
  action, strategy: "OTE Pro Strat (engine)", ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString(), liquidity });
async function post(body) {
  const r = await fetch(`${BASE}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return { status: r.status, json: await r.json() };
}
const books = () => JSON.stringify([d1("SELECT * FROM portfolio_wallets ORDER BY wallet"), d1("SELECT id, entry_key, kind, wallet, available_change_micro, reserved_change_micro FROM portfolio_entries ORDER BY id"),
  d1("SELECT COUNT(*) AS n FROM paper_fills"), d1("SELECT COUNT(*) AS n FROM trades")]);

before(() => { PROD_DIR = extract("cde07af", "prod"); ROLLBACK_DIR = extract("c5bb67e", "rollback"); });
after(async () => { await stop(); await KRAKEN.close(); try { rmSync(work, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

let prior;
describe("planned production Worker deployment, rehearsed", () => {
  after(stop);

  it("1. production Worker on schema 3 with production-shaped balances (MAIN $90, SOLUSD $10)", async () => {
    wrangler(PROD_DIR, ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
    await start(PROD_DIR);
    await paperAction("fund", { action: "deposit", amount_usd: 100 });
    await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 10 });
    const d = await api("/api/dashboard");
    assert.equal(d.portfolio.consistency.ok, true);
    assert.deepEqual(d.portfolio.wallets.filter((w) => w.wallet === "MAIN" || w.wallet === "SOLUSD").map((w) => [w.wallet, w.available_usd]), [["MAIN", 90], ["SOLUSD", 10]]);
    await stop();
    prior = books();
  });

  it("2. migration 0004: schema 4, every existing row and balance unchanged, no FEE entry", () => {
    wrangler(workerAt(DEPLOYED_REF), ["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]); // 0004 as deployed
    assert.equal(d1("SELECT value FROM app_meta WHERE key = 'schema_version'")[0].value, "4");
    const strip = (j) => JSON.stringify(JSON.parse(j).map((t, i) => (i === 0 ? t.map(({ fees_micro, ...w }) => w) : t)));
    assert.equal(strip(books()), strip(prior));
    assert.equal(d1("SELECT COUNT(*) AS n FROM portfolio_entries WHERE kind = 'FEE'")[0].n, 0);
  });

  it("3. fee-aware Worker with the committed config: costs disabled, consistency OK, dashboard endpoints work", async () => {
    await start(DEV_DIR);
    const d = await api("/api/dashboard");
    assert.equal(d.portfolio.consistency.ok, true, JSON.stringify(d.portfolio.consistency));
    assert.equal(d.portfolio.costs.profile, "none", "wrangler.jsonc ships PAPER_COST_PROFILE=none");
    assert.match(d.portfolio.costs.fill_disclosure, /Kraken reference price when the signal is processed/);
    assert.equal(d.portfolio.totals.fees_usd, 0);
    assert.equal(d.enable_trading, false);
    assert.equal(d.portfolio.limits.max_order_notional_usd, 5000);
    assert.equal(d.portfolio.limits.short_selling_enabled, false);
    for (const p of ["/api/dashboard/performance", "/api/dashboard/trades?limit=10"]) await api(p);
    assert.equal((await (await fetch(`${BASE}/health`)).json()).enable_trading, false);
  });

  it("4. engine-format lifecycle: accepted, no fee, gross = net; duplicate refused; capital check and no-short intact", async () => {
    const buy = engineSignal("BUY", 0.1, "maker");
    assert.equal((await post(buy)).status, 200);
    assert.equal((await post(buy)).json.code, "DUPLICATE");
    assert.equal((await post(engineSignal("BUY", 5, "maker"))).json.code, "INSUFFICIENT_PAPER_CAPITAL", "SOLUSD holds only $10");
    assert.equal((await post(engineSignal("CLOSE", undefined, "taker"))).status, 200);
    assert.equal((await post(engineSignal("SELL", 1, "taker"))).status, 422, "no position: no short");
    assert.equal(d1("SELECT COUNT(*) AS n FROM portfolio_entries WHERE kind = 'FEE'")[0].n, 0, "no fee with costs disabled");
    assert.ok(d1("SELECT * FROM paper_fills").every((f) => f.cost_profile === "none" && f.fee_micro === 0 && f.slippage_micro === 0 && f.price === f.reference_price));
    const t = d1("SELECT * FROM trades ORDER BY id DESC LIMIT 1")[0];
    assert.equal(Number(t.gross_pnl), Number(t.realized_pnl));
    assert.equal(Number(t.fees_usd), 0);
    const proof = await api(`/api/dashboard/trade-proof?id=${t.id}`);
    assert.ok(proof.fills.every((f) => f.cost_profile === "none"));
    const d = await api("/api/dashboard");
    assert.equal(d.portfolio.consistency.ok, true);
    const sol = d.portfolio.wallets.find((w) => w.wallet === "SOLUSD");
    assert.equal(sol.available_usd, Math.round((10 + Number(t.realized_pnl)) * 1e6) / 1e6, "the balance moved by exactly the (gross = net) P&L");
    await stop();
  });

  it("5. emergency rollback to the fee-compatible rollback Worker, then roll-forward: books identical, consistent", async () => {
    const snap = books();
    await start(ROLLBACK_DIR);
    const d = await api("/api/dashboard");
    assert.equal(d.portfolio.consistency.ok, true);
    assert.equal(d.portfolio.costs.disabled, true);
    assert.equal(books(), snap);
    await stop();
    await start(DEV_DIR);
    assert.equal((await api("/api/dashboard")).portfolio.consistency.ok, true);
    assert.equal(books(), snap);
  });
});

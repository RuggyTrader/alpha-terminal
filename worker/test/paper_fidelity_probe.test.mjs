// Why the funded PAPER ledger does not execute the strategy's trades (investigation, 2026-11-10).
// Replays the live engine's REAL entry sizes (from the production engine state; ids are test ids) against the Worker
// deployed as e941387e, run exactly as committed at 8b188c8 (test/lib/worker-at.mjs), on a throwaway local D1 shaped like
// production: schema 4, MAIN $90, SOLUSD $10, PAPER_COST_PROFILE=none from the committed wrangler.jsonc,
// ENABLE_TRADING=false. Nothing here touches production.
//   node --test test/paper_fidelity_probe.test.mjs
// Isolated: port 8806, its own persist dir, Kraken prices from the committed real fixture on 127.0.0.1.

import { execFileSync, spawn } from "node:child_process";
import { DEPLOYED_REF, workerAt } from "./lib/worker-at.mjs";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "./lib/kraken-stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = workerAt(DEPLOYED_REF); // the Worker deployed as e941387e, exactly as committed
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const PORT = 8806;
const BASE = `http://127.0.0.1:${PORT}`;
const KRAKEN = await startKrakenStub();
const work = mkdtempSync(join(tmpdir(), "alpha-fidelity-probe-"));
const persist = join(work, "d1");

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
async function start() {
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", "9806", "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, PAPER_MARK_MIN_INTERVAL_SECONDS: "0", ALPACA_KEY: "", ALPACA_SECRET: "" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).status === 200) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Worker did not start");
}
async function stop() {
  if (worker && worker.exitCode === null) {
    try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid, "SIGTERM"); } catch { /* gone */ }
  }
  worker = null;
}
async function api(path) {
  if (!cookie) {
    const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
    assert.equal(r.status, 200);
    cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  }
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" } });
  assert.equal(r.status, 200, path);
  const j = await r.json();
  return j.data ?? j;
}
async function paperAction(kind, body) {
  await api("/api/dashboard");
  const r = await fetch(`${BASE}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
    body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }) });
  assert.equal(r.status, 200);
}
// Exactly the engine's request body (engine/src/runner.mjs flush).
const signal = (id, action, qty, liquidity) => ({ secret: WEBHOOK_SECRET, id, symbol: "SOLUSD", timeframe: "5", action, strategy: "OTE Pro Strat (engine)",
  ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString(), liquidity });
async function post(body) {
  const r = await fetch(`${BASE}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ...(await r.json()), http: r.status };
}
const ledgerRows = () => JSON.stringify([d1("SELECT wallet, available_micro, reserved_micro, realized_pnl_micro FROM portfolio_wallets ORDER BY wallet"),
  d1("SELECT COUNT(*) AS n FROM paper_fills"), d1("SELECT COUNT(*) AS n FROM paper_positions")]);

before(async () => {
  execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", "d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist], { cwd: DIR, stdio: "ignore", shell: WIN, timeout: 120000 });
  await start();
  await paperAction("fund", { action: "deposit", amount_usd: 100 });
  await paperAction("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 10 });
});
after(async () => { await stop(); await KRAKEN.close(); try { rmSync(work, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

// Real engine entries (production state-SOLUSD-5m.json / audit, 2026-11-09..10). qty = $10 ÷ stop distance.
const REAL = {
  pendingShort: { action: "SELL", qty: 35.61067391, note: "SHORT placed 2026-11-10 03:00 UTC, limit 86.40, stop 86.69" },
  typicalLong: { action: "BUY", qty: 30.5265509, note: "LONG 2026-11-09 13:35 UTC (expired, never sent)" },
  smallestLong: { action: "BUY", qty: 8.02, note: "smallest recorded entry (rounded)" },
  largestLong: { action: "BUY", qty: 87.36, note: "largest recorded entry (rounded)" },
};

describe("funded PAPER ledger vs the strategy's real signals (Worker e941387e code, production-shaped data)", () => {
  const seen = {};

  it("setup matches production: schema 4, costs none, trading off, MAIN $90 / SOLUSD $10, consistent", async () => {
    assert.equal(d1("SELECT value FROM app_meta WHERE key = 'schema_version'")[0].value, "4");
    const d = await api("/api/dashboard");
    assert.equal(d.enable_trading, false);
    assert.equal(d.portfolio.costs.profile, "none");
    assert.equal(d.portfolio.consistency.ok, true);
    assert.deepEqual(d.portfolio.wallets.filter((w) => ["MAIN", "SOLUSD"].includes(w.wallet)).map((w) => [w.wallet, w.available_usd]), [["MAIN", 90], ["SOLUSD", 10]]);
  });

  for (const [name, s] of Object.entries(REAL)) {
    it(`real ${name} (${s.action} ${s.qty} SOL: ${s.note}) is refused and changes nothing`, async (t) => {
      const before = ledgerRows();
      const r = await post(signal(`ENG-SOLUSD-5-PROBE-${name}-${s.action}`, s.action, s.qty, "maker"));
      seen[name] = r.code;
      t.diagnostic(`${name}: HTTP ${r.http} ${r.code} — ${r.message ?? ""}`);
      assert.equal(r.http, 422, JSON.stringify(r)); // the engine treats 400/422 as final: the entry is dropped, not retried
      assert.equal(r.broker_request_sent ?? false, false);
      assert.equal(ledgerRows(), before, "a refusal must not touch the books");
    });
  }

  it("the refusal reasons are the expected ones, in the Worker's check order", () => {
    // SELL with no long position: shorts are not representable (Alpaca/spot-style long-only ledger).
    assert.equal(seen.pendingShort, "NO_POSITION");
    // MAX_ORDER_QTY (10) does not apply to these crypto orders; the value limits do.
    // Up to $5,000: the $10 SOLUSD balance cannot pay for it.
    assert.equal(seen.typicalLong, "INSUFFICIENT_PAPER_CAPITAL");
    assert.equal(seen.smallestLong, "INSUFFICIENT_PAPER_CAPITAL");
    // Above $5,000: the per-order value limit fires first.
    assert.equal(seen.largestLong, "MAX_ORDER_NOTIONAL");
  });

  it("a resend of a refused signal is answered DUPLICATE with its original result (duplicate protection)", async () => {
    const r = await post(signal("ENG-SOLUSD-5-PROBE-pendingShort-SELL", "SELL", REAL.pendingShort.qty, "maker"));
    assert.equal(r.code, "DUPLICATE");
    assert.equal(r.data.original_code, "NO_POSITION");
  });

  it("only an order the $10 balance can pay for fills: 0.1 SOL, no fee, cost_profile none, gross = net, consistent", async () => {
    const open = await post(signal("ENG-SOLUSD-5-PROBE-small-BUY", "BUY", 0.1, "maker"));
    assert.equal(open.code, "DRY_RUN_ACCEPTED", JSON.stringify(open));
    const close = await post(signal("ENG-SOLUSD-5-PROBE-small-CLOSE", "CLOSE", undefined, "taker"));
    assert.equal(close.code, "DRY_RUN_ACCEPTED", JSON.stringify(close));
    assert.ok(d1("SELECT * FROM paper_fills").every((f) => f.cost_profile === "none" && f.fee_micro === 0 && f.price === f.reference_price));
    assert.equal(d1("SELECT COUNT(*) AS n FROM portfolio_entries WHERE kind = 'FEE'")[0].n, 0);
    const t = d1("SELECT * FROM trades ORDER BY id DESC LIMIT 1")[0];
    assert.equal(Number(t.gross_pnl), Number(t.realized_pnl));
    assert.equal((await api("/api/dashboard")).portfolio.consistency.ok, true);
    // At ~$0.26 of stop distance, 0.1 SOL risks about $0.03 instead of the strategy's $10.
  });
});

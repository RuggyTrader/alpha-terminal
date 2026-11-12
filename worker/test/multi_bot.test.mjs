// Independent bots in the ALPHA PAPER ledger (migration 0007, docs/MULTI-BOT-ARCHITECTURE.md), against the real Worker
// on `wrangler dev --local` with a fresh D1. Permanent integration test (mandatory for every new bot).
//   * two bots hold SEPARATE positions in the same symbol; one bot's exit never touches the other's position
//   * shared capital: the second bot cannot spend dollars the first one already reserved (atomic, nothing committed)
//   * per-bot allocation cap (CHECK bot_allocation_cap); paused entries keep exits working
//   * owner validation (unknown, PROPOSED, wrong market/timeframe); the pre-fleet engine (no bot_id) maps to ALPHA-02
//   * per-bot ledger view and status keys; reconciliation; the read-only fleet API
// Isolated: port 8831, own persist dir, Kraken quotes from a local stub.
//   node --test test/multi_bot.test.mjs

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "./lib/kraken-stub.mjs";

const PRICE = 80; // TEST quote for SOLUSD (the stub serves it; not market data)
const KRAKEN = await startKrakenStub({ sol: PRICE });
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
const PORT = 8831;
const base = `http://127.0.0.1:${PORT}`;
let worker, persist, cookie;
const temps = [];

function sql(q, ...args) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  for (let i = 0; ; i++) {
    try {
      const db = new DatabaseSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")));
      try { const st = db.prepare(q); return /^\s*(SELECT|WITH)/i.test(q) ? st.all(...args).map((r) => ({ ...r })) : st.run(...args); } finally { db.close(); }
    } catch (e) {
      if (i >= 40 || !/locked|busy|disk I\/O/i.test(String(e.message))) throw e;
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},250)"]);
    }
  }
}
let n = 0;
const signal = (o) => fetch(`${base}/webhook/dry-run`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ secret: WEBHOOK_SECRET, id: o.id ?? `TEST-${++n}-${randomBytes(4).toString("hex")}`, symbol: "SOLUSD", strategy: "OTE Pro Strat (engine)",
    timestamp: new Date().toISOString(), liquidity: "TAKER", ...o }),
}).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const ledgerView = (o) => fetch(`${base}/webhook/engine-ledger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: WEBHOOK_SECRET, symbol: "SOLUSD", alert_ids: [], ...o }) }).then((r) => r.json());
const status = (o) => fetch(`${base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: WEBHOOK_SECRET, status: { engine: "alpha-engine", symbol: "SOLUSD", ...o } }) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const dash = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } }).then((r) => r.json());
const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: secret() }) }).then((r) => r.json());
const open = () => sql(`SELECT bot_id, qty, reserved_micro, open_alert_id FROM paper_positions WHERE status = 'OPEN' ORDER BY bot_id`);
const wallet = () => sql(`SELECT available_micro, reserved_micro FROM portfolio_wallets WHERE wallet = 'SOLUSD'`)[0];
const botReserved = (id) => sql(`SELECT reserved_micro FROM bots WHERE bot_id = ?`, id)[0].reserved_micro;

before(async () => {
  persist = mkdtempSync(join(tmpdir(), "alpha-bots-"));
  temps.push(persist);
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  // Stage M2 (two bots on one market): the staged 0008, applied explicitly as its own step.
  wrangler(["d1", "execute", "alpha-terminal-db", "--local", "--persist-to", persist, "--file", join("migrations-staged", "0008_bots_multi_position.sql"), "--yes"]);
  // TEST registry rows (the migration registers only ALPHA-02): ALPHA-01 SOLUSD 1m ACTIVE here, ALPHA-03 PROPOSED.
  const now = new Date().toISOString();
  sql(`INSERT INTO bots (bot_id, name, symbol, timeframe_min, profile, wallet, status, legacy_default, priority, created_at, updated_at)
       VALUES ('ALPHA-01', 'ALPHA 01', 'SOLUSD', 1, 'test-1m', 'SOLUSD', 'ACTIVE', 0, 2, ?, ?), ('ALPHA-03', 'ALPHA 03', 'BTCUSD', 1, NULL, 'BTCUSD', 'PROPOSED', 0, 3, ?, ?)`, now, now, now, now);
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 120000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  await act("fund", { action: "deposit", amount_usd: 100 });
  await act("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 100 });
});
after(async () => {
  try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ }
  await KRAKEN.close();
  for (const t of temps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* locked on Windows */ } }
});

describe("independent bots in one ledger (migration 0007)", () => {
  it("schema 8 (0007 + 0008): ALPHA-02 is the SOLUSD legacy bot; one open position per (bot, symbol)", () => {
    assert.equal(sql(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0].value, "8");
    assert.deepEqual(sql(`SELECT bot_id, symbol, timeframe_min, status, legacy_default FROM bots WHERE bot_id = 'ALPHA-02'`),
      [{ bot_id: "ALPHA-02", symbol: "SOLUSD", timeframe_min: 5, status: "ACTIVE", legacy_default: 1 }]);
    const idx = sql(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'paper_positions'`).map((r) => r.name);
    assert.ok(idx.includes("ux_paper_positions_open_owner") && !idx.includes("ux_paper_positions_open_symbol"));
  });

  it("owner validation: unknown, PROPOSED, wrong market or timeframe are refused before anything is filled", async () => {
    for (const [o, code] of [[{ bot_id: "ALPHA-99", timeframe: "1" }, "UNKNOWN_BOT"], [{ bot_id: "ALPHA-03", symbol: "BTCUSD", timeframe: "1" }, "BOT_NOT_ACTIVE"],
      [{ bot_id: "ALPHA-01", timeframe: "5" }, "BOT_TIMEFRAME_MISMATCH"], [{ bot_id: "nope", timeframe: "1" }, "INVALID_BOT_ID"]]) {
      const r = await signal({ action: "BUY", qty: 0.1, ...o });
      assert.equal(r.code, code, JSON.stringify(o));
    }
    assert.deepEqual(open(), []);
    assert.equal(sql(`SELECT COUNT(*) n FROM paper_fills`)[0].n, 0);
  });

  it("two bots hold separate SOLUSD positions at the same time, each with its own reservation", async () => {
    const a = await signal({ action: "BUY", qty: 0.5, bot_id: "ALPHA-01", timeframe: "1" });
    const b = await signal({ action: "BUY", qty: 0.4, bot_id: "ALPHA-02", timeframe: "5" });
    assert.equal(a.code, "DRY_RUN_ACCEPTED", JSON.stringify(a));
    assert.equal(b.code, "DRY_RUN_ACCEPTED", JSON.stringify(b));
    const pos = open();
    assert.deepEqual(pos.map((p) => [p.bot_id, p.qty]), [["ALPHA-01", 0.5], ["ALPHA-02", 0.4]], "two positions, never merged");
    assert.equal(botReserved("ALPHA-01"), 0.5 * PRICE * 1e6);
    assert.equal(botReserved("ALPHA-02"), 0.4 * PRICE * 1e6);
    assert.equal(wallet().reserved_micro, (0.5 + 0.4) * PRICE * 1e6);
    assert.deepEqual(sql(`SELECT DISTINCT bot_id FROM paper_fills ORDER BY bot_id`).map((r) => r.bot_id), ["ALPHA-01", "ALPHA-02"]);
  });

  it("each bot's ledger view shows only its own position; the pre-fleet engine (no bot_id) sees ALPHA-02's", async () => {
    const v1 = await ledgerView({ bot_id: "ALPHA-01" });
    const v2 = await ledgerView({ bot_id: "ALPHA-02" });
    const legacy = await ledgerView({});
    assert.equal(v1.position.qty, 0.5);
    assert.equal(v2.position.qty, 0.4);
    assert.equal(legacy.position.qty, 0.4, "the running engine keeps finding its own position after migration 0007");
    assert.equal(v1.balance.bot_reserved_usd, 40);
    assert.equal(v1.balance.bot_available_usd, v1.balance.available_usd, "no cap: the shared wallet's available balance");
  });

  it("one bot's exit closes only its own trade; the other bot's position is untouched", async () => {
    const before = open().find((p) => p.bot_id === "ALPHA-02");
    const c = await signal({ action: "CLOSE", bot_id: "ALPHA-01", timeframe: "1" });
    assert.equal(c.code, "DRY_RUN_ACCEPTED", JSON.stringify(c));
    assert.deepEqual(open(), [before], "ALPHA-02 keeps managing its position");
    assert.equal(botReserved("ALPHA-01"), 0);
    const t = sql(`SELECT bot_id, CAST(entry_qty AS REAL) AS entry_qty FROM trades`); // legacy column type is TEXT
    assert.deepEqual(t, [{ bot_id: "ALPHA-01", entry_qty: 0.5 }]);
    // A second exit for ALPHA-01 has nothing of its own to close: refused, never ALPHA-02's position.
    const again = await signal({ action: "CLOSE", bot_id: "ALPHA-01", timeframe: "1" });
    assert.equal(again.code, "NO_POSITION");
    assert.deepEqual(open(), [before]);
  });

  it("the pre-fleet engine's signals (no bot_id, its own ENG-SOLUSD-5 ids) are ALPHA-02's; other callers stay unowned", async () => {
    // A TradingView-style alert with no bot_id is NOT ALPHA-02's, even on SOLUSD 5m: it has no position to close.
    const tv = await signal({ id: `tv-${randomBytes(4).toString("hex")}`, action: "CLOSE", timeframe: "5" });
    assert.equal(tv.code, "NO_POSITION");
    assert.equal(sql(`SELECT bot_id FROM alerts WHERE alert_id = ?`, tv.alert_id)[0].bot_id, "");
    const r = await signal({ id: `ENG-SOLUSD-5-${new Date().toISOString().slice(0, 19)}Z-CLOSE`, action: "CLOSE", timeframe: "5" });
    assert.equal(r.code, "DRY_RUN_ACCEPTED", JSON.stringify(r));
    assert.deepEqual(open(), []);
    assert.equal(botReserved("ALPHA-02"), 0);
    assert.equal(sql(`SELECT bot_id FROM alerts WHERE alert_id = ?`, r.alert_id)[0].bot_id, "ALPHA-02");
  });

  it("shared capital: a bot cannot spend dollars another bot already reserved (refused, nothing committed)", async () => {
    // $100 in the shared SOLUSD wallet. ALPHA-02 reserves $91; ALPHA-01 asks for $10 (refused), then $9 (fits).
    const big = await signal({ action: "BUY", qty: 91 / PRICE, bot_id: "ALPHA-02", timeframe: "5" });
    assert.equal(big.code, "DRY_RUN_ACCEPTED", JSON.stringify(big));
    assert.equal(wallet().available_micro, 9e6);
    const fills = sql(`SELECT COUNT(*) n FROM paper_fills`)[0].n;
    const refused = await signal({ action: "BUY", qty: 10 / PRICE, bot_id: "ALPHA-01", timeframe: "1" });
    assert.equal(refused.code, "INSUFFICIENT_PAPER_CAPITAL", JSON.stringify(refused));
    assert.equal(sql(`SELECT COUNT(*) n FROM paper_fills`)[0].n, fills, "nothing committed");
    assert.equal(wallet().available_micro, 9e6, "balance unchanged");
    assert.equal(sql(`SELECT COUNT(*) n FROM paper_positions WHERE bot_id = 'ALPHA-01' AND status = 'OPEN'`)[0].n, 0);
    const fits = await signal({ action: "BUY", qty: 9 / PRICE, bot_id: "ALPHA-01", timeframe: "1" });
    assert.equal(fits.code, "DRY_RUN_ACCEPTED", JSON.stringify(fits));
    assert.equal(wallet().available_micro, 0, "both bots together hold exactly the wallet, never more");
    assert.deepEqual(open().map((p) => [p.bot_id, p.reserved_micro]), [["ALPHA-01", 9e6], ["ALPHA-02", 91e6]]);
  });

  it("allocation cap: a bot may hold at most its cap reserved (gate and CHECK constraint)", async () => {
    assert.equal((await signal({ action: "CLOSE", bot_id: "ALPHA-02", timeframe: "5" })).code, "DRY_RUN_ACCEPTED");
    assert.equal((await signal({ action: "CLOSE", bot_id: "ALPHA-01", timeframe: "1" })).code, "DRY_RUN_ACCEPTED");
    sql(`UPDATE bots SET allocation_cap_micro = 5000000 WHERE bot_id = 'ALPHA-01'`);
    const over = await signal({ action: "BUY", qty: 6 / PRICE, bot_id: "ALPHA-01", timeframe: "1" });
    assert.equal(over.code, "BOT_ALLOCATION_EXCEEDED", JSON.stringify(over));
    const v = await ledgerView({ bot_id: "ALPHA-01" });
    assert.equal(v.balance.bot_allocation_cap_usd, 5);
    assert.equal(v.balance.bot_available_usd, 5, "sized from its cap, not the whole shared wallet");
    const within = await signal({ action: "BUY", qty: 4 / PRICE, bot_id: "ALPHA-01", timeframe: "1" });
    assert.equal(within.code, "DRY_RUN_ACCEPTED", JSON.stringify(within));
    // Even past the gate, the D1 CHECK refuses a reservation above the cap.
    assert.throws(() => sql(`UPDATE bots SET reserved_micro = 6000000 WHERE bot_id = 'ALPHA-01'`), /bot_allocation_cap/);
  });

  it("paused entries: new entries refused, the open position is still closed by its exit", async () => {
    sql(`UPDATE bots SET entries_paused = 1 WHERE bot_id = 'ALPHA-01'`);
    const buy = await signal({ action: "BUY", qty: 0.01, bot_id: "ALPHA-01", timeframe: "1" });
    assert.equal(buy.code, "BOT_ENTRIES_PAUSED");
    const close = await signal({ action: "CLOSE", bot_id: "ALPHA-01", timeframe: "1" });
    assert.equal(close.code, "DRY_RUN_ACCEPTED", JSON.stringify(close));
    assert.deepEqual(open(), []);
    sql(`UPDATE bots SET entries_paused = 0 WHERE bot_id = 'ALPHA-01'`);
  });

  it("per-bot engine status: a new bot never overwrites the legacy engine status; the legacy bot writes both", async () => {
    assert.equal((await status({ bot_id: "ALPHA-01", timeframe: "1m", status_text: "Scanning" })).ok, true);
    assert.equal((await status({ timeframe: "5m", status_text: "Waiting for a swing" })).ok, true); // pre-fleet engine
    const keys = Object.fromEntries(sql(`SELECT key, value FROM app_meta WHERE key LIKE 'engine_status%'`).map((r) => [r.key, JSON.parse(r.value)]));
    assert.equal(keys["engine_status:ALPHA-01"].status_text, "Scanning");
    assert.equal(keys["engine_status:ALPHA-02"].status_text, "Waiting for a swing");
    assert.equal(keys.engine_status.status_text, "Waiting for a swing", "the dashboard's single-engine status is still the 5m engine's");
    assert.equal((await status({ bot_id: "ALPHA-01", timeframe: "5m" })).code, "BOT_TIMEFRAME_MISMATCH");
  });

  it("reconciliation holds and the fleet API reports each bot separately (PAPER and hypothetical never mixed)", async () => {
    const d = await dash("/api/dashboard");
    const consistency = JSON.stringify(d).match(/"consistency":\{"ok":(true|false)/);
    assert.ok(consistency && consistency[1] === "true", "ledger identities hold");
    for (const b of sql(`SELECT b.bot_id, b.reserved_micro, COALESCE((SELECT SUM(reserved_micro) FROM paper_positions p WHERE p.bot_id = b.bot_id AND p.status = 'OPEN'), 0) r FROM bots b`)) {
      assert.equal(b.reserved_micro, b.r, `${b.bot_id} reserved = its open positions`);
    }
    const f = await dash("/api/dashboard/bots");
    assert.equal(f.ok, true);
    const byId = Object.fromEntries(f.data.bots.map((b) => [b.bot_id, b]));
    assert.deepEqual(Object.keys(byId).sort(), ["ALPHA-01", "ALPHA-02", "ALPHA-03"]);
    assert.equal(byId["ALPHA-01"].paper.trades, 3);
    assert.equal(byId["ALPHA-02"].paper.trades, 2);
    assert.equal(byId["ALPHA-03"].status, "PROPOSED");
    assert.equal(byId["ALPHA-01"].engine.status_text, "Scanning");
    const net = f.data.bots.reduce((s, b) => s + b.paper.realized_net_usd, 0);
    const total = sql(`SELECT COALESCE(SUM(realized_pnl), 0) s FROM trades WHERE source = 'ALPHA_PAPER'`)[0].s;
    assert.ok(Math.abs(net - total) < 1e-9, "per-bot P&L adds up to the account's");
    for (const b of f.data.bots) for (const m of b.mirror) assert.equal(m.hypothetical, true);
  });
});

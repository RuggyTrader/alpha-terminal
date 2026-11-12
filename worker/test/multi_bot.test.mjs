// The bot fleet's funded PAPER ledger (migration 0007, worker/src/bot_ledger.ts) against the real Worker on
// `wrangler dev --local` with a fresh D1. Permanent integration test (mandatory for every bot):
//   own wallets + equal-split allocation, LONG and fully collateralised SHORT, Ndax-equivalent 0.20% fee per fill,
//   positive net profit swept to MAIN atomically, losses stay with the bot, recorded shortfall, idempotency,
//   paused entries with exits, per-bot dollar-risk settings, the legacy bot unchanged, reconciliation, fleet API.
// Isolated: port 8831, own persist dir, Kraken quotes from a local stub (TEST prices, not market data).
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

const KRAKEN = await startKrakenStub({ sol: 80 });
KRAKEN.set("XBTUSD", 100000);
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
const TF = { "ALPHA-01": "1", "ALPHA-02": "5", "ALPHA-03": "1", "ALPHA-04": "5" };
const SYM = { "ALPHA-01": "SOLUSD", "ALPHA-02": "SOLUSD", "ALPHA-03": "BTCUSD", "ALPHA-04": "BTCUSD" };
const order = (bot, action, o = {}) => fetch(`${base}/webhook/bot-order`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: bot, order_id: o.order_id ?? `ENG-${bot}-${SYM[bot]}-${TF[bot]}-T${++n}-${action}`, action, symbol: SYM[bot], timeframe: TF[bot], stop: 1, tp: 2, ...o }),
}).then(async (r) => ({ http: r.status, ...(await r.json()) }));
const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: secret(), ...body, passphrase: DASHBOARD_PASSPHRASE }) }).then((r) => r.json());
const dash = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } }).then((r) => r.json());
const W = (w) => sql(`SELECT available_micro a, reserved_micro r, realized_pnl_micro p, fees_micro f, net_funding_micro n, shortfall_micro s FROM portfolio_wallets WHERE wallet = ?`, w)[0];

before(async () => {
  persist = mkdtempSync(join(tmpdir(), "alpha-fleet-ledger-"));
  temps.push(persist);
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  // TEST activation of the PROPOSED bots (production activates them one approval at a time).
  sql(`UPDATE bots SET status = 'ACTIVE' WHERE bot_id IN ('ALPHA-01', 'ALPHA-03', 'ALPHA-04')`);
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 120000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  await act("fund", { action: "deposit", amount_usd: 100 });
});
after(async () => {
  try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ }
  await KRAKEN.close();
  for (const t of temps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* locked on Windows */ } }
});

describe("bot fleet ledger (migration 0007)", () => {
  it("schema 7: four bots, their own wallets; only ALPHA-02 is ACTIVE in the migration itself", () => {
    assert.equal(sql(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0].value, "7");
    assert.deepEqual(sql(`SELECT bot_id, group_id, symbol, timeframe_min, wallet, ledger_api FROM bots ORDER BY bot_id`).map(Object.values),
      [["ALPHA-01", "SOLANA", "SOLUSD", 1, "ALPHA-01", "bot"], ["ALPHA-02", "SOLANA", "SOLUSD", 5, "SOLUSD", "legacy"], ["ALPHA-03", "BITCOIN", "BTCUSD", 1, "ALPHA-03", "bot"], ["ALPHA-04", "BITCOIN", "BTCUSD", 5, "ALPHA-04", "bot"]]);
    for (const w of ["ALPHA-01", "ALPHA-03", "ALPHA-04"]) assert.equal(W(w).a, 0, "wallets start empty: no capital is created");
  });

  it("allocation from MAIN splits equally between a group's ACTIVE bots, to the micro-dollar; preview first; idempotent", async () => {
    const pv = await dash("/api/dashboard/allocation-preview?group=SOLANA&amount=20.01");
    assert.deepEqual(pv.data.split.map((s) => [s.bot_id, s.amount_micro]), [["ALPHA-02", 10_005_000], ["ALPHA-01", 10_005_000]]);
    const rid = secret();
    const a = await act("allocate", { group: "SOLANA", amount_usd: 20, request_id: rid });
    assert.deepEqual(a.split.map((s) => [s.bot_id, s.amount_usd]), [["ALPHA-02", 10], ["ALPHA-01", 10]]);
    assert.equal((await act("allocate", { group: "SOLANA", amount_usd: 20, request_id: rid })).duplicate, true, "a repeated request moves nothing");
    await act("allocate", { group: "BITCOIN", amount_usd: 20.01 });
    assert.equal(W("ALPHA-03").a + W("ALPHA-04").a, 20_010_000, "the parts sum exactly");
    assert.deepEqual([W("ALPHA-03").a, W("ALPHA-04").a], [10_005_000, 10_005_000]);
    assert.equal(W("SOLUSD").a, 10_000_000, "the legacy SOL 5m wallet receives its equal half");
    assert.equal(W("MAIN").a, 100e6 - 40.01e6);
    assert.equal((await act("allocate", { group: "BITCOIN", amount_usd: 1000 })).code, "INSUFFICIENT_MAIN");
  });

  it("refuses what a bot may not do: PROPOSED/legacy/mismatch/precision/minimum/own capital", async () => {
    assert.equal((await order("ALPHA-02", "OPEN_LONG", { qty: 0.1 })).code, "BOT_LEDGER_PATH", "the legacy bot keeps its legacy path");
    assert.equal((await order("ALPHA-01", "OPEN_LONG", { qty: 0.1, timeframe: "5" })).code, "BOT_TIMEFRAME_MISMATCH");
    assert.equal((await order("ALPHA-01", "OPEN_LONG", { qty: 0.1, symbol: "BTCUSD" })).code, "BOT_MARKET_MISMATCH");
    assert.equal((await order("ALPHA-01", "OPEN_LONG", { qty: 0.123456789 })).code, "INVALID_QTY");
    assert.equal((await order("ALPHA-01", "OPEN_LONG", { qty: 0.04 })).code, "BELOW_MIN_QTY");
    assert.equal((await order("ALPHA-03", "OPEN_SHORT", { qty: 0.0001 })).code, "INSUFFICIENT_BOT_CAPITAL", "$10 + $0.02 fee > its own $10.005; never another bot's money");
    assert.equal(sql(`SELECT COUNT(*) n FROM bot_positions`)[0].n, 0, "nothing committed");
  });

  it("LONG entry: own wallet pays qty × price + 0.20% fee; one authoritative fee record", async () => {
    const r = await order("ALPHA-01", "OPEN_LONG", { qty: 0.1, order_id: "ENG-ALPHA-01-SOLUSD-1-L1-OPEN_LONG" });
    assert.equal(r.code, "DRY_RUN_ACCEPTED", JSON.stringify(r));
    assert.deepEqual([r.data.notional_usd, r.data.fee_usd], [8, 0.016]);
    assert.deepEqual(W("ALPHA-01"), { a: 10e6 - 8e6 - 16_000, r: 8e6, p: 0, f: 16_000, n: 10e6, s: 0 });
    const f = sql(`SELECT kind, side, qty, price, notional_micro, fee_rate_pct, fee_micro, fee_currency, fee_model FROM bot_fills WHERE fill_id = 'ENG-ALPHA-01-SOLUSD-1-L1-OPEN_LONG'`)[0];
    assert.deepEqual(f, { kind: "ENTRY", side: "LONG", qty: 0.1, price: 80, notional_micro: 8e6, fee_rate_pct: 0.2, fee_micro: 16_000, fee_currency: "USD", fee_model: "ndax-flat-0.20-2026-11-12" });
  });

  it("SHORT entry: fully collateralised from the bot's own wallet; opposing BTC positions coexist across bots", async () => {
    const s = await order("ALPHA-03", "OPEN_SHORT", { qty: 0.00009, order_id: "ENG-ALPHA-03-BTCUSD-1-S1-OPEN_SHORT" });
    assert.equal(s.code, "DRY_RUN_ACCEPTED", JSON.stringify(s));
    const l = await order("ALPHA-04", "OPEN_LONG", { qty: 0.00009 });
    assert.equal(l.code, "DRY_RUN_ACCEPTED");
    assert.deepEqual(sql(`SELECT bot_id, side, qty, collateral_micro FROM bot_positions WHERE status = 'OPEN' ORDER BY bot_id`).map(Object.values),
      [["ALPHA-01", "LONG", 0.1, 8e6], ["ALPHA-03", "SHORT", 0.00009, 9e6], ["ALPHA-04", "LONG", 0.00009, 9e6]]);
    assert.equal(W("ALPHA-03").r, 9e6, "short collateral reserved; proceeds never spendable");
    assert.equal((await order("ALPHA-03", "OPEN_LONG", { qty: 0.00001 })).code, "POSITION_ALREADY_OPEN", "pyramiding 0 per bot");
  });

  it("the bot's ledger view shows only its own position and wallet", async () => {
    const v = await fetch(`${base}/webhook/bot-ledger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: "ALPHA-03", symbol: "BTCUSD", alert_ids: ["ENG-ALPHA-03-BTCUSD-1-S1-OPEN_SHORT"] }) }).then((r) => r.json());
    assert.equal(v.position.side, "short"); assert.equal(v.position.open_alert_id, "ENG-ALPHA-03-BTCUSD-1-S1-OPEN_SHORT");
    assert.equal(v.alerts["ENG-ALPHA-03-BTCUSD-1-S1-OPEN_SHORT"].response_code, "DRY_RUN_ACCEPTED");
    assert.equal(v.balance.wallet, "ALPHA-03"); assert.equal(v.balance.reserved_usd, 9);
  });

  it("profitable close: net (gross − entry fee − exit fee) is swept to MAIN in the same transaction; the bot keeps its balance", async () => {
    const mainBefore = W("MAIN").a;
    KRAKEN.set("SOLUSD", 81);
    const c = await order("ALPHA-01", "CLOSE", { order_id: "ENG-ALPHA-01-SOLUSD-1-L1-CLOSE" });
    assert.equal(c.code, "DRY_RUN_ACCEPTED", JSON.stringify(c));
    // gross 0.1 × (81 − 80) = 0.10; fees 0.016 + 0.0162; net 0.0678
    assert.deepEqual([c.data.gross_usd, c.data.fees_usd, c.data.net_usd, c.data.swept_to_main_usd], [0.1, 0.0322, 0.0678, 0.0678]);
    assert.equal(W("ALPHA-01").a, 10e6, "no compounding: back to its pre-trade balance");
    assert.equal(W("MAIN").a - mainBefore, 67_800);
    assert.equal(sql(`SELECT COUNT(*) n FROM portfolio_entries WHERE group_key = 'SWEEP:ENG-ALPHA-01-SOLUSD-1-L1-OPEN_LONG'`)[0].n, 2, "matching debit and credit");
    // a retried close (same id) is answered as a duplicate and changes nothing
    const again = await order("ALPHA-01", "CLOSE", { order_id: "ENG-ALPHA-01-SOLUSD-1-L1-CLOSE" });
    assert.equal(again.code, "DUPLICATE"); assert.equal(again.data.original_code, "DRY_RUN_ACCEPTED");
    assert.equal(W("MAIN").a - mainBefore, 67_800, "never swept twice");
    assert.equal((await order("ALPHA-01", "CLOSE")).code, "NO_POSITION", "a second exit has nothing of its own to close");
  });

  it("losing SHORT close: (entry − exit) × qty, fees, the loss stays with the bot; no sweep", async () => {
    KRAKEN.set("XBTUSD", 101000);
    const mainBefore = W("MAIN").a;
    const c = await order("ALPHA-03", "CLOSE");
    assert.equal(c.code, "DRY_RUN_ACCEPTED");
    assert.equal(c.data.gross_usd, -0.09); assert.equal(c.data.swept_to_main_usd, 0);
    assert.equal(W("MAIN").a, mainBefore, "MAIN never covers a loss");
    assert.equal(W("ALPHA-03").a, 10_005_000 + Math.round(c.data.net_usd * 1e6));
    assert.ok(sql(`SELECT * FROM bot_positions WHERE bot_id = 'ALPHA-04' AND status = 'OPEN'`).length === 1, "ALPHA-04's long untouched");
  });

  it("paused entries: new entries refused, the open position is still closed", async () => {
    assert.equal((await act("bot-entries", { bot_id: "ALPHA-04", paused: true })).entries_paused, true);
    assert.equal((await order("ALPHA-04", "OPEN_SHORT", { qty: 0.00006 })).code, "BOT_ENTRIES_PAUSED");
    KRAKEN.set("XBTUSD", 102000);
    const c = await order("ALPHA-04", "CLOSE");
    assert.equal(c.code, "DRY_RUN_ACCEPTED"); assert.ok(c.data.swept_to_main_usd > 0);
    await act("bot-entries", { bot_id: "ALPHA-04", paused: false });
  });

  it("a short beyond its collateral and cash: recorded shortfall, entries paused, MAIN and other bots untouched", async () => {
    KRAKEN.set("XBTUSD", 100000);
    const s = await order("ALPHA-03", "OPEN_SHORT", { qty: 0.00009 });
    assert.equal(s.code, "DRY_RUN_ACCEPTED", JSON.stringify(s));
    const mainBefore = W("MAIN").a, otherBefore = W("ALPHA-04").a;
    KRAKEN.set("XBTUSD", 250000);
    const c = await order("ALPHA-03", "CLOSE");
    assert.equal(c.code, "DRY_RUN_ACCEPTED");
    assert.ok(c.data.shortfall_usd > 0);
    assert.equal(W("ALPHA-03").a, 0); assert.ok(W("ALPHA-03").s > 0);
    assert.equal(W("MAIN").a, mainBefore); assert.equal(W("ALPHA-04").a, otherBefore);
    assert.equal(sql(`SELECT entries_paused FROM bots WHERE bot_id = 'ALPHA-03'`)[0].entries_paused, 1);
    assert.equal((await order("ALPHA-03", "OPEN_LONG", { qty: 0.00006 })).code, "BOT_ENTRIES_PAUSED");
    const t = sql(`SELECT net_pnl_micro, gross_pnl_micro, entry_fee_micro, exit_fee_micro, shortfall_micro FROM bot_positions WHERE close_order_id IS NOT NULL ORDER BY id DESC LIMIT 1`)[0];
    assert.equal(t.net_pnl_micro, t.gross_pnl_micro - t.entry_fee_micro - t.exit_fee_micro, "the trade's full loss is reported");
    KRAKEN.set("XBTUSD", 100000);
  });

  it("per-bot dollar risk: requested on the website, confirmed by that bot's engine, never another bot's", async () => {
    const r = await act("bot-risk", { bot_id: "ALPHA-01", risk_usd: 2.5 });
    assert.deepEqual([r.version, r.status], [1, "PENDING"]);
    const hb = await fetch(`${base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, status: { engine: "alpha-engine", symbol: "SOLUSD", timeframe: "1m", bot_id: "ALPHA-01", status_text: "Scanning", bot_risk: null } }) }).then((x) => x.json());
    assert.deepEqual(hb.settings, { bot_id: "ALPHA-01", version: 1, risk_usd: 2.5 });
    await fetch(`${base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, status: { engine: "alpha-engine", symbol: "SOLUSD", timeframe: "1m", bot_id: "ALPHA-01", bot_risk: { version: 1, risk_usd: 2.5 } } }) });
    assert.deepEqual(sql(`SELECT bot_id, risk_usd FROM bots ORDER BY bot_id`).map(Object.values), [["ALPHA-01", 2.5], ["ALPHA-02", 10], ["ALPHA-03", 10], ["ALPHA-04", 10]]);
    assert.equal(sql(`SELECT status FROM bot_settings WHERE bot_id = 'ALPHA-01'`)[0].status, "APPLIED");
    assert.equal((await act("bot-risk", { bot_id: "ALPHA-01", risk_usd: 0.001 })).code, "INVALID_RISK");
  });

  it("every wallet reconciles; the fleet API reports each bot's own gross, fees, net and sweeps, mirror separate", async () => {
    const d = await dash("/api/dashboard");
    const consistency = JSON.stringify(d).match(/"consistency":\{"ok":(true|false)/);
    assert.ok(consistency && consistency[1] === "true", JSON.stringify(d).match(/"issues":\[[^\]]*\]/)?.[0]);
    const f = await dash("/api/dashboard/bots");
    const b = Object.fromEntries(f.data.bots.map((x) => [x.bot_id, x]));
    assert.equal(b["ALPHA-01"].paper.trades, 1);
    assert.ok(Math.abs(b["ALPHA-01"].paper.net_usd - 0.0678) < 1e-9);
    assert.ok(Math.abs(b["ALPHA-01"].funding.profit_swept_to_main_usd - 0.0678) < 1e-9);
    assert.equal(b["ALPHA-03"].paper.short_trades, 2);
    assert.ok(b["ALPHA-03"].balances.shortfall_usd > 0);
    assert.ok(Math.abs(b["ALPHA-01"].paper.gross_usd - b["ALPHA-01"].paper.fees_usd - b["ALPHA-01"].paper.net_usd) < 1e-9, "net = gross − fees");
    assert.deepEqual(f.data.groups.map((g) => g.group_id), ["BITCOIN", "ETHEREUM", "SOLANA"]);
    for (const x of f.data.bots) for (const m of x.mirror) assert.equal(m.hypothetical, true);
    // money is conserved: every wallet's balance = its funding + what it paid out/received in trading − fees
    for (const w of sql(`SELECT wallet, available_micro + reserved_micro AS book, net_funding_micro + realized_pnl_micro - fees_micro AS ident FROM portfolio_wallets`)) assert.equal(w.book, w.ident, w.wallet);
  });
});

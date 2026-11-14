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
  body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: bot, order_id: o.order_id ?? `ENG-${bot}-${SYM[bot]}-${TF[bot]}-T${++n}-${action}`, action, symbol: SYM[bot], timeframe: TF[bot], stop: SYM[bot] === "SOLUSD" ? 79 : 99000, tp: 2, ...o }),
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
    KRAKEN.set("XBTUSD", 200000); // TEST price: even the reduced size (10.005 / (200000 × 1.002) = 0.0000499) is below the 0.00006 minimum
    assert.equal((await order("ALPHA-03", "OPEN_SHORT", { qty: 0.0001 })).code, "INSUFFICIENT_BOT_CAPITAL", "$20 + fee > its own $10.005 and no size it can afford meets the minimum; never another bot's money");
    KRAKEN.set("XBTUSD", 100000);
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
    assert.equal((await order("ALPHA-03", "OPEN_LONG", { qty: 0.00006 })).code, "BOT_SHORTFALL");
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
    const lifetime = (await dash("/api/dashboard/performance")).data.lifetime;
    const expected = sql(`SELECT (SELECT COUNT(*) FROM bot_positions WHERE status = 'CLOSED') + (SELECT COUNT(*) FROM trades WHERE source = 'ALPHA_PAPER' AND status = 'CLOSED' AND closed_at IS NOT NULL) n`)[0].n;
    assert.equal(lifetime.closed_trades, expected, "lifetime API spans both funded ledgers");
    assert.equal(lifetime.complete, true);
    // money is conserved: every wallet's balance = its funding + what it paid out/received in trading − fees
    for (const w of sql(`SELECT wallet, available_micro + reserved_micro AS book, net_funding_micro + realized_pnl_micro - fees_micro AS ident FROM portfolio_wallets`)) assert.equal(w.book, w.ident, w.wallet);
  });

  it("regression (ALPHA-01 2026-11-09 11:17): a fill beyond the sizing headroom is REDUCED to fit the bot's own wallet, never refused or raised", async () => {
    if (sql(`SELECT COUNT(*) n FROM bot_positions WHERE bot_id = 'ALPHA-04' AND status = 'OPEN'`)[0].n) assert.equal((await order("ALPHA-04", "CLOSE")).code, "DRY_RUN_ACCEPTED");
    const avail = W("ALPHA-04").a;
    const requested = Number((Math.ceil((avail / 1e6 / 100000) * 1e8) / 1e8 + 0.00001).toFixed(8)); // more than the wallet can pay at 100000
    const r = await order("ALPHA-04", "OPEN_SHORT", { qty: requested, order_id: "ENG-ALPHA-04-BTCUSD-5-FIT-OPEN_SHORT" });
    assert.equal(r.code, "DRY_RUN_ACCEPTED", JSON.stringify(r));
    assert.equal(r.data.reduced_to_fit, true);
    assert.equal(r.data.requested_qty, requested);
    const expect = Math.floor((avail / 1e6 / (100000 * 1.002)) * 1e8) / 1e8;
    assert.equal(r.data.qty, expect, "floored to the venue step, never above what the wallet pays");
    const pos = sql(`SELECT qty, collateral_micro, entry_fee_micro FROM bot_positions WHERE trade_id = 'ENG-ALPHA-04-BTCUSD-5-FIT-OPEN_SHORT'`)[0];
    assert.equal(pos.qty, expect);
    assert.ok(pos.collateral_micro + pos.entry_fee_micro <= avail, "the bot's own wallet pays collateral + fee");
    assert.equal(sql(`SELECT requested_qty FROM bot_orders WHERE order_id = 'ENG-ALPHA-04-BTCUSD-5-FIT-OPEN_SHORT'`)[0].requested_qty, requested, "the request is kept as sent");
    assert.equal(sql(`SELECT qty FROM bot_fills WHERE fill_id = 'ENG-ALPHA-04-BTCUSD-5-FIT-OPEN_SHORT'`)[0].qty, expect);
    for (const w of sql(`SELECT wallet, available_micro + reserved_micro AS book, net_funding_micro + realized_pnl_micro - fees_micro AS ident FROM portfolio_wallets`)) assert.equal(w.book, w.ident, w.wallet);
  });

  it("bot lifecycle notifications come from the bot's own engine reports: pending order, cancel, break-even, trailing; never twice", async () => {
    const report = (st, extra = {}) => fetch(`${base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, status: { engine: "alpha-engine", symbol: "BTCUSD", timeframe: "1m", bot_id: "ALPHA-03", last_candle_time: extra.t ?? "2026-11-12T10:00:00Z", strategy_state: st, ...extra } }) }).then((x) => x.json());
    const S = (o = {}) => ({ direction: "LONG", leg_start: 99000, leg_end: 101000, setup_bars: 2, max_age_bars: 50, pending_order: null, current_stop: null, break_even_done: false, trailing: false, ...o });
    const pend = { side: "LONG", qty: 0.00009, limit: 99590, stop: 98900, tp: 101500 };
    const ev = () => sql(`SELECT kind, side, price, bot_id, url FROM trade_events WHERE bot_id = 'ALPHA-03' AND kind IN ('ORDER_PENDING', 'ORDER_CANCELLED', 'STOP_TO_BREAK_EVEN', 'TRAILING_STOP_MOVED') ORDER BY id`).map(Object.values);
    assert.equal((await report(S())).ok, true);
    await report(S({ pending_order: pend }));
    await report(S({ pending_order: pend }), { t: "2026-11-12T10:01:00Z" }); // the same order reported again: no second event
    await report(S(), { t: "2026-11-12T10:02:00Z" }); // gone without a fill
    await report(S({ pending_order: pend }), { t: "2026-11-12T10:03:00Z" }); // the same setup again: the key already exists, still one event
    const pos = { side: "LONG", qty: 0.00009, entry: 99590, stop: 98900, tp2: 101500 };
    await report(S({ current_stop: 98900 }), { t: "2026-11-12T10:04:00Z", position: pos });
    await report(S({ current_stop: 99590, break_even_done: true }), { t: "2026-11-12T10:05:00Z", position: pos });
    await report(S({ current_stop: 99800, break_even_done: true, trailing: true }), { t: "2026-11-12T10:06:00Z", position: pos });
    await report(S({ current_stop: 99800, break_even_done: true, trailing: true }), { t: "2026-11-12T10:07:00Z", position: pos }); // unchanged: nothing
    await report(S({ current_stop: 100100, break_even_done: true, trailing: true }), { t: "2026-11-12T10:08:00Z", position: pos });
    const u = "/bots/ALPHA-03/chart";
    assert.deepEqual(ev(), [["ORDER_PENDING", "LONG", 99590, "ALPHA-03", u], ["ORDER_CANCELLED", "LONG", 99590, "ALPHA-03", u], ["STOP_TO_BREAK_EVEN", "LONG", 99590, "ALPHA-03", u],
      ["TRAILING_STOP_MOVED", "LONG", 99800, "ALPHA-03", u], ["TRAILING_STOP_MOVED", "LONG", 100100, "ALPHA-03", u]]);
    const feed = await dash("/api/dashboard/events?limit=50");
    const titles = JSON.stringify(feed);
    assert.ok(/ALPHA 03 \| BTCUSD 1m/.test(titles) && /limit order pending/.test(titles) && /stop moved to break-even/.test(titles) && /trailing stop moved/.test(titles), titles.slice(0, 400));
  });

  it("Trades filters and bot trade proof: ?bot= and ?signal= return exactly that bot's / signal's records; the proof's arithmetic checks pass", async () => {
    const all = await dash("/api/dashboard/bot-trades?bot=ALPHA-01");
    assert.ok(all.data.trades.length >= 1 && all.data.trades.every((t) => t.bot_id === "ALPHA-01"), JSON.stringify(all.data.trades));
    assert.ok(all.data.orders.every((o) => o.bot_id === "ALPHA-01"));
    const id = "ENG-ALPHA-01-SOLUSD-1-L1-OPEN_LONG";
    const one = await dash(`/api/dashboard/bot-trades?signal=${encodeURIComponent(id)}`);
    assert.deepEqual(one.data.trades.map((t) => [t.trade_id, t.proof_url]), [[id, `/bots/trade/${id}`]]);
    assert.deepEqual(one.data.orders.map((o) => o.order_id).sort(), sql(`SELECT order_id FROM bot_orders WHERE order_id = ? OR trade_id = ?`, id, id).map((r) => r.order_id).sort());
    const other = await dash("/api/dashboard/bot-trades?bot=ALPHA-04");
    assert.ok(other.data.trades.every((t) => t.bot_id === "ALPHA-04") && !other.data.trades.some((t) => t.trade_id === id), "never another bot's trades");
    const proof = await dash(`/api/dashboard/bot-trade?id=${encodeURIComponent(id)}`);
    assert.equal(proof.ok, true);
    assert.equal(proof.data.all_checks_ok, true, JSON.stringify(proof.data.checks));
    assert.ok(proof.data.checks.length >= 6);
    assert.deepEqual(proof.data.fills.map((f) => f.kind), ["ENTRY", "EXIT"]);
    assert.ok(!JSON.stringify(proof.data).includes(WEBHOOK_SECRET), "no secret in the proof");
    assert.equal((await fetch(`${base}/api/dashboard/bot-trade?id=nope`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/dashboard/bot-trades?bot=ALPHA-01`)).status, 401, "session required");
  });

  it("trade story: the plan sent with an entry and the reason sent with its exit are shown with the trade (bot ledger AND legacy ledger); missing ones are declared", async () => {
    const plan = { v: 1, side: "LONG", setup_at: "2026-11-13T00:25:00.000Z", swing: { origin: 81.18, end: 81.72 }, ote_705: 81.3393, profile: "solusd-1m", inputs_hash: "0932a1a0cfac03f9",
      rules: { entry_mode: "Limit @ 0.705", sl_mode: "Swing origin (1.0)", sl_buf_atr: 0.1, tp2_ext: -0.55, min_score: 1 }, order: { placed_at: "2026-11-13T00:25:00.000Z", type: "LIMIT", limit: 81.34, stop: 81.17, tp2: 82.02, qty: 0.1, score: 1 },
      filled_at: "2026-11-13T00:35:00.000Z", strategy_entry: 81.34, initial_stop: 81.1669, tp2: 82.017, score: 1, confluence: ["OB", "<script>"], stop_history: [] };
    const exit = { v: 1, kind: "SL", result: "SL", exit_r: -0.98, strategy_exit: 81.17, initial_stop: 81.1669, stop_at_exit: 81.1669, tp2: 82.017, stop_history: [] };
    // bot ledger (ALPHA-01)
    const open = await order("ALPHA-01", "OPEN_LONG", { qty: 0.05, order_id: "ENG-ALPHA-01-SOLUSD-1-STORY-OPEN_LONG", plan });
    assert.equal(open.code, "DRY_RUN_ACCEPTED", JSON.stringify(open));
    assert.equal((await order("ALPHA-01", "CLOSE", { order_id: "ENG-ALPHA-01-SOLUSD-1-STORY-CLOSE", exit })).code, "DRY_RUN_ACCEPTED");
    const proof = await dash(`/api/dashboard/bot-trade?id=${encodeURIComponent("ENG-ALPHA-01-SOLUSD-1-STORY-OPEN_LONG")}`);
    assert.equal(proof.data.story.plan.swing_origin, 81.18);
    assert.equal(proof.data.story.plan.planned_entry, 81.34);
    assert.deepEqual(proof.data.story.plan.confluence, ["OB"], "only known PD-array tags pass the whitelist");
    assert.equal(proof.data.story.exit.result, "SL");
    assert.deepEqual(proof.data.story.missing, []);
    const list = await dash("/api/dashboard/bot-trades?bot=ALPHA-01");
    const row = list.data.trades.find((t) => t.trade_id === "ENG-ALPHA-01-SOLUSD-1-STORY-OPEN_LONG");
    assert.equal(row.story.plan.tp2, 82.017);
    assert.equal(row.story.exit.kind, "SL");
    const older = list.data.trades.find((t) => t.trade_id === "ENG-ALPHA-01-SOLUSD-1-L1-OPEN_LONG");
    assert.equal(older.story.plan, null, "a trade recorded without a plan shows none");
    assert.ok(older.story.missing.length >= 1, "and says what is missing");
    // legacy ledger (ALPHA-02, /webhook/dry-run), as today's production engine path
    const dry = (id, action, extra) => fetch(`${base}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, id, symbol: "SOLUSD", timeframe: "5", action, strategy: "OTE Pro Strat (engine)", timestamp: new Date().toISOString(), ...extra }) }).then((r) => r.json());
    const b = await dry("ENG-SOLUSD-5-2026-11-13T00:30:00Z-BUY", "BUY", { qty: 0.1, plan: { ...plan, profile: "solusd-5m" } });
    assert.equal(b.code, "DRY_RUN_ACCEPTED", JSON.stringify(b));
    assert.equal((await dry("ENG-SOLUSD-5-2026-11-13T00:35:00Z-CLOSE", "CLOSE", { exit })).code, "DRY_RUN_ACCEPTED");
    const d = await dash("/api/dashboard");
    const t = d.data.recent.trades.find((x) => x.open_alert_id === "ENG-SOLUSD-5-2026-11-13T00:30:00Z-BUY");
    assert.equal(t.story.plan.profile, "solusd-5m");
    assert.equal(t.story.exit.result, "SL");
    const lp = await dash(`/api/dashboard/trade-proof?id=${t.id}`);
    assert.equal(lp.data.story.plan.ote_705, 81.3393);
    assert.ok(!JSON.stringify(lp).includes(WEBHOOK_SECRET), "the secret is never stored or shown");
    // The bot filter and the all-bot view list the legacy bot's trades from the legacy table's REAL columns
    // (entry_qty / entry_avg_price / exit_avg_price), with its trades.id for the proof page and chart.
    const leg = await dash("/api/dashboard/bot-trades?bot=ALPHA-02");
    const lr = leg.data.trades.find((x) => x.trade_id === "ENG-SOLUSD-5-2026-11-13T00:30:00Z-BUY");
    assert.ok(lr, `legacy trade listed for ALPHA-02: ${JSON.stringify(leg.data.trades.map((x) => x.trade_id))}`);
    assert.equal(lr.ledger, "legacy");
    assert.equal(lr.legacy_id, t.id);
    assert.equal(lr.proof_url, `/trades/${t.id}`);
    assert.equal(lr.status, "CLOSED");
    assert.ok(lr.qty > 0 && Number.isFinite(lr.qty), `qty ${lr.qty}`);
    assert.ok(lr.entry_price > 0 && lr.exit_price > 0, `prices ${lr.entry_price} → ${lr.exit_price}`);
    assert.equal(lr.net_usd, Number(t.realized_pnl));
    assert.equal(lr.story.exit.result, "SL");
    assert.equal(leg.data.page.total, leg.data.trades.length, "every ALPHA-02 trade counted once");
    const every = await dash("/api/dashboard/bot-trades");
    const ids = every.data.trades.map((x) => `${x.ledger}:${x.trade_id}`);
    assert.equal(new Set(ids).size, ids.length, "no trade appears twice in the all-bot list");
    assert.ok(every.data.trades.some((x) => x.ledger === "legacy") && every.data.trades.some((x) => x.ledger === "bot"), "legacy and bot ledger in one list");
  });

  it("Activity presents each execution once: the fill event carries the accepted order / signal in refs; refusals stay; records unchanged", async () => {
    const BOT_OPEN = "ENG-ALPHA-01-SOLUSD-1-STORY-OPEN_LONG", LEG_BUY = "ENG-SOLUSD-5-2026-11-13T00:30:00Z-BUY";
    const refused = await order("ALPHA-01", "OPEN_LONG", { qty: 0.04, order_id: "ENG-ALPHA-01-SOLUSD-1-FEEDREFUSE-OPEN_LONG" });
    assert.equal(refused.code, "BELOW_MIN_QTY");
    let feed;
    for (let i = 0; i < 40; i++) { // events are synced after each webhook (waitUntil)
      feed = (await dash("/api/dashboard/events?limit=50")).data.items;
      if (feed.some((x) => (x.refs ?? []).includes(BOT_OPEN)) && feed.some((x) => (x.refs ?? []).includes(LEG_BUY))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const botFill = feed.find((x) => (x.refs ?? []).includes(BOT_OPEN));
    assert.ok(botFill, `bot fill event carries its order id: ${JSON.stringify(feed.map((x) => [x.id, x.refs]))}`);
    assert.equal(botFill.url, `/bots/trade/${BOT_OPEN}`);
    assert.ok(!feed.some((x) => x.id === `O${BOT_OPEN}`), "the accepted bot order is not presented a second time");
    const legFill = feed.find((x) => (x.refs ?? []).includes(LEG_BUY));
    assert.ok(legFill, "legacy fill event carries its signal id");
    const legAlert = sql(`SELECT id FROM alerts WHERE alert_id = ?`, LEG_BUY)[0];
    assert.ok(!feed.some((x) => x.id === `A${legAlert.id}`), "the accepted legacy signal is not presented a second time");
    assert.ok(feed.some((x) => x.id === "OENG-ALPHA-01-SOLUSD-1-FEEDREFUSE-OPEN_LONG" && /refused/.test(x.title)), "a refusal has no fill: always shown");
    const ids = feed.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, "no item twice");
    // canonical records untouched by the presentation
    assert.equal(sql(`SELECT status FROM bot_orders WHERE order_id = ?`, BOT_OPEN)[0].status, "ACCEPTED");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM alerts WHERE alert_id = ?`, LEG_BUY)[0].n, 1);
  });

  it("trade stories past D1's 100-parameter limit: a 200-row page answers with every story (was HTTP 500 above 50 trades)", async () => {
    for (let i = 0; i < 70; i++) {
      const id = `ENG-ALPHA-03-BTCUSD-1-P${i}-OPEN_LONG`;
      sql(`INSERT INTO bot_orders (order_id, bot_id, action, symbol, requested_qty, status, code, message, trade_id, received_at, payload_json) VALUES (?, 'ALPHA-03', 'OPEN_LONG', 'BTCUSD', 0.0001, 'ACCEPTED', 'DRY_RUN_ACCEPTED', NULL, ?, ?, ?)`,
        id, id, new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString(), JSON.stringify({ plan: { v: 1, side: "LONG", swing: { origin: 1, end: 2 }, ote_705: 1.3, order: { limit: 1.3, stop: 0.9, tp2: 2.5 } } }));
      sql(`INSERT INTO bot_positions (trade_id, bot_id, symbol, side, status, qty, entry_price, entry_fee_micro, collateral_micro, fee_model, opened_at, exit_price, exit_fee_micro, closed_at, close_order_id, gross_pnl_micro, net_pnl_micro, swept_micro)
           VALUES (?, 'ALPHA-03', 'BTCUSD', 'LONG', 'CLOSED', 0.0001, 100000, 20000, 10000000, 'ndax-flat-0.20-2026-11-12', ?, 100000, 20000, ?, ?, 40000, 0, 0)`,
        id, new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString(), new Date(Date.UTC(2026, 9, 2, 0, i, 30)).toISOString(), `${id}-CLOSE`);
    }
    const r = await fetch(`${base}/api/dashboard/bot-trades?limit=200`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200, await r.clone().text());
    const d = (await r.json()).data;
    assert.ok(d.trades.length > 50, `page of ${d.trades.length}: past the old 50-trade failure point (two story ids per trade, 100 bound parameters)`);
    assert.ok(d.trades.every((t) => t.story && Array.isArray(t.story.missing)), "every row carries its story object");
    const seeded = d.trades.filter((t) => /^ENG-ALPHA-03-BTCUSD-1-P\d+-OPEN_LONG$/.test(t.trade_id));
    assert.equal(seeded.length, 70);
    assert.ok(seeded.every((t) => t.story.plan && t.story.plan.ote_705 === 1.3), "stories found for all 70 (none dropped)");
    // pagination metadata matches the ledger, for the all-bot view and for one bot
    const nAll = sql(`SELECT COUNT(*) AS n FROM bot_positions`)[0].n + sql(`SELECT COUNT(*) AS n FROM trades WHERE source = 'ALPHA_PAPER' AND bot_id = 'ALPHA-02'`)[0].n;
    assert.equal(d.page.total, nAll);
    assert.equal(d.page.returned, d.trades.length);
    assert.equal(d.page.truncated, nAll > d.trades.length);
    assert.equal(d.page.open + d.page.closed, d.page.total);
    assert.equal(d.page.by_ledger.bot + d.page.by_ledger.legacy, d.page.total);
    const one = (await dash(`/api/dashboard/bot-trades?signal=${encodeURIComponent("ENG-ALPHA-03-BTCUSD-1-P5-OPEN_LONG")}`)).data;
    assert.deepEqual([one.page.total, one.page.returned, one.page.truncated], [1, 1, false], "metadata follows the signal filter too");
    // a legacy row keeps its numeric proof id
    const leg = d.trades.find((t) => t.ledger === "legacy");
    assert.ok(Number.isInteger(leg.legacy_id) && leg.proof_url === `/trades/${leg.legacy_id}`);
  });

  it("more than 200 closed trades: the page is bounded and says so; the fleet lifetime figures cover all of them", async () => {
    // Last test in the file: 205 closed TEST rows seeded straight into bot_positions (wallets untouched), so the Worker's
    // real paging and lifetime aggregation run over > 200 trades. Nets alternate -1.000000 / +0.500000 USD.
    const before = (await dash("/api/dashboard/bots")).data.bots.find((b) => b.bot_id === "ALPHA-04").paper.trades;
    for (let i = 0; i < 205; i++) {
      const at = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
      const net = i % 2 ? 500_000 : -1_000_000;
      sql(`INSERT INTO bot_positions (trade_id, bot_id, symbol, side, status, qty, entry_price, entry_fee_micro, collateral_micro, fee_model, opened_at, exit_price, exit_fee_micro, closed_at, close_order_id, gross_pnl_micro, net_pnl_micro, swept_micro)
           VALUES (?, 'ALPHA-04', 'BTCUSD', 'LONG', 'CLOSED', 0.0001, 100000, 20000, 10000000, 'ndax-flat-0.20-2026-11-12', ?, 100000, 20000, ?, ?, ?, ?, ?)`,
        `TEST-MANY-${i}`, at, at, `TEST-MANY-${i}-CLOSE`, net + 40_000, net, Math.max(net, 0));
    }
    const pageR = await dash("/api/dashboard/bot-trades?bot=ALPHA-04&limit=200");
    assert.equal(pageR.data.trades.length, 200);
    assert.equal(pageR.data.page.total, sql(`SELECT COUNT(*) AS n FROM bot_positions WHERE bot_id = 'ALPHA-04'`)[0].n, "total = every ALPHA-04 position (open and closed)");
    assert.equal(pageR.data.page.truncated, true);
    const fleetB = (await dash("/api/dashboard/bots")).data.bots.find((b) => b.bot_id === "ALPHA-04");
    assert.equal(fleetB.paper.trades, before + 205, "lifetime count is every closed trade, not the page");
    const dbNet = sql(`SELECT COALESCE(SUM(net_pnl_micro), 0) AS n FROM bot_positions WHERE bot_id = 'ALPHA-04' AND status = 'CLOSED'`)[0].n / 1e6;
    assert.ok(Math.abs(fleetB.paper.net_usd - dbNet) < 1e-6, `lifetime net ${fleetB.paper.net_usd} = ledger ${dbNet}`);
  });
});

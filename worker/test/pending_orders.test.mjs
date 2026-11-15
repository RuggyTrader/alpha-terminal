// Durable PAPER pending orders, limit-fill rules and reversal safety (worker/src/paper_fill.ts, bot_ledger.ts).
// Unit tests of the pure fill rules, then the routes on an isolated `wrangler dev --local` with a fresh D1.
// Candle values are TEST values (labelled); no production data.
//   node --test test/pending_orders.test.mjs

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
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const FILL_OUT = join(mkdtempSync(join(tmpdir(), "alpha-fill-")), "paper_fill.mjs");
buildSync({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "..", "src", "paper_fill.ts")], bundle: true, format: "esm", platform: "neutral", outfile: FILL_OUT, logLevel: "silent" });
const { checkStrategyFill, parseCandle, sizeAtLimit } = await import(pathToFileURL(FILL_OUT).href);

const NOW = Date.parse("2026-11-14T12:00:00Z");
const C = (t, o, h, l, c, tf = 1) => parseCandle({ t, o, h, l, c }, tf);

describe("PAPER fill rules (pure)", () => {
  it("a buy limit never fills above its limit; a gap below fills at the open (better)", () => {
    const k = C("2026-11-14T11:00:00Z", 80.5, 80.6, 79.8, 80.1);
    assert.equal(checkStrategyFill({ side: "BUY", price: 80, candle: k, limit: 80, nowMs: NOW, notBeforeMs: null }).ok, true);
    const bad = checkStrategyFill({ side: "BUY", price: 80.2, candle: k, limit: 80, nowMs: NOW, notBeforeMs: null });
    assert.equal(bad.ok, false); assert.equal(bad.code, "LIMIT_VIOLATION");
    const gap = C("2026-11-14T11:01:00Z", 79.5, 79.9, 79.4, 79.6);
    assert.equal(checkStrategyFill({ side: "BUY", price: 79.5, candle: gap, limit: 80, nowMs: NOW, notBeforeMs: null }).ok, true);
  });
  it("a sell limit never fills below its limit", () => {
    const k = C("2026-11-14T11:00:00Z", 80, 81.2, 79.9, 81);
    assert.equal(checkStrategyFill({ side: "SELL", price: 81, candle: k, limit: 81, nowMs: NOW, notBeforeMs: null }).ok, true);
    assert.equal(checkStrategyFill({ side: "SELL", price: 80.9, candle: k, limit: 81, nowMs: NOW, notBeforeMs: null }).code, "LIMIT_VIOLATION");
  });
  it("an unreached limit, a price outside the candle, an unfinished candle, or a candle from before the order: refused", () => {
    const k = C("2026-11-14T11:00:00Z", 80.5, 80.6, 80.2, 80.4);
    assert.equal(checkStrategyFill({ side: "BUY", price: 80, candle: k, limit: 80, nowMs: NOW, notBeforeMs: null }).code, "FILL_OUTSIDE_CANDLE");
    assert.equal(checkStrategyFill({ side: "BUY", price: 80.2, candle: k, limit: 80.1, nowMs: NOW, notBeforeMs: null }).code, "LIMIT_VIOLATION");
    const forming = C("2026-11-14T11:59:30Z", 80.5, 80.6, 80.2, 80.4);
    assert.equal(checkStrategyFill({ side: "BUY", price: 80.3, candle: forming, limit: 80.5, nowMs: NOW, notBeforeMs: null }).code, "FILL_FROM_INCOMPLETE_CANDLE");
    assert.equal(checkStrategyFill({ side: "BUY", price: 80.3, candle: k, limit: 80.5, nowMs: NOW, notBeforeMs: Date.parse("2026-11-14T11:01:00Z") }).code, "FILL_BEFORE_ORDER");
    assert.equal(checkStrategyFill({ side: "BUY", price: 80.3, candle: null, limit: 80.5, nowMs: NOW, notBeforeMs: null }).code, "FILL_EVIDENCE_INVALID");
  });
  it("reduce-to-fit: risk first, then the bot's own wallet; refused only when even the minimum is unaffordable", () => {
    const base = { side: "LONG", limit: 80, stop: 79, feeRatePct: 0.2, minQty: 0.05, minNotional: 0.5, decimals: 8 };
    const a = sizeAtLimit({ ...base, requestedQty: 5, riskUsd: 2, availableUsd: 1000 });
    assert.equal(a.ok, true); assert.equal(a.qty, 2); assert.match(a.reduced, /stop risk/);
    const b = sizeAtLimit({ ...base, requestedQty: 2, riskUsd: 2, availableUsd: 50 });
    assert.equal(b.ok, true); assert.ok(b.qty < 2 && b.qty * 80 * 1.002 <= 50); assert.match(b.reduced, /available/);
    const c = sizeAtLimit({ ...base, requestedQty: 2, riskUsd: 2, availableUsd: 3 });
    assert.equal(c.ok, false); assert.equal(c.code, "INSUFFICIENT_BOT_CAPITAL");
    const s = sizeAtLimit({ ...base, side: "SHORT", stop: 81, requestedQty: 1, riskUsd: 10, availableUsd: 1000 });
    assert.equal(s.ok, true); assert.equal(s.collateralUsd, 80, "SHORT collateral = qty × limit");
  });
});

const KRAKEN = await startKrakenStub({ sol: 80 });
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
const PORT = 8839;
const base = `http://127.0.0.1:${PORT}`;
let worker, persist, cookie;
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
const send = (action, o = {}) => fetch(`${base}/webhook/bot-order`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: "ALPHA-01", order_id: o.order_id ?? `ENG-ALPHA-01-SOLUSD-1-T${++n}-${action}`, action, symbol: "SOLUSD", timeframe: "1", ...o }),
}).then(async (r) => ({ http: r.status, ...(await r.json()) }));
const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: secret(), ...body, passphrase: DASHBOARD_PASSPHRASE }) }).then((r) => r.json());
const min = (iso, m) => new Date(Date.parse(iso) + m * 60_000).toISOString();
const T0 = new Date(Math.floor((Date.now() - 3 * 3600_000) / 60_000) * 60_000).toISOString(); // a past minute (TEST)

before(async () => {
  persist = mkdtempSync(join(tmpdir(), "alpha-pending-"));
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  sql(`UPDATE bots SET status = 'ACTIVE' WHERE bot_id = 'ALPHA-01'`);
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 120000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  await act("fund", { action: "deposit", amount_usd: 100 });
  await act("allocate", { group: "SOLANA", amount_usd: 40 }); // TEST: ALPHA-01 $20
});
after(async () => {
  try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ }
  await KRAKEN.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

describe("durable pending orders and reversal safety (TEST values, isolated D1)", () => {
  it("an affordable LONG and an affordable SHORT are accepted as PENDING with planned figures; a new order replaces the old", async () => {
    const L = await send("PLACE_LIMIT", { order_id: "ENG-ALPHA-01-T-PL1", side: "LONG", limit: 80, stop: 79.9, tp: 80.3, qty: 0.2, placed_at: T0, expires_at: min(T0, 120) });
    assert.equal(L.code, "ORDER_PENDING"); assert.equal(L.data.accepted_qty, 0.2); assert.equal(L.data.collateral_usd, 16); assert.ok(Math.abs(L.data.actual_risk_usd - 0.02) < 1e-9);
    const S = await send("PLACE_LIMIT", { order_id: "ENG-ALPHA-01-T-PS1", side: "SHORT", limit: 80, stop: 80.1, tp: 79.7, qty: 0.2, placed_at: T0 });
    assert.equal(S.code, "ORDER_PENDING");
    assert.equal(sql(`SELECT status FROM bot_pending_orders WHERE order_id = 'ENG-ALPHA-01-T-PL1'`)[0].status, "REPLACED");
    assert.equal(sql(`SELECT COUNT(*) n FROM bot_pending_orders WHERE status = 'PENDING'`)[0].n, 1);
    assert.equal((await send("PLACE_LIMIT", { order_id: "ENG-ALPHA-01-T-PS1", side: "SHORT", limit: 80, stop: 80.1, tp: 79.7, qty: 0.2, placed_at: T0 })).code, "DUPLICATE", "idempotent");
  });

  it("genuinely unaffordable LONG and SHORT orders are rejected with the reason; an oversized one is reduced to fit", async () => {
    const big = await send("PLACE_LIMIT", { side: "LONG", limit: 80, stop: 70, tp: 90, qty: 1, placed_at: T0 });
    assert.equal(big.code, "ORDER_PENDING"); assert.ok(big.data.accepted_qty < 1 && big.data.accepted_qty * 80 * 1.002 <= 20); assert.match(big.data.message, /fit/);
    const x = await send("PLACE_LIMIT", { side: "LONG", limit: 80000, stop: 79000, tp: 82000, qty: 0.001, placed_at: T0 });
    assert.equal(x.code, "INSUFFICIENT_BOT_CAPITAL");
    const y = await send("PLACE_LIMIT", { side: "SHORT", limit: 80000, stop: 81000, tp: 78000, qty: 0.001, placed_at: T0 });
    assert.equal(y.code, "INSUFFICIENT_BOT_CAPITAL");
    assert.equal(sql(`SELECT status FROM bot_pending_orders WHERE order_id = ?`, y.order_id)[0].status, "REJECTED", "the refusal is recorded");
    const bad = await send("PLACE_LIMIT", { side: "SHORT", limit: 80, stop: 79, tp: 79.5, qty: 0.1, placed_at: T0 });
    assert.equal(bad.code, "INVALID_LEVELS");
  });

  it("a SHORT pending order fills only on a candle after it, at or above its limit; then closes at its target", async () => {
    const P = await send("PLACE_LIMIT", { order_id: "ENG-ALPHA-01-T-PS2", side: "SHORT", limit: 80, stop: 80.2, tp: 79.6, qty: 0.25, placed_at: min(T0, 1) });
    assert.equal(P.code, "ORDER_PENDING");
    const early = await send("OPEN_SHORT", { pending_order_id: "ENG-ALPHA-01-T-PS2", qty: 0.25, fill: { price: 80, candle: { t: T0, o: 79.9, h: 80.05, l: 79.8, c: 80 } } });
    assert.equal(early.code, "FILL_BEFORE_ORDER");
    const below = await send("OPEN_SHORT", { pending_order_id: "ENG-ALPHA-01-T-PS2", qty: 0.25, fill: { price: 79.95, candle: { t: min(T0, 1), o: 79.9, h: 80.05, l: 79.8, c: 80 } } });
    assert.equal(below.code, "LIMIT_VIOLATION");
    const ok = await send("OPEN_SHORT", { order_id: "ENG-ALPHA-01-T-OS2", pending_order_id: "ENG-ALPHA-01-T-PS2", qty: 0.25, stop: 80.2, tp: 79.6, fill: { price: 80, candle: { t: min(T0, 2), o: 79.9, h: 80.05, l: 79.8, c: 80 } } });
    assert.equal(ok.code, "DRY_RUN_ACCEPTED"); assert.equal(ok.data.price, 80); assert.equal(ok.data.side, "SHORT");
    assert.equal(sql(`SELECT status, fill_trade_id FROM bot_pending_orders WHERE order_id = 'ENG-ALPHA-01-T-PS2'`)[0].fill_trade_id, "ENG-ALPHA-01-T-OS2");
    const again = await send("OPEN_SHORT", { pending_order_id: "ENG-ALPHA-01-T-PS2", qty: 0.25, fill: { price: 80, candle: { t: min(T0, 2), o: 79.9, h: 80.05, l: 79.8, c: 80 } } });
    assert.equal(again.code, "PENDING_ORDER_NOT_ACTIVE", "the same pending order never fills twice");
    // Reversal safety: an opposite entry while the SHORT is open is refused; a CLOSE naming another position too.
    assert.equal((await send("OPEN_LONG", { qty: 0.1 })).code, "POSITION_ALREADY_OPEN");
    assert.equal((await send("CLOSE", { entry_order_id: "ENG-ALPHA-01-NOT-THIS", fill: { price: 79.6, kind: "TP", candle: { t: min(T0, 3), o: 79.7, h: 79.75, l: 79.5, c: 79.55 } } })).code, "POSITION_MISMATCH");
    const tpBad = await send("CLOSE", { entry_order_id: "ENG-ALPHA-01-T-OS2", fill: { price: 79.7, kind: "TP", candle: { t: min(T0, 3), o: 79.7, h: 79.75, l: 79.5, c: 79.55 } } });
    assert.equal(tpBad.code, "LIMIT_VIOLATION", "a SHORT's take-profit (buy limit 79.6) cannot fill above 79.6");
    const cl = await send("CLOSE", { order_id: "ENG-ALPHA-01-T-CS2", entry_order_id: "ENG-ALPHA-01-T-OS2", fill: { price: 79.6, kind: "TP", candle: { t: min(T0, 3), o: 79.7, h: 79.75, l: 79.5, c: 79.55 } } });
    assert.equal(cl.code, "DRY_RUN_ACCEPTED");
    const q = ok.data.qty; // after reduce-to-fit to the bot's dollar risk (ok.data.requested_qty 0.25)
    assert.ok(q > 0 && q <= 0.25 && ok.data.requested_qty === 0.25);
    assert.ok(Math.abs(cl.data.gross_usd - (80 - 79.6) * q) < 1e-6, "SHORT gross = (entry − exit) × qty");
    assert.ok(Math.abs(cl.data.fees_usd - (q * 80 + q * 79.6) * 0.002) < 2e-6, "0.20% on each fill");
    assert.ok(Math.abs(cl.data.net_usd - (cl.data.gross_usd - cl.data.fees_usd)) < 2e-6);
  });

  it("reversal SHORT → LONG: only after the close is confirmed, as an independent new position", async () => {
    const P = await send("PLACE_LIMIT", { order_id: "ENG-ALPHA-01-T-PL3", side: "LONG", limit: 80, stop: 79.8, tp: 80.4, qty: 0.2, placed_at: min(T0, 4) });
    assert.equal(P.code, "ORDER_PENDING");
    const o = await send("OPEN_LONG", { order_id: "ENG-ALPHA-01-T-OL3", pending_order_id: "ENG-ALPHA-01-T-PL3", qty: 0.2, stop: 79.8, tp: 80.4, fill: { price: 80, candle: { t: min(T0, 5), o: 80.1, h: 80.2, l: 79.95, c: 80.1 } } });
    assert.equal(o.code, "DRY_RUN_ACCEPTED");
    const sl = await send("CLOSE", { order_id: "ENG-ALPHA-01-T-CL3", entry_order_id: "ENG-ALPHA-01-T-OL3", fill: { price: 79.8, kind: "SL", candle: { t: min(T0, 6), o: 80, h: 80.05, l: 79.7, c: 79.75 } } });
    assert.equal(sl.code, "DRY_RUN_ACCEPTED"); assert.ok(sl.data.net_usd < 0, "a losing LONG settles");
    const pos = sql(`SELECT trade_id, side, status FROM bot_positions WHERE bot_id = 'ALPHA-01' ORDER BY id`);
    assert.deepEqual(pos.map((p) => [p.side, p.status]), [["SHORT", "CLOSED"], ["LONG", "CLOSED"]]);
  });

  it("cancel and expire are explicit and idempotent", async () => {
    await send("PLACE_LIMIT", { order_id: "ENG-ALPHA-01-T-PL4", side: "LONG", limit: 80, stop: 79.8, tp: 80.4, qty: 0.2, placed_at: min(T0, 7) });
    const c = await send("CANCEL_ORDER", { target_order_id: "ENG-ALPHA-01-T-PL4", reason_code: "EXPIRED", reason: "the setup expired (strategy maxAge)" });
    assert.equal(c.code, "ORDER_EXPIRED");
    assert.equal((await send("CANCEL_ORDER", { target_order_id: "ENG-ALPHA-01-T-PL4" })).code, "ORDER_ALREADY_FINAL");
    assert.equal((await send("OPEN_LONG", { pending_order_id: "ENG-ALPHA-01-T-PL4", qty: 0.2, fill: { price: 80, candle: { t: min(T0, 8), o: 80.1, h: 80.2, l: 79.9, c: 80 } } })).code, "PENDING_ORDER_NOT_ACTIVE");
  });

  it("stage S1: ALPHA-02 moves from the long-only legacy ledger to the bot ledger only when flat; then SHORTs execute and the legacy route refuses it", async () => {
    const legacy = (id, action, qty) => fetch(`${base}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, id, symbol: "SOLUSD", timeframe: "5", action, strategy: "OTE", ...(qty ? { qty } : {}), timestamp: T0 }) }).then(async (r) => ({ http: r.status, ...(await r.json()) }));
    const sell = await legacy("ENG-SOLUSD-5-2026-11-14T20:00:00Z-SELL", "sell", 0.1);
    assert.equal(sell.code, "NO_POSITION", "before S1: a SELL entry is read as closing a LONG (the documented production refusal)");
    const buy = await legacy("ENG-SOLUSD-5-2026-11-14T20:05:00Z-BUY", "buy", 0.1);
    assert.equal(buy.code, "DRY_RUN_ACCEPTED");
    const blocked = await act("bot-ledger", { bot_id: "ALPHA-02", ledger: "bot" });
    assert.equal(blocked.code, "POSITION_OPEN", "never switched with an open legacy position");
    assert.equal((await legacy("ENG-SOLUSD-5-2026-11-14T20:10:00Z-CLOSE", "close")).code, "DRY_RUN_ACCEPTED");
    const sw = await act("bot-ledger", { bot_id: "ALPHA-02", ledger: "bot" });
    assert.equal(sw.ok, true); assert.equal(sw.ledger_api, "bot");
    const after = await legacy("ENG-SOLUSD-5-2026-11-14T20:15:00Z-BUY", "buy", 0.1);
    assert.equal(after.code, "BOT_LEDGER_PATH", "one route only: the legacy route refuses it now");
    const o = (action, x) => fetch(`${base}/webhook/bot-order`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: "ALPHA-02", action, symbol: "SOLUSD", timeframe: "5", ...x }) }).then((r) => r.json());
    const p = await o("PLACE_LIMIT", { order_id: "ENG-SOLUSD-5-T-PLACE_SHORT", side: "SHORT", limit: 80, stop: 80.2, tp: 79.6, qty: 0.1, placed_at: min(T0, 10) });
    assert.equal(p.code, "ORDER_PENDING");
    const f = await o("OPEN_SHORT", { order_id: "ENG-SOLUSD-5-T-OPEN_SHORT", pending_order_id: "ENG-SOLUSD-5-T-PLACE_SHORT", qty: 0.1, fill: { price: 80, candle: { t: min(T0, 15), o: 79.95, h: 80.1, l: 79.9, c: 80 } } });
    assert.equal(f.code, "DRY_RUN_ACCEPTED"); assert.equal(f.data.side, "SHORT");
    assert.equal(sql(`SELECT side FROM bot_positions WHERE trade_id = 'ENG-SOLUSD-5-T-OPEN_SHORT' AND status = 'OPEN'`)[0].side, "SHORT");
    assert.ok(sql(`SELECT reserved_micro r FROM portfolio_wallets WHERE wallet = 'SOLUSD'`)[0].r > 0, "collateral reserved in ALPHA-02's own (SOLUSD) wallet");
    // Regression (production, 2026-11-15): history from BEFORE the switch must stay in the bot's views and lifetime figures.
    const dashGet = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } }).then((r) => r.json());
    const hist = await dashGet("/api/dashboard/bot-trades?bot=ALPHA-02&limit=50");
    assert.ok(hist.data.trades.some((t) => t.ledger === "legacy" && t.trade_id === "ENG-SOLUSD-5-2026-11-14T20:05:00Z-BUY"), "the pre-switch legacy trade is still listed");
    const all = await dashGet("/api/dashboard/bot-trades?limit=50");
    assert.ok(all.data.trades.some((t) => t.ledger === "legacy"), "and in the all-bot history");
    const fleet = await dashGet("/api/dashboard/bots");
    assert.equal(fleet.data.bots.find((b) => b.bot_id === "ALPHA-02").paper.trades, sql(`SELECT COUNT(*) n FROM trades WHERE bot_id = 'ALPHA-02' AND source = 'ALPHA_PAPER'`)[0].n + sql(`SELECT COUNT(*) n FROM bot_positions WHERE bot_id = 'ALPHA-02' AND status = 'CLOSED'`)[0].n, "lifetime closed trades = legacy + bot ledger, each once");
  });

  it("stage D: a PROPOSED bot is activated by the owner action only (profile kept), idempotently", async () => {
    sql(`UPDATE bots SET status = 'PROPOSED' WHERE bot_id = 'ALPHA-04'`);
    const r = await act("bot-activate", { bot_id: "ALPHA-04" });
    assert.equal(r.ok, true); assert.equal(r.status, "ACTIVE"); assert.equal(r.inputs_hash, "a6336dad6ffaed70"); assert.equal(r.ledger_api, "bot");
    assert.equal((await act("bot-activate", { bot_id: "ALPHA-04" })).duplicate, true);
    assert.equal(sql(`SELECT status FROM bots WHERE bot_id = 'ALPHA-04'`)[0].status, "ACTIVE");
    const noPass = await fetch(`${base}/api/paper/bot-activate`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: secret(), bot_id: "ALPHA-03" }) });
    assert.ok(noPass.status >= 400, "the passphrase is required");
    assert.equal(sql(`SELECT status FROM bots WHERE bot_id = 'ALPHA-03'`)[0].status, "PROPOSED");
  });

  it("allocation to ONE active bot moves the exact amount into its own wallet (a transfer, not profit); preview first", async () => {
    const before = sql(`SELECT wallet, available_micro a, realized_pnl_micro p FROM portfolio_wallets WHERE wallet IN ('MAIN', 'ALPHA-01') ORDER BY wallet`);
    const pv = await fetch(`${base}/api/dashboard/allocation-preview?group=ALPHA-01&amount=3.33`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert.deepEqual(pv.data.split.map((s) => [s.bot_id, s.amount_usd]), [["ALPHA-01", 3.33]]);
    const r = await act("allocate", { group: "ALPHA-01", amount_usd: 3.33 });
    assert.equal(r.ok, true);
    const after = sql(`SELECT wallet, available_micro a, realized_pnl_micro p FROM portfolio_wallets WHERE wallet IN ('MAIN', 'ALPHA-01') ORDER BY wallet`);
    assert.equal(after[0].a - before[0].a, 3_330_000); assert.equal(before[1].a - after[1].a, 3_330_000);
    assert.equal(after[0].p, before[0].p, "no profit recorded"); assert.equal(after[1].p, before[1].p);
    assert.equal(sql(`SELECT group_id FROM allocation_events ORDER BY id DESC LIMIT 1`)[0].group_id, "SOLANA");
    assert.equal((await act("allocate", { group: "ALPHA-03", amount_usd: 1 })).code, "NO_ACTIVE_BOTS", "a PROPOSED bot cannot receive capital");
  });

  it("fleet setup (one passphrase): activates every PROPOSED bot and tops each wallet up to the target, all or nothing, idempotent", async () => {
    sql(`UPDATE bots SET status = 'PROPOSED' WHERE bot_id IN ('ALPHA-01', 'ALPHA-03')`);
    const value = () => Object.fromEntries(sql(`SELECT b.bot_id id, w.available_micro + w.reserved_micro v FROM bots b JOIN portfolio_wallets w ON w.wallet = b.wallet`).map((r) => [r.id, r.v]));
    const main = () => sql(`SELECT available_micro a, realized_pnl_micro p FROM portfolio_wallets WHERE wallet = 'MAIN'`)[0];
    const m0 = main(), v0 = value();
    // More than MAIN holds: NOTHING changes (no activation either).
    const big = await act("fleet-setup", { target_usd: 1_000_000 });
    assert.equal(big.code, "INSUFFICIENT_MAIN");
    assert.equal(sql(`SELECT status FROM bots WHERE bot_id = 'ALPHA-03'`)[0].status, "PROPOSED");
    assert.deepEqual(value(), v0); assert.equal(main().a, m0.a);
    // A target MAIN can cover.
    const target = Math.max(...Object.values(v0)) / 1e6 + 1.25;
    const r = await act("fleet-setup", { target_usd: Math.round(target * 100) / 100 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.activated.sort(), ["ALPHA-01", "ALPHA-03"]);
    assert.equal(sql(`SELECT COUNT(*) n FROM bots WHERE status = 'ACTIVE'`)[0].n, 4);
    const tm = Math.round(r.target_usd * 1e6), v1 = value();
    for (const id of Object.keys(v1)) assert.equal(v1[id], Math.max(v0[id], tm), `${id} topped up to exactly the target`);
    const moved = Object.keys(v1).reduce((s, id) => s + v1[id] - v0[id], 0);
    assert.equal(m0.a - main().a, moved, "MAIN paid exactly what the bots received");
    assert.equal(main().p, m0.p, "a transfer, never profit");
    assert.equal(Math.round(r.total_usd * 1e6), moved);
    // Again (new request): everyone is at the target, so nothing moves. Same request id: duplicate.
    const again = await act("fleet-setup", { target_usd: r.target_usd });
    assert.equal(again.ok, true); assert.equal(again.total_usd, 0); assert.deepEqual(value(), v1);
    const noPass = await fetch(`${base}/api/paper/fleet-setup`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: secret(), target_usd: 50 }) });
    assert.ok(noPass.status >= 400, "the passphrase is required");
    assert.deepEqual(value(), v1);
  });
});

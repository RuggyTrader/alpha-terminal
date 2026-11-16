// DEMO / HISTORICAL REPLAY — the complete PAPER trading lifecycle, end to end, on an isolated local Worker and a
// fresh D1 (never production):
//   the REAL engine (engine/src/runner.mjs, bot ALPHA-01, its registered profile, hash unchanged)
//   replays RECORDED Kraken SOLUSD 1m candles (10–12 Nov 2026, engine/test/fixtures) one completed candle at a time
//   → durable pending limit orders (PLACE_LIMIT / CANCEL_ORDER) → validated limit fills (OPEN_LONG / OPEN_SHORT)
//   → exits (CLOSE with the strategy's fill) → collateral release, Ndax-equivalent fees, settlement, MAIN sweeps.
// The engine is restarted in the middle (a new runner from the same saved state) while an order is pending.
// Orders are the strategy's own; prices are the recorded candles. Nothing here is a production trade.
//   node --test test/engine_lifecycle.test.mjs

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "./lib/kraken-stub.mjs";
import { assertPortFree } from "./lib/port-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(HERE, "..");
const ENGINE_DIR = join(WORKER_DIR, "..", "engine");
const { loadBotConfigs } = await import(new URL(`file:///${join(ENGINE_DIR, "src", "config.mjs").replace(/\\/g, "/")}`).href);
const { EngineRunner, inputsHash } = await import(new URL(`file:///${join(ENGINE_DIR, "src", "runner.mjs").replace(/\\/g, "/")}`).href);
const SOL1 = JSON.parse(readFileSync(join(ENGINE_DIR, "test", "fixtures", "SOLUSD-1m-2026-11-10_2026-11-12.json"), "utf8")).candles;

const KRAKEN = await startKrakenStub({ sol: SOL1.at(-1).c });
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
const PORT = 8837;
const base = `http://127.0.0.1:${PORT}`;
let worker, persist, cookie;
const temps = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };

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
const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: secret(), ...body, passphrase: DASHBOARD_PASSPHRASE }) }).then((r) => r.json());
const dash = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } }).then((r) => r.json());
const W = (w) => sql(`SELECT available_micro a, reserved_micro r, realized_pnl_micro p, fees_micro f, net_funding_micro n, shortfall_micro s FROM portfolio_wallets WHERE wallet = ?`, w)[0];

let run; // results of the replay
before(async () => {
  persist = tmp("alpha-lifecycle-");
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  sql(`UPDATE bots SET status = 'ACTIVE' WHERE bot_id = 'ALPHA-01'`); // DEMO activation (production: owner approval)
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  assertPortFree(PORT, PORT + 600); // never test against a server this test did not start
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 120000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  await act("fund", { action: "deposit", amount_usd: 100 });
  await act("allocate", { group: "SOLANA", amount_usd: 100 }); // DEMO: ALPHA-01 and ALPHA-02 get $50 each

  // ---- the replay: one completed candle per tick, a restart while an order is pending
  const dataDir = tmp("alpha-lifecycle-engine-");
  const env = { ENGINE_ENV_FILE: "none", ENGINE_DATA_DIR: dataDir, ENGINE_SYNC: "on", ALPHA_API_BASE: base, ALPHA_WEBHOOK_SECRET: WEBHOOK_SECRET, ENGINE_MIRROR: "off" };
  const [{ cfg }] = loadBotConfigs(["ALPHA-01"], env, ENGINE_DIR, { allowProposed: true });
  const sent = [];
  const http = async (url, init) => {
    const r = await fetch(url, init);
    if (String(url).endsWith("/webhook/bot-order")) { const b = JSON.parse(init.body); const j = await r.clone().json(); sent.push({ action: b.action, id: b.order_id, code: j.code, body: b, res: j }); }
    return r;
  };
  const clock = { now: 0 };
  const deps = { fetchCandles: async ({ sinceMs }) => SOL1.filter((k) => k.t + 60_000 <= clock.now && (sinceMs === null || k.t > sinceMs)), http, now: () => clock.now, log: () => {} };
  let r = new EngineRunner(cfg, deps);
  const WARM = 300;
  clock.now = SOL1[WARM].t + 65_000; await r.tick();
  let restarted = null;
  for (let i = WARM + 1; i < SOL1.length; i++) {
    clock.now = SOL1[i].t + 65_000;
    await r.tick();
    if (!restarted && r.state.liveOrder && sent.some((s) => s.id === r.state.liveOrder.id && s.code === "ORDER_PENDING")) {
      // Restart: a NEW runner from the saved state on disk, exactly as after a crash or reboot.
      const before = { liveOrder: r.state.liveOrder, sentCount: sent.length };
      r = new EngineRunner(cfg, deps);
      restarted = { at: i, before, after: r.state.liveOrder };
    }
  }
  run = { sent, restarted, state: r.state, hash: inputsHash(cfg), cfg };
});
after(async () => {
  try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ }
  await KRAKEN.close();
  for (const t of temps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* locked on Windows */ } }
});

describe("DEMO historical replay: engine → durable pending orders → PAPER ledger (ALPHA-01, recorded Kraken SOL 1m)", () => {
  it("the original profile is used unchanged", () => {
    assert.equal(run.hash, "0932a1a0cfac03f9");
    assert.equal(sql(`SELECT inputs_hash FROM bots WHERE bot_id = 'ALPHA-01'`)[0].inputs_hash, "0932a1a0cfac03f9");
  });

  it("executes BOTH directions through real limit orders: LONG and SHORT positions opened and closed", () => {
    const pos = sql(`SELECT * FROM bot_positions WHERE bot_id = 'ALPHA-01' ORDER BY id`);
    const sides = new Set(pos.map((p) => p.side));
    assert.ok(sides.has("LONG"), "a LONG executed");
    assert.ok(sides.has("SHORT"), "a SHORT executed (simulated, fully collateralised)");
    assert.ok(pos.filter((p) => p.status === "CLOSED").length >= 2);
  });

  it("every fill respects its limit, lies inside its completed candle, and fills a recorded pending order", () => {
    const pos = sql(`SELECT p.*, o.limit_price, o.status ostatus, o.placed_at FROM bot_positions p JOIN bot_pending_orders o ON o.fill_trade_id = p.trade_id WHERE p.bot_id = 'ALPHA-01'`);
    assert.equal(pos.length, sql(`SELECT COUNT(*) n FROM bot_positions WHERE bot_id = 'ALPHA-01'`)[0].n, "no position without its pending order");
    for (const p of pos) {
      assert.equal(p.ostatus, "FILLED");
      if (p.side === "LONG") assert.ok(p.entry_price <= p.limit_price + 1e-9, `buy limit ${p.limit_price} filled at ${p.entry_price}`);
      else assert.ok(p.entry_price >= p.limit_price - 1e-9, `sell limit ${p.limit_price} filled at ${p.entry_price}`);
      const f = sql(`SELECT * FROM bot_fills WHERE trade_id = ? AND kind = 'ENTRY'`, p.trade_id)[0];
      assert.match(f.price_source, /^PAPER_LIMIT_FILL/);
      const k = SOL1.find((c) => new Date(c.t + 60_000).toISOString() === f.price_at);
      assert.ok(k, "the fill names a recorded candle");
      assert.ok(k.t >= Date.parse(p.placed_at), "the candle opened after the order was placed (no earlier data)");
      assert.ok(p.entry_price >= k.l && p.entry_price <= k.h);
    }
  });

  it("every pending order has exactly one explicit outcome; at most one is PENDING", () => {
    const os = sql(`SELECT status, COUNT(*) n FROM bot_pending_orders WHERE bot_id = 'ALPHA-01' GROUP BY status`);
    const by = Object.fromEntries(os.map((o) => [o.status, o.n]));
    assert.ok((by.FILLED ?? 0) >= 2);
    assert.ok((by.PENDING ?? 0) <= 1);
    for (const s of Object.keys(by)) assert.ok(["PENDING", "FILLED", "CANCELLED", "EXPIRED", "REPLACED", "REJECTED"].includes(s));
    const engineOrders = run.state.outbox.filter((x) => x.kind === "ORDER" || x.kind === "ENTRY" || x.kind === "EXIT");
    for (const x of engineOrders) assert.ok(["accepted", "rejected", "skipped"].includes(x.status) || x.status === "historical", `${x.id} ${x.status}`);
  });

  it("the pending order survived a restart: same order, never placed twice, and it still filled or ended explicitly", () => {
    assert.ok(run.restarted, "an order was pending when the engine restarted");
    assert.deepEqual(run.restarted.after, run.restarted.before.liveOrder, "the new runner resumed the same live order from disk");
    const id = run.restarted.before.liveOrder.id;
    assert.equal(run.sent.filter((s) => s.id === id && s.code === "ORDER_PENDING").length, 1, "placed once");
    const row = sql(`SELECT status FROM bot_pending_orders WHERE order_id = ?`, id)[0];
    assert.ok(row && row.status !== "PENDING" || run.state.liveOrder?.id === id, `ends explicitly (${row?.status})`);
  });

  it("no duplicate fills, fees or MAIN sweeps; collateral released; the wallet reconciles to the micro-dollar", () => {
    const fills = sql(`SELECT trade_id, kind, COUNT(*) n FROM bot_fills WHERE bot_id = 'ALPHA-01' GROUP BY trade_id, kind`);
    for (const f of fills) assert.equal(f.n, 1, `${f.trade_id} ${f.kind}`);
    const closed = sql(`SELECT * FROM bot_positions WHERE bot_id = 'ALPHA-01' AND status = 'CLOSED'`);
    for (const p of closed) {
      const fe = sql(`SELECT SUM(fee_micro) f FROM bot_fills WHERE trade_id = ?`, p.trade_id)[0].f;
      assert.equal(fe, p.entry_fee_micro + p.exit_fee_micro, "fees: one per fill");
      const gross = p.side === "LONG" ? Math.round(p.qty * p.exit_price * 1e6) - p.collateral_micro : p.collateral_micro - Math.round(p.qty * p.exit_price * 1e6);
      assert.ok(Math.abs(gross - p.gross_pnl_micro) <= 1, "gross = direction-specific price difference × qty");
      assert.equal(p.net_pnl_micro, p.gross_pnl_micro - p.entry_fee_micro - p.exit_fee_micro);
      assert.equal(p.swept_micro, Math.max(0, p.net_pnl_micro));
      assert.equal(sql(`SELECT COUNT(*) n FROM portfolio_entries WHERE entry_key = ?`, `SWEEP:${p.trade_id}:OUT`)[0].n, p.swept_micro > 0 ? 1 : 0, "one sweep at most");
    }
    const open = sql(`SELECT COALESCE(SUM(collateral_micro), 0) c, COALESCE(SUM(entry_fee_micro), 0) f FROM bot_positions WHERE bot_id = 'ALPHA-01' AND status = 'OPEN'`)[0];
    const w = W("ALPHA-01");
    assert.equal(w.r, open.c, "reserved = the open position's collateral only (closed ones released)");
    const netClosed = closed.reduce((a, p) => a + p.net_pnl_micro - p.swept_micro, 0);
    assert.equal(w.a + w.r, 50_000_000 + netClosed - open.f, "available + reserved = allocation + net results − sweeps − open entry fee");
    assert.equal(W("MAIN").a, closed.reduce((a, p) => a + p.swept_micro, 0), "MAIN received exactly the swept profits");
  });

  it("evidence (written when EVIDENCE_OUT is set): every order, fill and position of the replay", () => {
    if (!process.env.EVIDENCE_OUT) return;
    const positions = sql(`SELECT p.trade_id, p.side, p.qty, o.requested_qty, o.limit_price AS planned_limit, p.entry_price, p.stop, p.tp, p.exit_price,
        (SELECT price_source FROM bot_fills f WHERE f.trade_id = p.trade_id AND f.kind = 'ENTRY') AS entry_source,
        (SELECT price_at FROM bot_fills f WHERE f.trade_id = p.trade_id AND f.kind = 'ENTRY') AS entry_candle_close,
        (SELECT price_source FROM bot_fills f WHERE f.trade_id = p.trade_id AND f.kind = 'EXIT') AS exit_source,
        p.collateral_micro / 1e6 AS collateral_usd, (p.entry_fee_micro + COALESCE(p.exit_fee_micro, 0)) / 1e6 AS fees_usd,
        p.gross_pnl_micro / 1e6 AS gross_usd, p.net_pnl_micro / 1e6 AS net_usd, p.swept_micro / 1e6 AS swept_to_main_usd, p.status
      FROM bot_positions p LEFT JOIN bot_pending_orders o ON o.fill_trade_id = p.trade_id WHERE p.bot_id = 'ALPHA-01' ORDER BY p.id`);
    const orders = sql(`SELECT status, COUNT(*) n FROM bot_pending_orders WHERE bot_id = 'ALPHA-01' GROUP BY status`);
    const w = W("ALPHA-01"), m = W("MAIN");
    writeFileSync(process.env.EVIDENCE_OUT, JSON.stringify({
      label: "DEMO / HISTORICAL REPLAY: the real engine (ALPHA-01, profile hash 0932a1a0cfac03f9) on recorded Kraken SOLUSD 1m candles 10–12 Nov 2026 against a local Worker and a fresh D1. Not production.",
      generated_at: new Date().toISOString(), allocation_usd: 50, restart: run.restarted ? { at_candle_index: run.restarted.at, live_order: run.restarted.before.liveOrder } : null,
      pending_orders_by_status: Object.fromEntries(orders.map((o) => [o.status, o.n])), positions,
      wallet_after: { available_usd: w.a / 1e6, reserved_usd: w.r / 1e6, fees_usd: w.f / 1e6 }, main_received_usd: m.a / 1e6,
    }, null, 1));
  });

  it("the dashboard shows the durable orders and the executed trades (no hypothetical rows)", async () => {
    const o = await dash("/api/dashboard/bot-orders?bot=ALPHA-01&limit=200");
    assert.equal(o.data.installed, true);
    assert.ok(o.data.orders.some((x) => x.status === "FILLED" && x.side === "SHORT"));
    const t = await dash("/api/dashboard/bot-trades?bot=ALPHA-01&limit=200");
    const rows = t.data.trades ?? t.data.rows ?? t.data;
    assert.ok(Array.isArray(rows) && rows.length >= 2);
  });
});

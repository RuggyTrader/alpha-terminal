// SCHEMA-7 MIGRATION REHEARSAL (LOCAL, representative fixture; never production data).
//
//   node tools/migration-rehearsal.mjs [--out <file.json>]
//
// 1. A fresh local D1 at production's schema 6 (migrations 0001–0006 only) and THIS Worker build.
// 2. Production-shaped history created through the Worker's real routes (labelled DEMO): PAPER capital deposited and
//    moved to the SOLUSD strategy balance; a legacy ALPHA-02 LONG opened and closed (like production trade #1);
//    legacy SELL entries refused NO_POSITION and an unaffordable BUY refused (like production's 11 Nov alerts).
// 3. A full snapshot of every table, the wallets and the dashboard's history/performance answers.
// 4. Worker stopped; migration 0007 applied exactly as production would apply it (wrangler d1 execute --file).
// 5. Verified: every pre-existing row and balance unchanged; FK check clean; schema 7; legacy trade, refusals and
//    events still served; the original profiles' hashes registered; new bot wallets empty.
// 6. The SAME Worker on the migrated D1 executes a bot-ledger SHORT through a durable pending order (place → fill →
//    close), the accounts reconcile, and the legacy history is still served unchanged.
// Representative, not a copy of production: a rehearsal on a private production export is a separate owner approval.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "../test/lib/kraken-stub.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
const s = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = s(), DASHBOARD_PASSPHRASE = s(), ADMIN_SECRET = s();
const PORT = 8851, base = `http://127.0.0.1:${PORT}`;
const wr = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 180000 });
const persist = mkdtempSync(join(tmpdir(), "alpha-rehearsal-"));
const KRAKEN = await startKrakenStub({ sol: 81.43 }); // TEST quote (the price production trade #1 filled at)
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) }); console.error(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`); };

function sql(q, ...args) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  for (let i = 0; ; i++) {
    try {
      const db = new DatabaseSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")));
      try { const st = db.prepare(q); return /^\s*(SELECT|WITH|PRAGMA)/i.test(q) ? st.all(...args).map((r) => ({ ...r })) : st.run(...args); } finally { db.close(); }
    } catch (e) {
      if (i >= 40 || !/locked|busy|disk I\/O/i.test(String(e.message))) throw e;
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},250)"]);
    }
  }
}
let worker = null, cookie = null;
async function start() {
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 120000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
}
async function stopAndSettle() { stop(); await new Promise((r) => setTimeout(r, 3000)); }
function stop() { try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ } worker = null; }
const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ http: r.status, ...(await r.json().catch(() => ({}))) }));
const get = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } }).then((r) => r.json());
const paper = (kind, body) => post(`/api/paper/${kind}`, { request_id: s(), ...body, passphrase: DASHBOARD_PASSPHRASE });
const signal = (id, action, qty) => post("/webhook/dry-run", { secret: WEBHOOK_SECRET, id, symbol: "SOLUSD", timeframe: "5", action, strategy: "OTE", ...(qty ? { qty } : {}), timestamp: id.split("-").slice(3, 6).join("-").replace(/-(BUY|SELL|CLOSE)$/, "") });
const TABLES = ["alerts", "orders", "paper_positions", "paper_fills", "trades", "portfolio_entries", "portfolio_wallets", "trade_events", "mirror_accounts", "mirror_trades", "risk_decisions"];
const dump = () => Object.fromEntries(TABLES.map((t) => {
  const exists = sql("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = ?", t)[0].n === 1;
  return [t, exists ? sql(`SELECT * FROM ${t} ORDER BY rowid`).map(({ bot_id: _b, detail_json: _d, ...r }) => r) : null];
}));

try {
  // 1. schema 6
  for (const f of readdirSync(join(DIR, "migrations")).filter((x) => /^000[1-6]_.*\.sql$/.test(x)).sort()) wr(["d1", "execute", "alpha-terminal-db", "--local", "--persist-to", persist, "--file", join("migrations", f)]);
  check("starts at schema 6 (production today)", sql(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0]?.value === "6");
  await start();
  // 2. production-shaped history (DEMO)
  const dep = await paper("fund", { action: "deposit", amount_usd: 20 });
  const tr = await paper("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 10 });
  check("DEMO capital: $20 deposited, $10 moved to the SOLUSD strategy balance", dep.ok && tr.ok, JSON.stringify([dep.code, tr.code]));
  const sellA = await signal("ENG-SOLUSD-5-2026-11-11T05:30:00Z-SELL", "sell", 42.89);
  const sellB = await signal("ENG-SOLUSD-5-2026-11-11T07:55:00Z-SELL", "sell", 27.17);
  check("legacy SELL entries refused NO_POSITION (as production 11 Nov)", sellA.code === "NO_POSITION" && sellB.code === "NO_POSITION", JSON.stringify([sellA.code, sellB.code]));
  const big = await signal("ENG-SOLUSD-5-2026-11-11T14:20:00Z-BUY", "buy", 5);
  check("unaffordable legacy BUY refused (as production 11 Nov)", big.http >= 400 || big.status === "rejected", JSON.stringify([big.http, big.code]));
  const buy = await signal("ENG-SOLUSD-5-2026-11-13T00:30:00Z-BUY", "buy", 0.12184277);
  KRAKEN.set("SOLUSD", 81.17);
  const close = await signal("ENG-SOLUSD-5-2026-11-13T00:35:00Z-CLOSE", "close");
  check("legacy LONG opened and closed (shape of production trade #1)", buy.code === "DRY_RUN_ACCEPTED" && close.code === "DRY_RUN_ACCEPTED", JSON.stringify([buy.code, close.code]));
  const tradesBefore = await get("/api/dashboard/trades?limit=50");
  const perfBefore = await get("/api/dashboard/performance");
  await stopAndSettle();
  const before = dump();
  check("history exists before the migration", before.trades.length === 1 && before.alerts.length >= 5, `trades ${before.trades.length}, alerts ${before.alerts.length}, events ${before.trade_events?.length}`);

  // 4. migrate exactly as production would
  wr(["d1", "execute", "alpha-terminal-db", "--local", "--persist-to", persist, "--file", join("migrations", "0007_bots.sql")]);
  // 5. integrity
  const after = dump();
  // Compared on the columns that existed before (0007 only ADDS columns, e.g. portfolio_wallets.shortfall_micro DEFAULT 0).
  const project = (rows, like) => rows.slice(0, like.length).map((r, i) => Object.fromEntries(Object.keys(like[i] ?? {}).map((k) => [k, r[k]])));
  for (const t of TABLES) if (before[t] !== null) check(`${t}: every pre-existing row and value unchanged`, JSON.stringify(project(after[t] ?? [], before[t])) === JSON.stringify(before[t]), `${before[t].length} rows`);
  check("added column shortfall_micro is 0 on every wallet", sql("SELECT COUNT(*) n FROM portfolio_wallets WHERE shortfall_micro <> 0")[0].n === 0);
  check("schema 7", sql(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0]?.value === "7");
  check("foreign keys consistent", sql("PRAGMA foreign_key_check").length === 0);
  check("original profiles registered with their hashes", JSON.stringify(sql("SELECT bot_id, inputs_hash, status FROM bots ORDER BY bot_id").map((r) => [r.bot_id, r.inputs_hash, r.status]))
    === JSON.stringify([["ALPHA-01", "0932a1a0cfac03f9", "PROPOSED"], ["ALPHA-02", "c826d785d58a4a39", "ACTIVE"], ["ALPHA-03", "d828caa44611ad73", "PROPOSED"], ["ALPHA-04", "a6336dad6ffaed70", "PROPOSED"]]));
  check("new bot wallets are empty (no capital created)", sql("SELECT SUM(available_micro + reserved_micro) n FROM portfolio_wallets WHERE wallet LIKE 'ALPHA-%'")[0].n === 0);
  check("no duplicate trade records", sql("SELECT COUNT(*) n FROM trades")[0].n === 1 && sql("SELECT COUNT(*) n FROM bot_positions")[0].n === 0);
  check("bot_pending_orders installed (durable pending orders)", sql("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'bot_pending_orders'")[0].n === 1);

  // 6. the same Worker on the migrated D1
  await start();
  const tradesAfter = await get("/api/dashboard/trades?limit=50");
  const perfAfter = await get("/api/dashboard/performance");
  check("legacy trade history served unchanged after the migration", JSON.stringify(tradesAfter.data?.trades ?? tradesAfter.data) === JSON.stringify(tradesBefore.data?.trades ?? tradesBefore.data));
  check("lifetime performance unchanged after the migration", JSON.stringify(perfAfter.data?.lifetime) === JSON.stringify(perfBefore.data?.lifetime), JSON.stringify(perfAfter.data?.lifetime ?? null).slice(0, 200));
  const bt = await get("/api/dashboard/bot-trades?bot=ALPHA-02&limit=50");
  check("refusals preserved and served (ALPHA-02 signals)", JSON.stringify(bt).includes("NO_POSITION"));
  // REHEARSAL activation of ALPHA-01 (production: separate owner approval) and an allocation from MAIN
  sql("UPDATE bots SET status = 'ACTIVE' WHERE bot_id = 'ALPHA-01'");
  const al = await paper("allocate", { group: "SOLANA", amount_usd: 10 });
  check("MAIN → SOLANA allocation split equally (ALPHA-01, ALPHA-02)", al.ok, JSON.stringify(al.split ?? al.code));
  const t0 = new Date(Math.floor((Date.now() - 3600_000) / 60_000) * 60_000).toISOString(), t1 = new Date(Date.parse(t0) + 60_000).toISOString(), t2 = new Date(Date.parse(t0) + 120_000).toISOString();
  const order = (action, o) => post("/webhook/bot-order", { secret: WEBHOOK_SECRET, bot_id: "ALPHA-01", action, symbol: "SOLUSD", timeframe: "1", ...o });
  const pl = await order("PLACE_LIMIT", { order_id: "REHEARSAL-ALPHA-01-PLACE_SHORT", side: "SHORT", limit: 81.2, stop: 81.3, tp: 81.0, qty: 0.05, placed_at: t0 });
  const op = await order("OPEN_SHORT", { order_id: "REHEARSAL-ALPHA-01-OPEN_SHORT", pending_order_id: "REHEARSAL-ALPHA-01-PLACE_SHORT", qty: 0.05, fill: { price: 81.2, candle: { t: t1, o: 81.15, h: 81.25, l: 81.1, c: 81.2 } } });
  const cl = await order("CLOSE", { order_id: "REHEARSAL-ALPHA-01-CLOSE", entry_order_id: "REHEARSAL-ALPHA-01-OPEN_SHORT", fill: { price: 81.0, kind: "TP", candle: { t: t2, o: 81.1, h: 81.12, l: 80.95, c: 81.0 } } });
  check("SHORT on the migrated D1: pending → filled at its limit → closed at target", pl.code === "ORDER_PENDING" && op.code === "DRY_RUN_ACCEPTED" && op.data?.price === 81.2 && cl.code === "DRY_RUN_ACCEPTED",
    JSON.stringify([pl.code, op.code, op.data?.price, cl.code, cl.data?.net_usd]));
  const p = sql("SELECT * FROM bot_positions WHERE trade_id = 'REHEARSAL-ALPHA-01-OPEN_SHORT'")[0];
  const w = sql("SELECT available_micro a, reserved_micro r FROM portfolio_wallets WHERE wallet = 'ALPHA-01'")[0];
  const main = sql("SELECT available_micro a FROM portfolio_wallets WHERE wallet = 'MAIN'")[0];
  check("SHORT accounting: gross = (entry − exit) × qty; net = gross − both fees; profit swept to MAIN; collateral released",
    p && p.gross_pnl_micro === Math.round(0.05 * 81.2 * 1e6) - Math.round(0.05 * 81.0 * 1e6) && p.net_pnl_micro === p.gross_pnl_micro - p.entry_fee_micro - p.exit_fee_micro
      && p.swept_micro === Math.max(0, p.net_pnl_micro) && w.r === 0 && w.a === 5_000_000 - (p.net_pnl_micro < 0 ? -p.net_pnl_micro : 0),
    JSON.stringify({ gross: p?.gross_pnl_micro, fees: p ? p.entry_fee_micro + p.exit_fee_micro : null, net: p?.net_pnl_micro, swept: p?.swept_micro, wallet: w, main: main.a }));
  const tradesFinal = await get("/api/dashboard/trades?limit=50");
  check("legacy history still served unchanged after new bot trading", JSON.stringify(tradesFinal.data?.trades ?? tradesFinal.data) === JSON.stringify(tradesBefore.data?.trades ?? tradesBefore.data));
} catch (e) {
  check("rehearsal completed without an exception", false, e?.stack ?? e);
} finally {
  if (worker) stop();
  await KRAKEN.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked */ }
}
const failed = results.filter((r) => !r.ok);
const report = { label: "LOCAL REHEARSAL on a representative DEMO fixture (not production data)", at: new Date().toISOString(), migration: "0007_bots.sql", passed: results.length - failed.length, failed: failed.length, results };
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
process.exit(failed.length ? 1 : 0);

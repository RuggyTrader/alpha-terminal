// PRIVATE PRODUCTION-COPY MIGRATION REHEARSAL (Stage B). Owner-approved export; LOCAL ONLY.
//
//   node tools/private-rehearsal.mjs --export <private .sql from `wrangler d1 export --remote`> [--out <report.json>]
//
// Never contacts production: every wrangler command uses --local with its own temporary --persist-to folder, the
// Worker runs on 127.0.0.1 with random secrets and a loopback Kraken stub, and CLOUDFLARE_API_TOKEN is blanked.
// The export holds trade history and session records: keep it outside the repository; this tool never copies it.
//
// 1. Import the export into an isolated local D1; record every table's rows.
// 2. Worker (this build = the deployed Stage A build) on the copy: record history / performance / account answers.
// 3. Confirm the copy's migration ledger lists exactly ONE pending migration: 0007_bots.sql.
// 4. Apply it with `wrangler d1 migrations apply --local` (the same command production would run with --remote).
// 5. Every pre-existing row and value unchanged (pre-existing columns), FK check clean, schema 7, the four bots with the
//    original profile hashes, empty new wallets, durable pending-order table present; the Worker answers unchanged.
// 6. ON THE COPY ONLY: ALPHA-02 switched to the bot ledger while flat; the legacy route then refuses it; a SHORT and a
//    LONG through durable pending orders (TEST candle values); every balance reconciled to the micro-dollar.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "../test/lib/kraken-stub.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const EXPORT = arg("export"), OUT = arg("out");
if (!EXPORT || !existsSync(EXPORT)) { console.error("--export <file> is required"); process.exit(2); }
if (resolve(EXPORT).toLowerCase().startsWith(resolve(DIR, "..").toLowerCase())) { console.error("refusing: the export must live outside the repository"); process.exit(2); }
const WIN = process.platform === "win32";
const ENV = { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", WRANGLER_SEND_METRICS: "false" };
const s = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = s(), DASHBOARD_PASSPHRASE = s(), ADMIN_SECRET = s();
const PORT = 8861, base = `http://127.0.0.1:${PORT}`;
const wr = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 180000, env: ENV });
const persist = mkdtempSync(join(tmpdir(), "alpha-private-rehearsal-"));
const KRAKEN = await startKrakenStub({ sol: 70.09 }); // TEST quote near the current price; only marks use it
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 600) }); console.error(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`); };

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
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: DIR, stdio: "ignore", shell: WIN, detached: !WIN, env: ENV });
  const end = Date.now() + 120000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
}
async function stop() { try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ } worker = null; await new Promise((r) => setTimeout(r, 3000)); }
const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ http: r.status, ...(await r.json().catch(() => ({}))) }));
const get = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } }).then((r) => r.json());
const paper = (kind, body) => post(`/api/paper/${kind}`, { request_id: s(), ...body, passphrase: DASHBOARD_PASSPHRASE });
const SKIP = new Set(["_cf_KV", "_cf_METADATA", "sqlite_sequence", "d1_migrations", "auth_sessions"]); // _cf_*: Cloudflare-internal bookkeeping, not application data // sessions change on every login; the rest compared
const tables = () => sql("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name).filter((t) => !SKIP.has(t)).sort();
const dumpAll = () => Object.fromEntries(tables().map((t) => [t, sql(`SELECT * FROM "${t}" ORDER BY rowid`)]));
const project = (rows, like) => rows.slice(0, like.length).map((r, i) => Object.fromEntries(Object.keys(like[i] ?? {}).map((k) => [k, r[k]])));
const answers = async () => {
  const t = await get("/api/dashboard/trades?limit=50"), p = await get("/api/dashboard/performance"), d = await get("/api/dashboard");
  return { trades: t.data, lifetime: p.data?.lifetime ?? null, totals: d.data?.portfolio?.totals ?? null, alerts_total: d.data?.counts?.alerts ?? null };
};

let report = {};
try {
  // 1. import
  wr(["d1", "execute", "alpha-terminal-db", "--local", "--persist-to", persist, "--file", resolve(EXPORT)]);
  const pre = dumpAll();
  const counts = Object.fromEntries(Object.entries(pre).map(([t, r]) => [t, r.length]));
  check("export imported into an isolated local D1 (schema 6)", sql(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0]?.value === "6", JSON.stringify(counts));
  // never notify a real device from the copy, and record what that touches (compared tables exclude it below)
  const subs = sql("SELECT COUNT(*) n FROM push_subscriptions")[0].n;
  // 2. answers before
  await start();
  const before = await answers();
  await stop();
  // 3. pending migrations
  const listed = wr(["d1", "migrations", "list", "alpha-terminal-db", "--local", "--persist-to", persist]);
  const pending = [...listed.matchAll(/(\d{4}_[a-z0-9_]+\.sql)/g)].map((m) => m[1]);
  check("exactly one pending migration: 0007_bots.sql", JSON.stringify([...new Set(pending)]) === JSON.stringify(["0007_bots.sql"]), pending.join(", "));
  check("migration ledger has 0001–0006 applied", sql("SELECT COUNT(*) n FROM d1_migrations")[0].n === 6);
  // 4. apply exactly as production would (local)
  wr(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  // 5. integrity
  const post7 = dumpAll();
  // app_meta: every row unchanged EXCEPT schema_version, which the migration moves from 6 to 7 (checked explicitly).
  const meta = (rows) => rows.filter((r) => r.key !== "schema_version");
  for (const [t, rows] of Object.entries(pre)) {
    const a = t === "app_meta" ? meta(rows) : rows, b = t === "app_meta" ? meta(post7[t] ?? []) : (post7[t] ?? []);
    check(`${t}: all ${a.length} rows and values unchanged${t === "app_meta" ? " (other than schema_version)" : ""}`, JSON.stringify(project(b, a)) === JSON.stringify(a));
  }
  check("app_meta.schema_version changed exactly 6 → 7", pre.app_meta.find((r) => r.key === "schema_version")?.value === "6" && post7.app_meta.find((r) => r.key === "schema_version")?.value === "7");
  check("no row removed from any table", Object.entries(pre).every(([t, r]) => (post7[t]?.length ?? 0) >= r.length));
  check("schema 7", sql(`SELECT value FROM app_meta WHERE key = 'schema_version'`)[0]?.value === "7");
  check("foreign keys consistent (push deliveries still point at their events)", sql("PRAGMA foreign_key_check").length === 0);
  check("the four bots with the original profile hashes; only ALPHA-02 ACTIVE (legacy ledger, SOLUSD wallet)",
    JSON.stringify(sql("SELECT bot_id, inputs_hash, status, ledger_api, wallet FROM bots ORDER BY bot_id").map(Object.values))
      === JSON.stringify([["ALPHA-01", "0932a1a0cfac03f9", "PROPOSED", "bot", "ALPHA-01"], ["ALPHA-02", "c826d785d58a4a39", "ACTIVE", "legacy", "SOLUSD"], ["ALPHA-03", "d828caa44611ad73", "PROPOSED", "bot", "ALPHA-03"], ["ALPHA-04", "a6336dad6ffaed70", "PROPOSED", "bot", "ALPHA-04"]]),
    JSON.stringify(sql("SELECT bot_id, inputs_hash, status, ledger_api, wallet FROM bots ORDER BY bot_id")));
  check("new bot wallets empty (no capital created)", sql("SELECT COALESCE(SUM(available_micro + reserved_micro), 0) n FROM portfolio_wallets WHERE wallet LIKE 'ALPHA-%'")[0].n === 0);
  check("durable pending-order table and one-PENDING-per-bot index created",
    sql("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('bot_pending_orders', 'ux_bot_pending_one', 'bot_positions', 'bot_fills', 'bot_orders')")[0].n === 5);
  check("existing records attributed to ALPHA-02 (engine alerts and the legacy position)",
    sql("SELECT COUNT(*) n FROM alerts WHERE alert_id LIKE 'ENG-SOLUSD-5-%' AND bot_id <> 'ALPHA-02'")[0].n === 0, `${sql("SELECT COUNT(*) n FROM alerts WHERE bot_id = 'ALPHA-02'")[0].n} ALPHA-02 alerts`);
  // disable the copied push subscriptions before the Worker runs on the copy (no VAPID keys locally either)
  if (subs) sql("UPDATE push_subscriptions SET disabled_at = ?", new Date().toISOString());
  await start();
  const after = await answers();
  for (const k of ["trades", "lifetime", "totals", "alerts_total"]) check(`Worker answer unchanged after the migration: ${k}`, JSON.stringify(after[k]) === JSON.stringify(before[k]), JSON.stringify(after[k]).slice(0, 160));
  check("legacy trade #1 still served", JSON.stringify(after.trades).includes("ENG-SOLUSD-5-2026-11-13T00:30:00Z-BUY"));
  const bt = await get("/api/dashboard/bot-trades?bot=ALPHA-02&limit=50");
  check("ALPHA-02 history and refusals served by the bot views", JSON.stringify(bt).includes("NO_POSITION") && JSON.stringify(bt).includes("INSUFFICIENT_PAPER_CAPITAL"));
  const wBefore = sql("SELECT wallet, available_micro a, reserved_micro r FROM portfolio_wallets WHERE wallet IN ('MAIN', 'SOLUSD') ORDER BY wallet");

  // 6. ON THE COPY ONLY: ALPHA-02 to the bot ledger, then a SHORT and a LONG (TEST candles)
  const sw = await paper("bot-ledger", { bot_id: "ALPHA-02", ledger: "bot" });
  check("ALPHA-02 switched to the bot ledger (flat)", sw.ok && sw.ledger_api === "bot", JSON.stringify(sw).slice(0, 200));
  const legacy = await post("/webhook/dry-run", { secret: WEBHOOK_SECRET, id: "ENG-SOLUSD-5-2099-01-01T00:00:00Z-BUY", symbol: "SOLUSD", timeframe: "5", action: "buy", strategy: "OTE", qty: 0.1, timestamp: new Date().toISOString() });
  check("the legacy route refuses ALPHA-02 after the switch (one route only)", legacy.code === "BOT_LEDGER_PATH", legacy.code);
  const T0 = Math.floor((Date.now() - 6 * 3600_000) / 300_000) * 300_000, t = (m) => new Date(T0 + m * 300_000).toISOString();
  const o = (action, x) => post("/webhook/bot-order", { secret: WEBHOOK_SECRET, bot_id: "ALPHA-02", action, symbol: "SOLUSD", timeframe: "5", config_hash: "c826d785d58a4a39", risk_usd: 10, ...x });
  const ps = await o("PLACE_LIMIT", { order_id: "REHEARSAL-ENG-SOLUSD-5-PLACE_SHORT", side: "SHORT", limit: 70.0, stop: 70.3, tp: 69.4, qty: 33.3, placed_at: t(0) });
  const fs = await o("OPEN_SHORT", { order_id: "REHEARSAL-ENG-SOLUSD-5-OPEN_SHORT", pending_order_id: "REHEARSAL-ENG-SOLUSD-5-PLACE_SHORT", qty: 33.3, stop: 70.3, tp: 69.4, fill: { price: 70.0, candle: { t: t(1), o: 69.9, h: 70.05, l: 69.85, c: 69.95 } } });
  const cs = await o("CLOSE", { order_id: "REHEARSAL-ENG-SOLUSD-5-CLOSE_SHORT", entry_order_id: "REHEARSAL-ENG-SOLUSD-5-OPEN_SHORT", fill: { price: 69.4, kind: "TP", candle: { t: t(3), o: 69.6, h: 69.62, l: 69.3, c: 69.35 } } });
  check("SHORT: requested 33.3 (dollar risk) → accepted to fit ALPHA-02's own wallet; filled at its limit; closed at target",
    ps.code === "ORDER_PENDING" && ps.data.accepted_qty < 33.3 && fs.code === "DRY_RUN_ACCEPTED" && fs.data.price === 70 && cs.code === "DRY_RUN_ACCEPTED" && cs.data.gross_usd > 0,
    JSON.stringify({ accepted: ps.data?.accepted_qty, msg: ps.data?.message, fill: fs.data?.price, qty: fs.data?.qty, gross: cs.data?.gross_usd, fees: cs.data?.fees_usd, net: cs.data?.net_usd, swept: cs.data?.swept_to_main_usd }));
  const pl = await o("PLACE_LIMIT", { order_id: "REHEARSAL-ENG-SOLUSD-5-PLACE_LONG", side: "LONG", limit: 69.5, stop: 69.2, tp: 70.1, qty: 33.3, placed_at: t(4) });
  const fl = await o("OPEN_LONG", { order_id: "REHEARSAL-ENG-SOLUSD-5-OPEN_LONG", pending_order_id: "REHEARSAL-ENG-SOLUSD-5-PLACE_LONG", qty: 33.3, stop: 69.2, tp: 70.1, fill: { price: 69.5, candle: { t: t(5), o: 69.6, h: 69.65, l: 69.45, c: 69.5 } } });
  const cl = await o("CLOSE", { order_id: "REHEARSAL-ENG-SOLUSD-5-CLOSE_LONG", entry_order_id: "REHEARSAL-ENG-SOLUSD-5-OPEN_LONG", fill: { price: 69.2, kind: "SL", candle: { t: t(6), o: 69.4, h: 69.45, l: 69.1, c: 69.15 } } });
  check("LONG: filled at its limit, stopped out (a loss stays in ALPHA-02's wallet)", pl.code === "ORDER_PENDING" && fl.data?.price === 69.5 && cl.code === "DRY_RUN_ACCEPTED" && cl.data.net_usd < 0,
    JSON.stringify({ accepted: pl.data?.accepted_qty, qty: fl.data?.qty, gross: cl.data?.gross_usd, fees: cl.data?.fees_usd, net: cl.data?.net_usd }));
  const pos = sql("SELECT * FROM bot_positions WHERE bot_id = 'ALPHA-02' ORDER BY id");
  const wAfter = sql("SELECT wallet, available_micro a, reserved_micro r FROM portfolio_wallets WHERE wallet IN ('MAIN', 'SOLUSD') ORDER BY wallet");
  const net = pos.reduce((a, p) => a + p.net_pnl_micro, 0), swept = pos.reduce((a, p) => a + p.swept_micro, 0);
  const [mB, sB] = wBefore, [mA, sA] = wAfter;
  check("reconciled: SOLUSD (ALPHA-02) = before + Σnet − Σswept; MAIN = before + Σswept; nothing reserved; fees once per fill",
    sA.a === sB.a + net - swept && sA.r === 0 && mA.a === mB.a + swept && sql("SELECT COUNT(*) n FROM bot_fills WHERE bot_id = 'ALPHA-02'")[0].n === 4,
    JSON.stringify({ solusd_before: sB.a, solusd_after: sA.a, main_before: mB.a, main_after: mA.a, net, swept }));
  check("pending orders end FILLED; legacy trade #1 still served", sql("SELECT COUNT(*) n FROM bot_pending_orders WHERE status = 'FILLED'")[0].n === 2
    && JSON.stringify((await get("/api/dashboard/trades?limit=50")).data).includes("ENG-SOLUSD-5-2026-11-13T00:30:00Z-BUY"));
  report.counts_before = counts;
} catch (e) {
  check("rehearsal completed without an exception", false, e?.stack ?? e);
} finally {
  if (worker) await stop();
  await KRAKEN.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked */ }
}
const failed = results.filter((r) => !r.ok);
report = { label: "PRIVATE production-copy rehearsal (local only; production not contacted after the export)", export_file: "outside the repository (path not recorded)", at: new Date().toISOString(),
  passed: results.length - failed.length, failed: failed.length, ...report, results };
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
process.exit(failed.length ? 1 : 0);

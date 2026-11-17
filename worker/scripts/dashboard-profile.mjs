#!/usr/bin/env node
// Local dashboard cost profile (READ-ONLY, no network, no production access). Builds the schema from worker/migrations
// into an in-memory SQLite database, seeds production-shaped volumes (synthetic rows, no real data), and calls the real
// /api/dashboard* handlers through handleDashboardApi with network fetches stubbed to fail fast. For each endpoint it
// reports D1 statements, D1 round trips (awaits) and JS time EXCLUDING the time SQLite spends executing (a proxy for
// Workers CPU: D1 runs outside the isolate). Cloudflare's own cpuTime (wrangler tail) remains the production measure.
//   node scripts/dashboard-profile.mjs [--scale 1] [--runs 30] [--json]
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const SCALE = Number(arg("scale", "1")), RUNS = Number(arg("runs", "30"));

export async function loadHandlers(entry = "./src/dashboard_api", names = ["handleDashboardApi"]) {
  const require = createRequire(import.meta.url);
  const esbuild = require(join(ROOT, "node_modules", "esbuild"));
  const work = mkdtempSync(join(tmpdir(), "alpha-prof-"));
  const out = join(work, "dash.mjs");
  await esbuild.build({ stdin: { contents: `export { ${names.join(", ")} } from "${entry}";`, resolveDir: ROOT, loader: "ts" }, bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
  const M = await import(pathToFileURL(out).href);
  rmSync(work, { recursive: true, force: true });
  return M;
}

export function makeD1() {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => /^\d{4}_/.test(f)).sort()) raw.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  raw.exec("PRAGMA foreign_keys = OFF");
  const c = { statements: 0, awaits: 0, sqlMs: 0, rows: 0 };
  const run = (fn) => { const t = performance.now(); try { return fn(); } finally { c.sqlMs += performance.now() - t; } };
  const exec = (sql, args, mode) => run(() => {
    c.statements++;
    const st = raw.prepare(sql);
    if (mode === "all") { const r = st.all(...args).map((x) => ({ ...x })); c.rows += r.length; return { results: r }; }
    if (mode === "first") { const r = st.get(...args); c.rows += r ? 1 : 0; return r ? { ...r } : null; }
    const m = st.run(...args); return { meta: { changes: Number(m.changes), last_row_id: Number(m.lastInsertRowid) } };
  });
  const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a.map((v) => (v === undefined ? null : v))),
    all: async () => { c.awaits++; return exec(sql, args, "all"); },
    first: async (col) => { c.awaits++; const r = exec(sql, args, "first"); return col && r ? r[col] : r; },
    run: async () => { c.awaits++; return exec(sql, args, "run"); },
    raw: async () => { c.awaits++; return exec(sql, args, "all").results.map((r) => Object.values(r)); } });
  return { raw, c, prepare: (sql) => stmt(sql),
    batch: async (list) => { c.awaits++; return list.map((s) => exec(s.sql, s.args, /^\s*(SELECT|WITH)/i.test(s.sql) ? "all" : "run")); },
    exec: async (sql) => { raw.exec(sql); return { count: 0 }; } };
}

// Production-shaped synthetic volumes (2026-11-16: ~230 trade events, tens of bot trades, hundreds of alerts/heartbeats).
export function seed(db, scale = 1) {
  const x = (sql, ...a) => db.raw.prepare(sql).run(...a);
  const n = (k) => Math.max(1, Math.round(k * scale));
  x(`UPDATE bots SET ledger_api = 'bot', status = 'ACTIVE'`);
  x(`UPDATE bots SET entries_paused = 1 WHERE bot_id IN ('ALPHA-01', 'ALPHA-03')`);
  let e = 0;
  for (const w of ["ALPHA-01", "ALPHA-02", "ALPHA-03", "ALPHA-04"]) x(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro) VALUES (?, ?, 'now', 'TRANSFER_IN', ?, 25000000)`, `k${++e}`, `ALLOC:${w}`, w);
  const bots = [["ALPHA-01", "SOLUSD", 72.3], ["ALPHA-02", "SOLUSD", 72.3], ["ALPHA-03", "BTCUSD", 64700], ["ALPHA-04", "BTCUSD", 64700]];
  let t = 0;
  for (let i = 0; i < n(60); i++) {
    const [bot, sym, px] = bots[i % 4], closed = `2026-11-${String(10 + (i % 6)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`;
    x(`INSERT INTO bot_positions (trade_id, bot_id, symbol, side, status, qty, entry_price, entry_fee_micro, collateral_micro, stop, tp, risk_usd, fee_model, opened_at, exit_price, exit_fee_micro, closed_at, gross_pnl_micro, net_pnl_micro, swept_micro)
       VALUES (?, ?, ?, ?, 'CLOSED', 0.27, ?, 39721, 19860000, ?, ?, 10, 'ndax', ?, ?, 39590, ?, ?, ?, 0)`, `T${++t}`, bot, sym, i % 2 ? "LONG" : "SHORT", px, px * 0.99, px * 1.02, closed, px * 1.001, closed, (i % 5) * 20000 - 40000, (i % 5) * 20000 - 120000);
  }
  for (let i = 0; i < n(400); i++) x(`INSERT INTO alerts (alert_id, received_at, symbol, action, status, response_code, payload_json, duplicate_count) VALUES (?, ?, 'SOLUSD', 'OPEN_LONG', ?, 'DRY_RUN_ACCEPTED', '{}', 0)`, `A${i}`, `2026-11-1${i % 6}T00:00:${String(i % 60).padStart(2, "0")}Z`, i % 3 ? "dry_run" : "rejected");
  for (let i = 0; i < n(400); i++) x(`INSERT INTO activity_events (ts, category, level, message) VALUES (?, 'engine', 'info', ?)`, `2026-11-16T00:${String(i % 60).padStart(2, "0")}:00Z`, `event ${i}`);
  for (let i = 0; i < n(230); i++) x(`INSERT INTO trade_events (event_key, kind, source, symbol, side, qty, price, classification, occurred_at, created_at, bot_id) VALUES (?, 'ORDER_PENDING', 'funded', 'SOLUSD', 'LONG', 0.27, 72.3, 'live', ?, 'now', 'ALPHA-02')`, `E${i}`, `2026-11-16T${String(i % 24).padStart(2, "0")}:00:00Z`);
  for (const [b] of bots) x(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`, `engine_status:${b}`, JSON.stringify({ status_text: "Scanning", received_at: "2026-11-16T23:00:00Z", ledger_check: { status: "OK", entries_paused: b === "ALPHA-01" } }));
}

async function main() {
  const { handleDashboardApi } = await loadHandlers();
  const endpoints = ["/api/dashboard", "/api/dashboard/bots", "/api/dashboard/summary", "/api/dashboard/events", "/api/dashboard/activity"];
  const env = { ADMIN_SECRET: "local-profile-only", ENABLE_TRADING: "false" };
  globalThis.fetch = async () => { throw new Error("network disabled in the local profile"); };
  const report = [];
  for (const path of endpoints) {
    const db = makeD1(); seed(db, SCALE);
    const e = { ...env, DB: db };
    const req = () => new Request(`http://local${path}`, { headers: { "x-admin-secret": env.ADMIN_SECRET } });
    let status = 0;
    for (let i = 0; i < 3; i++) status = (await handleDashboardApi(req(), e, path, new URLSearchParams())).status; // warm
    const js = [], st = [], aw = [];
    for (let i = 0; i < RUNS; i++) {
      db.c.statements = 0; db.c.awaits = 0; db.c.sqlMs = 0;
      const t0 = performance.now();
      const res = await handleDashboardApi(req(), e, path, new URLSearchParams());
      await res.text();
      js.push(performance.now() - t0 - db.c.sqlMs); st.push(db.c.statements); aw.push(db.c.awaits);
    }
    js.sort((a, b) => a - b);
    report.push({ path, status, statements: st[0], round_trips: aw[0], js_ms_p50: +js[Math.floor(RUNS / 2)].toFixed(2), js_ms_p95: +js[Math.floor(RUNS * 0.95)].toFixed(2) });
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 1));
  else for (const r of report) console.log(`${r.path.padEnd(26)} HTTP ${r.status}  statements ${String(r.statements).padStart(3)}  round trips ${String(r.round_trips).padStart(3)}  JS (excl. SQL) p50 ${r.js_ms_p50} ms  p95 ${r.js_ms_p95} ms`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

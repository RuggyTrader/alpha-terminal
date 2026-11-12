// Stage R3 gate (LOCAL): does THIS Worker build run correctly against production's current schema 6 (migrations
// 0001–0006 only, no 0007) with today's single legacy engine? Every dashboard route and the engine webhooks must answer
// without a 5xx, nothing is written to tables that do not exist, and the new bot features stay inert.
//   node tools/schema6-compat.mjs
// Fresh local D1; random secrets (never printed); Kraken quotes from the local test stub.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "../test/lib/kraken-stub.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const PORT = 8871, base = `http://127.0.0.1:${PORT}`;
const sec = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = sec(), DASHBOARD_PASSPHRASE = sec(), ADMIN_SECRET = sec();
const KRAKEN = await startKrakenStub({ sol: 80 });
const persist = mkdtempSync(join(tmpdir(), "alpha-s6-"));
const wr = (a) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...a], { cwd: DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 180000 });
for (const f of readdirSync(join(DIR, "migrations")).filter((x) => /^000[1-6]_.*\.sql$/.test(x)).sort()) wr(["d1", "execute", "alpha-terminal-db", "--local", "--persist-to", persist, "--file", join("migrations", f)]);
const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) args.push("--var", `${k}:${v}`);
const worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: DIR, stdio: "ignore", shell: WIN, detached: !WIN });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };
try {
  for (const end = Date.now() + 120000; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  const cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  const get = async (p) => { const r = await fetch(`${base}${p}`, { headers: { Cookie: cookie } }); return { status: r.status, body: await r.json().catch(() => null) }; };
  // today's legacy engine: a heartbeat with the new strategy_state field, and a dry-run signal
  const hb = await fetch(`${base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: WEBHOOK_SECRET,
    status: { engine: "alpha-engine", symbol: "SOLUSD", timeframe: "5m", status_text: "Scanning", last_candle_time: "2026-11-12T10:00:00Z",
      strategy_state: { direction: "LONG", leg_start: 79, leg_end: 81, setup_bars: 2, max_age_bars: 50, pending_order: { side: "LONG", qty: 0.1, limit: 79.6, stop: 79, tp: 81 }, current_stop: null, break_even_done: false, trailing: false } } }) });
  check("engine-status (legacy engine, new strategy_state field) on schema 6", hb.status === 200, hb.status);
  const sig = await fetch(`${base}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: WEBHOOK_SECRET, id: "ENG-SOLUSD-5-2026-11-12T10:00:00Z-BUY",
    symbol: "SOLUSD", timeframe: "5", action: "buy", strategy: "OTE", qty: 0.1, timestamp: "2026-11-12T10:00:00Z" }) });
  check("legacy /webhook/dry-run still answers (no 5xx)", sig.status < 500, sig.status);
  for (const p of ["/api/dashboard", "/api/dashboard/bots", "/api/dashboard/bot-trades?bot=ALPHA-01", "/api/dashboard/bot-trades?signal=ENG-SOLUSD-5-2026-11-12T10:00:00Z-BUY",
    "/api/dashboard/events?limit=30", "/api/dashboard/performance", "/api/dashboard/allocation-preview?group=SOLANA&amount=10"]) {
    const r = await get(p);
    check(`GET ${p}`, r.status < 500, `${r.status}${r.body?.data?.available === false ? " (bot features inert: available=false)" : ""}`);
  }
  const bt = await get("/api/dashboard/bot-trade?id=X");
  check("GET /api/dashboard/bot-trade on schema 6 → 404, not 5xx", bt.status === 404, bt.status);
  const bo = await fetch(`${base}/webhook/bot-order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: "ALPHA-01", order_id: "X-OPEN_LONG", action: "OPEN_LONG", symbol: "SOLUSD", timeframe: "1", qty: 0.1 }) });
  check("bot-order on schema 6 is refused (no funded bot trading), not 5xx", bo.status === 409, bo.status);
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ schema: "0001–0006 (production today)", passed: results.length - failed.length, failed: failed.length, results }, null, 1));
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ }
  await KRAKEN.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked */ }
}

// LOCAL resource measurement of the dashboard endpoints (not production): `wrangler dev --local` on a fresh D1 with all
// migrations, seeded through the Worker's own routes (MAIN deposit, group allocations, bot orders and closes, engine
// reports), MEASURE_D1=1 so every response carries its D1 statements and rows (src/d1meter.ts). Kraken quotes come from
// the local test stub; Alpaca keys are empty (the optional broker answers BROKER_NOT_CONFIGURED at once).
//   node tools/measure-dashboard.mjs [--n 40] [--out ../docs/measurements/dashboard-local.json]
// Secrets are random per run and never printed.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "../test/lib/kraken-stub.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const N = Number(arg("n", "40"));
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const PORT = 8851, base = `http://127.0.0.1:${PORT}`;
const sec = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = sec(), DASHBOARD_PASSPHRASE = sec(), ADMIN_SECRET = sec();
const KRAKEN = await startKrakenStub({ sol: 80 });
KRAKEN.set("XBTUSD", 100000);
const persist = mkdtempSync(join(tmpdir(), "alpha-measure-"));
const wrangler = (a) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...a], { cwd: DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
const dbFile = () => { const d = join(persist, "v3", "d1", "miniflare-D1DatabaseObject"); return join(d, readdirSync(d).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")); };
{ const db = new DatabaseSync(dbFile()); db.exec(`UPDATE bots SET status = 'ACTIVE' WHERE bot_id IN ('ALPHA-01', 'ALPHA-03', 'ALPHA-04')`); db.close(); } // LOCAL TEST activation only
const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none", MEASURE_D1: "1" })) args.push("--var", `${k}:${v}`);
const worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: DIR, stdio: "ignore", shell: WIN, detached: !WIN });
try {
  const end = Date.now() + 120000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  const cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: sec(), ...body, passphrase: DASHBOARD_PASSPHRASE }) }).then((r) => r.json());
  let n = 0;
  const TF = { "ALPHA-01": "1", "ALPHA-03": "1", "ALPHA-04": "5" }, SYM = { "ALPHA-01": "SOLUSD", "ALPHA-03": "BTCUSD", "ALPHA-04": "BTCUSD" };
  const order = (bot, action, o = {}) => fetch(`${base}/webhook/bot-order`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: bot, order_id: `ENG-${bot}-${SYM[bot]}-${TF[bot]}-M${++n}-${action}`, action, symbol: SYM[bot], timeframe: TF[bot], stop: 1, tp: 2, ...o }) }).then((r) => r.json());
  // Seed: $1,000 MAIN, $200 per group, 60 closed round trips per bot-ledger bot (TEST prices from the stub).
  await act("fund", { action: "deposit", amount_usd: 1000 });
  await act("allocate", { group: "SOLANA", amount_usd: 200 });
  await act("allocate", { group: "BITCOIN", amount_usd: 200 });
  for (let i = 0; i < 60; i++) {
    for (const [bot, qty, act1] of [["ALPHA-01", 0.2, i % 2 ? "OPEN_SHORT" : "OPEN_LONG"], ["ALPHA-03", 0.0002, i % 2 ? "OPEN_LONG" : "OPEN_SHORT"], ["ALPHA-04", 0.0002, "OPEN_LONG"]]) {
      await order(bot, act1, { qty });
      KRAKEN.set(SYM[bot] === "SOLUSD" ? "SOLUSD" : "XBTUSD", SYM[bot] === "SOLUSD" ? 80 + ((i % 5) - 2) * 0.1 : 100000 + ((i % 5) - 2) * 50);
      await order(bot, "CLOSE");
    }
  }
  const report = { tool: "worker/tools/measure-dashboard.mjs", environment: "LOCAL wrangler dev (miniflare D1), not production", seeded: { closed_bot_trades: 180, n_requests_per_endpoint: N },
    generated_at: new Date().toISOString(), endpoints: {} };
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
  for (const path of ["/api/dashboard", "/api/dashboard/bots", "/api/dashboard/events?limit=30", "/api/dashboard/bot-trades?bot=ALPHA-01", "/api/dashboard/performance"]) {
    const lat = [], d1 = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const r = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
      await r.arrayBuffer();
      lat.push(performance.now() - t0);
      const h = r.headers.get("x-d1");
      if (h) d1.push(Object.fromEntries(h.split(";").map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)])));
      if (r.status !== 200) { report.endpoints[path] = { status: r.status }; break; }
    }
    if (report.endpoints[path]) continue;
    const mean = (k) => d1.length ? d1.reduce((s, x) => s + x[k], 0) / d1.length : null;
    report.endpoints[path] = { median_ms: +pct(lat, 50).toFixed(1), p95_ms: +pct(lat, 95).toFixed(1), worst_ms: +Math.max(...lat).toFixed(1),
      d1_statements: mean("statements"), d1_rows_read: mean("rows_read"), d1_rows_written: mean("rows_written"), d1_ms: mean("d1_ms") && +mean("d1_ms").toFixed(2) };
  }
  const out = arg("out", null);
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 1)); }
  console.log(JSON.stringify(report, null, 1));
} finally {
  try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ }
  await KRAKEN.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked on Windows */ }
}

#!/usr/bin/env node
// LOCAL UI PREVIEW BACKEND (development only). Starts the real Worker with `wrangler dev --local` on a throwaway D1 in
// a temporary folder, with a Kraken stub (labelled TEST quotes, 127.0.0.1 only) and a generated passphrase, then
// creates a few TEST PAPER trades through the Worker's own webhooks so the redesigned screens have records to show.
// Nothing here touches production: no remote database, no deployed Worker, no real market data, no broker.
//
//   node tools/ui-preview/preview-backend.mjs [--port 8851] [--pulse]      (then run Vite with ALPHA_BACKEND_URL)
//   --pulse   every 100 s, one more TEST round trip closes (to watch the Home animations)
// The generated passphrase is written to <persist>/PASSPHRASE.txt (a local test value; never a real one).

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "../../worker/test/lib/kraken-stub.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const PORT = Number(arg("port", "8851"));
const PULSE = process.argv.includes("--pulse");
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "worker");
const WIN = process.platform === "win32";
const s = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = s(), DASHBOARD_PASSPHRASE = s(), ADMIN_SECRET = s();
const base = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), "alpha-ui-preview-"));
const KRAKEN = await startKrakenStub({ sol: 72 });
KRAKEN.set("XBTUSD", 65000);

const sql = (q, ...a) => {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const db = new DatabaseSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")));
  try { const st = db.prepare(q); return /^\s*SELECT/i.test(q) ? st.all(...a) : st.run(...a); } finally { db.close(); }
};
execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", "d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist], { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, timeout: 180000 });
// TEST setup of the local copy only: the four bots active on their own wallets (as in production since Stage D).
sql(`UPDATE bots SET status = 'ACTIVE', ledger_api = 'bot', legacy_default = 0`);

const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) args.push("--var", `${k}:${v}`);
const worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN });
const stop = () => { try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else worker.kill(); } catch { /* gone */ } process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
for (const end = Date.now() + 120000; Date.now() < end;) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
const cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: s(), passphrase: DASHBOARD_PASSPHRASE, ...body }) }).then((r) => r.json());
await act("fund", { action: "deposit", amount_usd: 100 });
const setup = await act("fleet-setup", { target_usd: 20 });

const BOT = { "ALPHA-01": ["SOLUSD", "1"], "ALPHA-02": ["SOLUSD", "5"], "ALPHA-03": ["BTCUSD", "1"], "ALPHA-04": ["BTCUSD", "5"] };
let n = 0;
const order = (bot, action, o = {}) => fetch(`${base}/webhook/bot-order`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: bot, order_id: `ENG-${bot}-${BOT[bot][0]}-${BOT[bot][1]}-PREVIEW${++n}-${action}`, action, symbol: BOT[bot][0], timeframe: BOT[bot][1], ...o }) }).then((r) => r.json());
const px = (sym, p) => KRAKEN.set(sym === "SOLUSD" ? "SOLUSD" : "XBTUSD", p);
async function roundTrip(bot, side, entry, exit) {
  const [sym] = BOT[bot];
  px(sym, entry);
  const qty = sym === "SOLUSD" ? 0.2 : 0.0002;
  const stop = side === "LONG" ? entry * 0.99 : entry * 1.01, tp = side === "LONG" ? entry * 1.02 : entry * 0.98;
  const o = await order(bot, side === "LONG" ? "OPEN_LONG" : "OPEN_SHORT", { qty, stop: +stop.toFixed(2), tp: +tp.toFixed(2) });
  px(sym, exit);
  const c = await order(bot, "CLOSE");
  return [o.code ?? o.status, c.code ?? c.status];
}
console.log("fleet setup:", setup.code ?? setup.ok);
console.log(await roundTrip("ALPHA-01", "SHORT", 72.3, 72.06));
console.log(await roundTrip("ALPHA-02", "LONG", 71.59, 71.62));
console.log(await roundTrip("ALPHA-04", "LONG", 65100, 64950));
console.log(await roundTrip("ALPHA-03", "SHORT", 65020.7, 65035));
console.log(await roundTrip("ALPHA-02", "LONG", 71.2, 71.9));
px("BTCUSD", 65020.7);
console.log("open:", (await order("ALPHA-03", "OPEN_SHORT", { qty: 0.0002, stop: 65138.7, tp: 64560.2 })).code);

// Heartbeats: every bot reports like the engine does (TEST strategy state), so their status is genuinely "online".
const beat = async () => {
  const now = Date.now(), t = (tf) => new Date(Math.floor(now / (tf * 60000)) * tf * 60000 - tf * 60000).toISOString();
  for (const [bot, [sym, tf]] of Object.entries(BOT)) {
    const st = bot === "ALPHA-02" ? { direction: "LONG", leg_start: 70.9, leg_end: 72.4, setup_bars: 4, max_age_bars: 36, pending_order: { side: "LONG", qty: 0.27, limit: 71.59, stop: 71.1, tp: 72.3 }, current_stop: null, break_even_done: false, trailing: false }
      : bot === "ALPHA-03" ? { direction: "SHORT", leg_start: 65128.9, leg_end: 64762, setup_bars: null, max_age_bars: null, pending_order: null, current_stop: 65079.2, break_even_done: false, trailing: true }
      : { direction: null, leg_start: null, leg_end: null, setup_bars: null, max_age_bars: null, pending_order: null, current_stop: null, break_even_done: false, trailing: false };
    await fetch(`${base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, status: { engine: "alpha-engine", symbol: sym, timeframe: `${tf}m`, bot_id: bot, status_text: st.pending_order ? "ORDER PLACED - waiting fill" : "Waiting for a swing", last_candle_time: t(Number(tf)), last_poll_at: new Date(now).toISOString(), strategy_state: st, ledger_check: { status: "OK", issues: [] } } }) });
  }
};
await beat();
setInterval(beat, 30_000);
let k = 0;
if (PULSE) setInterval(async () => { k++; console.log("pulse", await roundTrip(k % 2 ? "ALPHA-01" : "ALPHA-04", k % 2 ? "SHORT" : "LONG", k % 2 ? 72 : 65000, k % 2 ? 71.8 + (k % 3) * 0.2 : 65100 - (k % 3) * 120)); }, 100_000);

writeFileSync(join(persist, "PASSPHRASE.txt"), DASHBOARD_PASSPHRASE);
console.log(`READY ${base} · local TEST data only · passphrase file: ${join(persist, "PASSPHRASE.txt")}`);

// REVIEW: the ledger's strict acceptance rule (STRICT_FILL_TIMING=true). A fill's candle must open at or after the
// order's acceptance (received_at) as well as its issue time (placed_at). Existing records are never re-evaluated.
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
import { assertPortFree } from "./lib/port-guard.mjs";

const KRAKEN = await startKrakenStub({ sol: 80 });
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
const PORT = 8851, base = `http://127.0.0.1:${PORT}`;
let worker, persist, cookie;
function sql(q, ...args) {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  for (let i = 0; ; i++) {
    try {
      const db = new DatabaseSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")));
      try { const st = db.prepare(q); return /^\s*(SELECT|WITH)/i.test(q) ? st.all(...args).map((r) => ({ ...r })) : st.run(...args); } finally { db.close(); }
    } catch (e) { if (i >= 40 || !/locked|busy|disk I\/O/i.test(String(e.message))) throw e; execFileSync(process.execPath, ["-e", "setTimeout(()=>{},250)"]); }
  }
}
const send = (action, o) => fetch(`${base}/webhook/bot-order`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: "ALPHA-01", action, symbol: "SOLUSD", timeframe: "1", ...o }) }).then(async (r) => ({ http: r.status, ...(await r.json()) }));
const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: secret(), ...body, passphrase: DASHBOARD_PASSPHRASE }) }).then((r) => r.json());
const min = (iso, m) => new Date(Date.parse(iso) + m * 60_000).toISOString();
const T0 = new Date(Math.floor((Date.now() - 3 * 3600_000) / 60_000) * 60_000).toISOString(); // a past minute (TEST)

before(async () => {
  persist = mkdtempSync(join(tmpdir(), "alpha-strict-"));
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  sql(`UPDATE bots SET status = 'ACTIVE' WHERE bot_id = 'ALPHA-01'`);
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  assertPortFree(PORT, PORT + 600); // never test against a server this test did not start
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none", STRICT_FILL_TIMING: "true" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 120000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  await act("fund", { action: "deposit", amount_usd: 100 });
  await act("allocate", { group: "SOLANA", amount_usd: 40 });
});
after(async () => {
  try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ }
  await KRAKEN.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

describe("strict acceptance timing in the ledger (TEST values, isolated D1)", () => {
  it("a candle that opened before acceptance cannot fill the order; the first candle starting at or after acceptance can", async () => {
    const id = "ENG-ALPHA-01-SOLUSD-1-STRICT-PLACE_LONG";
    const p = await send("PLACE_LIMIT", { order_id: id, side: "LONG", limit: 80, stop: 79.5, tp: 81, qty: 0.1, placed_at: T0 });
    assert.equal(p.code, "ORDER_PENDING"); assert.ok(p.data.received_at, "the acceptance time is returned to the engine");
    // TEST: the ledger accepted it 5 s after the candle close it was issued at (as in production: seconds later).
    sql(`UPDATE bot_pending_orders SET received_at = ? WHERE order_id = ?`, new Date(Date.parse(T0) + 5000).toISOString(), id);
    const early = await send("OPEN_LONG", { order_id: `${id}-E`.replace("PLACE_LONG-E", "E-OPEN_LONG"), pending_order_id: id, qty: 0.1, fill: { price: 80, candle: { t: T0, o: 80.2, h: 80.3, l: 79.9, c: 80.1 } } });
    assert.equal(early.code, "FILL_BEFORE_ORDER", JSON.stringify(early));
    assert.match(early.message, /before the order existed/);
    assert.equal(sql(`SELECT status FROM bot_pending_orders WHERE order_id = ?`, id)[0].status, "PENDING", "the order stays pending");
    const ok = await send("OPEN_LONG", { order_id: id.replace("PLACE_LONG", "OPEN_LONG"), pending_order_id: id, qty: 0.1, fill: { price: 80, candle: { t: min(T0, 1), o: 80.1, h: 80.2, l: 79.8, c: 80 } } });
    assert.equal(ok.code, "DRY_RUN_ACCEPTED", JSON.stringify(ok));
    assert.equal(sql(`SELECT status FROM bot_positions WHERE trade_id = ?`, id.replace("PLACE_LONG", "OPEN_LONG"))[0].status, "OPEN");
  });

  it("existing records are never re-evaluated: a position recorded before stays exactly as it was", async () => {
    const before = sql(`SELECT * FROM bot_positions ORDER BY id`);
    await send("PLACE_LIMIT", { order_id: "ENG-ALPHA-01-SOLUSD-1-STRICT2-PLACE_SHORT", side: "SHORT", limit: 90, stop: 91, tp: 88, qty: 0.05, placed_at: min(T0, 30) });
    assert.deepEqual(sql(`SELECT * FROM bot_positions ORDER BY id`), before);
  });
});

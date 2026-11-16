// Forward trial wiring in a real local Worker (TEST values, isolated D1, local Kraken stub): the scheduled job, the
// read-only report, the one-time owner activation, and complete isolation from the production portfolio.
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

const KRAKEN = await startKrakenStub();
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
const PORT = 8863, base = `http://127.0.0.1:${PORT}`;
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
const dash = (p) => fetch(`${base}${p}`, { headers: { Cookie: cookie } }).then((r) => r.json());
const act = (kind, body, pass = DASHBOARD_PASSPHRASE) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: secret(), ...body, ...(pass ? { passphrase: pass } : {}) }) }).then(async (r) => ({ http: r.status, ...(await r.json()) }));
// Fire the Worker's scheduled handler (wrangler dev local explorer API; a GET /__scheduled from Node is answered by
// the static-asset router because fetch sends Sec-Fetch-Mode: navigate).
const scheduled = async () => {
  const r = await fetch(`${base}/__scheduled?cron=*+*+*+*+*`, { headers: { "Sec-Fetch-Mode": "cors", Accept: "*/*" } });
  const text = await r.text();
  if (r.status !== 200 || /<html/i.test(text)) throw new Error(`scheduled trigger ${r.status}: ${text.slice(0, 120)}`);
};
const portfolio = () => JSON.stringify([sql(`SELECT * FROM portfolio_wallets ORDER BY wallet`), sql(`SELECT * FROM portfolio_entries ORDER BY entry_key`), sql(`SELECT * FROM bots ORDER BY bot_id`), sql(`SELECT COUNT(*) n FROM bot_positions`)]);

before(async () => {
  persist = mkdtempSync(join(tmpdir(), "alpha-trial-int-"));
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  const args = ["wrangler", "dev", "--local", "--test-scheduled", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) args.push("--var", `${k}:${v}`);
  const { openSync } = await import("node:fs"); const LOGF = openSync(join(tmpdir(), "trial-int-worker.log"), "w");
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: ["ignore", LOGF, LOGF], shell: WIN, detached: !WIN });
  const end = Date.now() + 120000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  await act("fund", { action: "deposit", amount_usd: 100 });
});
after(async () => {
  try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ }
  await KRAKEN.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

describe("forward trial in the Worker (TEST)", () => {
  it("installed as PROPOSED; the scheduled job does nothing before activation", async () => {
    const r = await dash("/api/dashboard/trial");
    assert.equal(r.data.available, true); assert.equal(r.data.account.status, "PROPOSED");
    assert.match(r.data.label, /not part of your portfolio/);
    await scheduled();
    await new Promise((x) => setTimeout(x, 1500));
    assert.equal(sql(`SELECT COUNT(*) n FROM trial_events`)[0].n, 0);
  });
  it("activation needs the passphrase; once activated the scheduled job starts the trial; the portfolio is untouched", async () => {
    const before = portfolio();
    const no = await act("trial-activate", {}, null);
    assert.ok(no.http >= 400, "refused without the passphrase");
    assert.equal(sql(`SELECT status FROM trial_accounts`)[0].status, "PROPOSED");
    const yes = await act("trial-activate", {});
    assert.equal(yes.ok, true); assert.equal(yes.status, "ACTIVE");
    assert.equal((await act("trial-activate", {})).duplicate, true, "idempotent");
    await scheduled();
    for (let i = 0; i < 20 && !sql(`SELECT COUNT(*) n FROM trial_events WHERE kind = 'TRIAL_STARTED'`)[0].n; i++) await new Promise((x) => setTimeout(x, 500));
    assert.equal(sql(`SELECT COUNT(*) n FROM trial_events WHERE kind = 'TRIAL_STARTED'`)[0].n, 1);
    const r = await dash("/api/dashboard/trial");
    assert.equal(r.data.account.status, "ACTIVE"); assert.equal(r.data.equity.start_usd, 100); assert.equal(r.data.trades.completed, 0);
    assert.equal(r.data.settings.sma, 50); assert.equal(r.data.settings.short, false);
    assert.equal(portfolio(), before, "wallets, entries, bots and positions unchanged");
  });
  it("the report needs a session", async () => {
    assert.equal((await fetch(`${base}/api/dashboard/trial`)).status, 401);
  });
});

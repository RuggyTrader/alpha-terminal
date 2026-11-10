// engine/src/cli/sync-setup.mjs against a local Worker (`wrangler dev --local`, throwaway D1, no Alpaca keys):
// `check` passes only when the Worker is the D1-account version, the secret matches and the engine's saved state
// agrees with the ledger; `enable` turns sync on only then; the secret never appears in the output.
// (`rotate` stores the secret with `wrangler secret put`, which only exists for the real Cloudflare Worker; its
// refusal without confirmation is checked here.) Settings and state files are temporary, test-only.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startKrakenStub } from "./lib/kraken-stub.mjs";

// Market data from a local stand-in (test/lib/kraken-stub.mjs), not the live Kraken API: tests stay deterministic.
const KRAKEN = await startKrakenStub();

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = join(WORKER_DIR, "..", "engine", "src", "cli", "sync-setup.mjs");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret();
const DASHBOARD_PASSPHRASE = secret();
// 8805: its own port (8791 is auth.test.mjs; files run in parallel, and a shared port let the other Worker answer).
const PORT = 8805, BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), "alpha-sync-setup-"));
const work = mkdtempSync(join(tmpdir(), "alpha-sync-setup-engine-"));
const ENV_FILE = join(work, "engine.env");
const DATA = join(work, "data");
let worker;

const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 90000 });
const writeEnv = (secretValue, sync = "off") => writeFileSync(ENV_FILE, [
  "# test-only engine settings", "ENGINE_PROFILE=solusd-5m", "ENGINE_SYMBOL=SOLUSD", "ENGINE_INTERVAL_MIN=5",
  `ENGINE_DATA_DIR=${DATA}`, `ENGINE_SYNC=${sync}`, `ALPHA_API_BASE=${BASE}`, `ALPHA_WEBHOOK_SECRET=${secretValue}`, "",
].join("\n"));
const run = (...args) => {
  const r = spawnSync(process.execPath, [SETUP, ...args], { env: { ...process.env, ENGINE_ENV_FILE: ENV_FILE }, encoding: "utf8", timeout: 120000 });
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(!out.includes(WEBHOOK_SECRET), "the secret is never printed");
  return { code: r.status, out };
};
const STATE = join(DATA, "state-SOLUSD-5m.json");
const ENTRY_ID = `ENG-SOLUSD-5-${new Date(Math.floor(Date.now() / 300000) * 300000 - 300000).toISOString().replace(".000Z", "Z")}-BUY`;
/** An engine state file holding a long from ENTRY_ID (test-only; same shape the engine saves). */
const writeState = ({ qty = 0.5, side = 1, id = ENTRY_ID, sentQty = String(qty), status = "accepted" } = {}) => writeFileSync(STATE, JSON.stringify({
  openEntryId: id, strategy: { broker: { pos: { side, qty, avg: 0, entryId: "OTE Long" } } },
  outbox: [{ id, action: "BUY", kind: "ENTRY", qty: sentQty, status, code: "DRY_RUN_ACCEPTED" }],
}));
async function signal(action, qty, id) {
  const body = { secret: WEBHOOK_SECRET, id, symbol: "SOLUSD", timeframe: "5", action, strategy: "OTE Pro Strat (engine)", ...(qty === undefined ? {} : { qty }), timestamp: new Date().toISOString() };
  const r = await fetch(`${BASE}/webhook/dry-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
async function paper(cookie, kind, body) {
  const r = await fetch(`${BASE}/api/paper/${kind}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie },
    body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: randomBytes(9).toString("hex") }),
  });
  assert.equal(r.status, 200);
}
const syncValue = () => /ENGINE_SYNC=(\w+)/.exec(readFileSync(ENV_FILE, "utf8"))[1];

before(async () => {
  mkdirSync(DATA, { recursive: true });
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET: secret(), KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "" })) args.push("--var", `${k}:${v}`);
  worker = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  const end = Date.now() + 60000;
  let up = false;
  while (!up && Date.now() < end) {
    try { up = (await fetch(`${BASE}/health`)).status === 200; } catch { /* starting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error("Worker did not start");
});
after(() => {
  if (worker && worker.exitCode === null) {
    try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid, "SIGTERM"); } catch { /* gone */ }
  }
  for (const d of [persist, work]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
});

describe("engine sync setup (local Worker)", () => {
  it("the Worker reports that ALPHA PAPER risk reads its account from D1", async () => {
    const h = await (await fetch(`${BASE}/health`)).json();
    assert.equal(h.alpha_paper_account, "D1");
    assert.equal(h.alpaca_configured, false);
  });

  it("rotate refuses without explicit confirmation that no other client uses the old secret", () => {
    writeEnv("");
    const r = run("rotate");
    assert.equal(r.code, 2);
    assert.match(r.out, /Not rotated/);
  });

  it("check fails on an empty or wrong secret, and enable then leaves sync off", () => {
    writeEnv("");
    assert.match(run("check").out, /FAIL {2}webhook secret: ALPHA_WEBHOOK_SECRET is empty/);
    writeEnv(secret());
    const r = run("enable");
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}webhook secret accepted by the Worker: rejected/);
    assert.equal(syncValue(), "off");
  });

  it("an engine state holding a position the ledger does not hold blocks sync (no unmatched CLOSE)", () => {
    writeEnv(WEBHOOK_SECRET);
    const state = join(DATA, "state-SOLUSD-5m.json");
    writeFileSync(state, JSON.stringify({ openEntryId: "ENG-SOLUSD-5-2026-11-01T00:00:00Z-BUY", strategy: { broker: { pos: { side: 1, qty: 1 } } }, outbox: [] }));
    try {
      const r = run("enable");
      assert.equal(r.code, 1);
      assert.match(r.out, /FAIL {2}engine and ledger positions match: the engine's saved state holds long 1 .* that production does not hold; it would send an unmatched CLOSE/);
      assert.equal(syncValue(), "off");
    } finally {
      rmSync(state);
    }
  });

  it("against a real open ledger position: only an exact match passes; quantity, direction or a corrupt state fail", async () => {
    // Fund SOL and open a real ALPHA PAPER position through the webhook (live Kraken price, no Alpaca).
    const l = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
    const cookie = l.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
    await paper(cookie, "fund", { action: "deposit", amount_usd: 500 });
    await paper(cookie, "transfer", { from: "MAIN", to: "SOLUSD", amount_usd: 500 });
    const buy = await signal("BUY", 0.5, ENTRY_ID);
    assert.equal(buy.status, 200, JSON.stringify(buy.json));
    writeEnv(WEBHOOK_SECRET);
    try {
      writeState();
      const okRun = run("check");
      assert.equal(okRun.code, 0, okRun.out);
      assert.match(okRun.out, /PASS {2}engine and ledger positions match: same open position: SOLUSD long 0\.5 from ENG-SOLUSD-5-/);

      writeState({ qty: 0.6, sentQty: "0.6" }); // same opening id, different quantity
      let r = run("enable");
      assert.equal(r.code, 1);
      assert.match(r.out, /FAIL {2}engine and ledger positions match: positions differ: quantity: ledger 0\.5, engine 0\.6/);
      assert.equal(syncValue(), "off");

      writeState({ side: -1 }); // same id, opposite direction
      assert.match(run("check").out, /FAIL {2}engine and ledger positions match: positions differ: direction: ledger long, engine short/);

      writeState({ id: "ENG-SOLUSD-5-2026-11-01T00:00:00Z-BUY" }); // same details, other opening id
      assert.match(run("check").out, /FAIL {2}engine and ledger positions match: positions differ: opening alert id/);

      writeFileSync(STATE, "{ not json"); // unreadable state file
      assert.match(run("check").out, /FAIL {2}engine and ledger positions match: the engine's saved state could not be read/);

      rmSync(STATE);
      assert.match(run("check").out, /FAIL {2}engine and ledger positions match: production holds an open SOLUSD long 0\.5/);
    } finally {
      try { rmSync(STATE); } catch { /* gone */ }
      assert.equal((await signal("CLOSE", undefined, ENTRY_ID.replace("-BUY", "-CLOSE"))).status, 200);
    }
  });

  it("an unreachable ledger fails closed", () => {
    writeFileSync(ENV_FILE, readFileSync(ENV_FILE, "utf8").replace(`ALPHA_API_BASE=${BASE}`, "ALPHA_API_BASE=http://127.0.0.1:9"));
    const r = run("enable");
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}engine and ledger positions match: the production ledger answer is missing or unreadable/);
    assert.equal(syncValue(), "off");
  });

  it("all checks pass with the matching secret and a flat engine; enable sets ENGINE_SYNC=on and nothing else", () => {
    writeEnv(WEBHOOK_SECRET);
    const before = readFileSync(ENV_FILE, "utf8");
    const c = run("check");
    assert.equal(c.code, 0, c.out);
    for (const name of ["profile", "risk per trade", "no engine running", "Worker is PAPER with trading disabled",
      "Worker computes ALPHA PAPER risk from D1", "webhook secret accepted by the Worker", "engine and ledger positions match"]) {
      assert.match(c.out, new RegExp(`PASS {2}${name}`), name);
    }
    const e = run("enable");
    assert.equal(e.code, 0, e.out);
    assert.equal(syncValue(), "on");
    assert.equal(readFileSync(ENV_FILE, "utf8"), before.replace("ENGINE_SYNC=off", "ENGINE_SYNC=on"));
  });
});

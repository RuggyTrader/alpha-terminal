// Secure engine ↔ ALPHA TERMINAL synchronization setup. PAPER only. The webhook secret is never printed,
// logged, passed on a command line or written anywhere except Cloudflare and engine/.env (git-ignored).
//
//   node src/cli/sync-setup.mjs check
//       Read-only. Checks the Worker, the secret, the engine's saved state and the production ledger.
//   node src/cli/sync-setup.mjs rotate --confirm-no-other-clients
//       Generates a new random WEBHOOK_SECRET, stores it in Cloudflare (`wrangler secret put`, value on stdin)
//       and in engine/.env, then runs `check`. Every client still using the old secret (e.g. a TradingView
//       alert) stops working: confirm none is in use first. Sync stays off.
//   node src/cli/sync-setup.mjs enable
//       Runs `check`; only if every check passes, sets ENGINE_SYNC=on in engine/.env.
//
// It never starts the engine, never edits the engine's saved state, and never sends a signal.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadEnvFile } from "../config.mjs";

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_DIR = join(ENGINE_DIR, "..", "worker");
// ENGINE_ENV_FILE: another settings file (the tests use one for a local Worker).
const ENV_FILE = process.env.ENGINE_ENV_FILE ?? join(ENGINE_DIR, ".env");
const say = (m) => console.log(m);

/** Rewrites KEY=value lines in engine/.env in place (atomic), keeping every other line and comment. */
function setEnvValues(values) {
  const lines = readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && m[1] in values) { seen.add(m[1]); return `${m[1]}=${values[m[1]]}`; }
    return line;
  });
  for (const k of Object.keys(values)) if (!seen.has(k)) out.push(`${k}=${values[k]}`);
  const tmp = `${ENV_FILE}.tmp`;
  writeFileSync(tmp, out.join("\n"), { mode: 0o600 });
  renameSync(tmp, ENV_FILE);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function check() {
  const results = [];
  const ok = (name, pass, detail) => { results.push({ name, pass, detail }); say(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`); return pass; };

  if (!ok("engine/.env present", existsSync(ENV_FILE), ENV_FILE)) return false;
  const file = loadEnvFile(ENV_FILE);
  const cfg = loadConfig({ ...process.env, ENGINE_ENV_FILE: ENV_FILE, ENGINE_SYNC: "off" }, ENGINE_DIR); // never fails on sync

  ok("profile", cfg.profile === "solusd-5m" && cfg.symbol === "SOLUSD" && cfg.intervalMin === 5, `${cfg.profile}, ${cfg.symbol} ${cfg.intervalMin}m`);
  ok("risk per trade", cfg.inputs.riskUSD === 10, `$${cfg.inputs.riskUSD} (website setting confirmed by the engine: ${cfg.remoteSettings ? "on" : "off"})`);
  ok("Worker address", /^https:\/\/|^http:\/\/127\.0\.0\.1:/.test(cfg.apiBase), cfg.apiBase || "(not set)"); // http only on loopback (tests)

  const lock = join(cfg.dataDir, `engine-${cfg.symbol}-${cfg.intervalMin}m.lock`);
  const lockPid = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : 0;
  ok("no engine running", !(lockPid && alive(lockPid)), lockPid && alive(lockPid) ? `engine pid ${lockPid} is running; stop it first` : "none");

  let health = null;
  try { health = await (await fetch(`${cfg.apiBase}/health`, { signal: AbortSignal.timeout(15000) })).json(); } catch { /* below */ }
  ok("Worker is PAPER with trading disabled", health?.mode === "PAPER" && health?.enable_trading === false, health ? `mode ${health.mode}, enable_trading ${health.enable_trading}` : "no /health answer");
  ok("Worker computes ALPHA PAPER risk from D1 (no Alpaca needed)", health?.alpha_paper_account === "D1",
    health?.alpha_paper_account === "D1" ? "yes" : "the deployed Worker predates this change; deploy it first");

  let ledger = null;
  if (!cfg.webhookSecret) {
    ok("webhook secret", false, "ALPHA_WEBHOOK_SECRET is empty in engine/.env (run `rotate`)");
  } else {
    let status = 0;
    try {
      const r = await fetch(`${cfg.apiBase}/webhook/engine-ledger`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: cfg.webhookSecret, symbol: cfg.symbol }), signal: AbortSignal.timeout(15000),
      });
      status = r.status;
      if (r.ok) ledger = await r.json();
    } catch { /* status 0 */ }
    ok("webhook secret accepted by the Worker", status === 200, status === 200 ? "yes (read-only ledger view)" : status === 401 ? "rejected: engine/.env and Cloudflare differ" : `no answer (HTTP ${status})`);
  }

  // Engine saved state vs production ledger: never enable sync when the engine would send a CLOSE for a
  // position production does not hold, or production holds a position the engine does not know.
  const stateFile = join(cfg.dataDir, `state-${cfg.symbol}-${cfg.intervalMin}m.json`);
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
  const enginePos = state?.strategy?.broker?.pos ?? null;
  const ledgerPos = ledger?.position ?? null;
  if (ledger) {
    if (!enginePos && !ledgerPos) ok("engine and ledger positions match", true, `both flat${state ? "" : " (no saved engine state yet: it starts flat)"}`);
    else if (enginePos && ledgerPos && state?.openEntryId && ledgerPos.open_alert_id === state.openEntryId) ok("engine and ledger positions match", true, `same open position (${ledgerPos.open_alert_id})`);
    else ok("engine and ledger positions match", false, enginePos
      ? `the engine's saved state holds a position production does not hold as the same entry (${state?.openEntryId ?? "unknown"}); do not sync this state`
      : `production holds an open ${cfg.symbol} position (${ledgerPos.open_alert_id}) the engine did not open`);
  }

  const sync = (file.ENGINE_SYNC ?? "off") === "on";
  say(`info  ENGINE_SYNC is currently ${sync ? "on" : "off"}`);
  return results.every((r) => r.pass);
}

/** `wrangler secret put` with the value on stdin (never a command-line argument, never echoed). */
function putSecret(value) {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const p = spawn(win ? "npx.cmd" : "npx", ["wrangler", "secret", "put", "WEBHOOK_SECRET"], { cwd: WORKER_DIR, shell: win, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.stdin.end(value);
    p.on("close", (code) => resolve({ code, out: out.split(value).join("[hidden]") }));
  });
}

async function rotate() {
  if (!process.argv.includes("--confirm-no-other-clients")) {
    say("Not rotated. Rotation invalidates the current WEBHOOK_SECRET for every client (TradingView alerts, scripts).");
    say("Confirm none is in use (TradingView → Alerts: no alert with a webhook to the Worker), then rerun with --confirm-no-other-clients.");
    process.exit(2);
  }
  if (!existsSync(ENV_FILE)) { say(`missing ${ENV_FILE}`); process.exit(1); }
  const before = loadEnvFile(ENV_FILE);
  if ((before.ENGINE_SYNC ?? "off") === "on") { say("ENGINE_SYNC is on: stop the engine and set it off before rotating."); process.exit(1); }

  let secret = randomBytes(32).toString("base64url"); // 256 bits
  say("Storing a new WEBHOOK_SECRET in Cloudflare (the value is not shown)…");
  const r = await putSecret(secret);
  const okLine = /Success/i.test(r.out);
  if (r.code !== 0 || !okLine) {
    say(`Cloudflare did not confirm (exit ${r.code}). Nothing was written to engine/.env. Output:\n${r.out.trim()}`);
    process.exit(1);
  }
  say("Cloudflare: secret stored (this also publishes a new Worker version with the same code).");
  setEnvValues({ ALPHA_WEBHOOK_SECRET: secret, ENGINE_SYNC: "off" });
  secret = "";
  say("engine/.env: secret stored; ENGINE_SYNC stays off.");

  // The new version takes a few seconds to answer with the new secret.
  for (let i = 0; i < 12; i++) {
    const cfg = loadConfig({ ...process.env, ENGINE_ENV_FILE: ENV_FILE, ENGINE_SYNC: "off" }, ENGINE_DIR);
    const s = await fetch(`${cfg.apiBase}/webhook/engine-ledger`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: cfg.webhookSecret, symbol: cfg.symbol }) }).then((x) => x.status).catch(() => 0);
    if (s === 200) break;
    await new Promise((res) => setTimeout(res, 5000));
  }
  say("\nChecks:");
  const pass = await check();
  say(pass ? "\nAll checks passed. Enable sync with: node src/cli/sync-setup.mjs enable" : "\nSome checks failed; sync stays off.");
}

async function enable() {
  const pass = await check();
  if (!pass) { say("\nSync NOT enabled: fix the failed checks first."); process.exit(1); }
  setEnvValues({ ENGINE_SYNC: "on" });
  say("\nENGINE_SYNC=on. Start one engine: `node src/cli/run.mjs --once` (first heartbeat confirms the $10 setting), then `npm start`.");
}

const cmd = process.argv[2];
if (cmd === "check") process.exit((await check()) ? 0 : 1);
else if (cmd === "rotate") await rotate();
else if (cmd === "enable") await enable();
else { say("usage: node src/cli/sync-setup.mjs check | rotate --confirm-no-other-clients | enable"); process.exit(2); }

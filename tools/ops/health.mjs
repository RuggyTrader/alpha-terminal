#!/usr/bin/env node
// ALPHA TERMINAL operational health (READ-ONLY). Combines the engine host's own records (lock files, audit trail,
// saved state, the pause setting in engine.env) with the authoritative Worker ledger (SELECT-only D1 queries) and
// reports, per bot, separate facts instead of one "ONLINE":
//   engine running · Worker connected · market data fresh · ledger synchronized · orders reconcile ·
//   entries enabled (engine layer) · entries enabled (Worker layer) · pause agreement · position management available
// It never prints secrets (only the ENGINE_PAUSED_BOTS / ENGINE_STRICT_FILL / ENGINE_BOTS keys are read from engine.env),
// never writes to the database and never starts, stops or changes anything.
//   node tools/ops/health.mjs [--root %USERPROFILE%\AlphaTerminal] [--json] [--no-ledger]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const ROOT = arg("root", join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "AlphaTerminal"));
const STATE = join(ROOT, "engine-state"), PROD = join(ROOT, "engine-prod");
const now = Date.now();
const TF = { "ALPHA-01": 1, "ALPHA-02": 5, "ALPHA-03": 1, "ALPHA-04": 5 };
const FILE = { "ALPHA-01": "ALPHA-01-SOLUSD-1m", "ALPHA-02": "SOLUSD-5m", "ALPHA-03": "ALPHA-03-BTCUSD-1m", "ALPHA-04": "ALPHA-04-BTCUSD-5m" };

/** Only three non-secret keys are read from the engine's env file. */
export function engineSettings(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(ENGINE_PAUSED_BOTS|ENGINE_STRICT_FILL|ENGINE_BOTS)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return { bots: (out.ENGINE_BOTS ?? "").split(",").map((x) => x.trim()).filter(Boolean), paused: new Set((out.ENGINE_PAUSED_BOTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)),
    strictFill: out.ENGINE_STRICT_FILL === "on" };
}

/** Last records of each kind from a JSONL audit trail (reads only the tail). */
export function auditTail(text) {
  const last = {};
  for (const line of text.trim().split("\n").slice(-4000)) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    last[r.type] = r;
    if (r.type === "signal" && r.code === "ENTRIES_PAUSED") last.paused_skip = r;
  }
  return last;
}

/** Per-bot verdicts from the gathered facts (pure; tested). */
export function assess(bot, f) {
  const tf = TF[bot] ?? 5, age = (iso) => (iso ? Math.round((now - Date.parse(iso)) / 1000) : null);
  const candleClose = f.lastCandle ? Date.parse(f.lastCandle) + tf * 60_000 : null;
  const marketAge = candleClose ? Math.round((now - candleClose) / 1000) : null;
  const facts = {
    engine_running: !!f.lockAlive && (age(f.lastAuditAt) ?? 1e9) <= Math.max(3 * tf * 60, 240),
    worker_connected: f.lastHeartbeat === "ok" && (age(f.lastHeartbeatAt) ?? 1e9) <= 3600 ? true : f.lastHeartbeat === "ok",
    market_data_fresh: marketAge !== null && marketAge <= (3 * tf * 60 + 120),
    ledger_synchronized: f.ledgerCheck === "OK",
    entries_enabled_engine: !f.enginePaused,
    entries_enabled_worker: f.workerPaused === null ? null : !f.workerPaused,
    position_management: !!f.lockAlive && f.ledgerCheck !== "UNVERIFIED",
  };
  const issues = [];
  if (!facts.engine_running) issues.push("engine not running or not processing (no recent audit record / lock)");
  if (!facts.market_data_fresh) issues.push(`market data stale (last candle ${f.lastCandle ?? "none"})`);
  if (!facts.ledger_synchronized) issues.push(`ledger check ${f.ledgerCheck ?? "unknown"}`);
  if (f.workerPaused !== null && f.enginePaused !== f.workerPaused) issues.push(`pause disagreement: engine ${f.enginePaused ? "PAUSED" : "enabled"}, Worker ${f.workerPaused ? "PAUSED" : "enabled"}`);
  if (f.ledgerPending && (!f.engineLive || f.engineLive.id !== f.ledgerPending)) issues.push(`order mismatch: ledger pending ${f.ledgerPending}, engine live ${f.engineLive?.id ?? "none"}${f.engineLive?.cancelled ? " (cancelled)" : ""}`);
  if (f.ledgerOpen && !f.engineHolds) issues.push(`position mismatch: the ledger has an open ${f.ledgerOpen} the engine does not hold`);
  if (f.enginePaused && f.ordersSincePause > 0) issues.push(`a paused bot placed ${f.ordersSincePause} order(s) after its pause`);
  return { bot, facts, issues, status: issues.length ? "ATTENTION" : "OK", detail: { last_candle: f.lastCandle, market_age_s: marketAge, last_heartbeat: f.lastHeartbeatAt, ledger_check: f.ledgerCheck, engine_live_order: f.engineLive?.id ?? null, ledger_pending: f.ledgerPending ?? null, ledger_open: f.ledgerOpen ?? null } };
}

function d1(sql) {
  const W = fileURLToPath(new URL("../../worker/node_modules/wrangler/bin/wrangler.js", import.meta.url));
  const out = execFileSync(process.execPath, [W, "d1", "execute", "alpha-terminal-db", "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 90_000, cwd: fileURLToPath(new URL("../../worker/", import.meta.url)) });
  return JSON.parse(out)[0].results;
}

function main() {
  const env = existsSync(join(PROD, "config", "engine.env")) ? engineSettings(readFileSync(join(PROD, "config", "engine.env"), "utf8")) : { bots: [], paused: new Set(), strictFill: false };
  const release = existsSync(join(PROD, "current")) ? readFileSync(join(PROD, "current"), "utf8").trim() : null;
  let ledger = null;
  if (!process.argv.includes("--no-ledger")) {
    try {
      ledger = {
        bots: Object.fromEntries(d1("SELECT bot_id, entries_paused, status FROM bots").map((r) => [r.bot_id, r])),
        pending: Object.fromEntries(d1("SELECT bot_id, order_id FROM bot_pending_orders WHERE status = 'PENDING'").map((r) => [r.bot_id, r.order_id])),
        open: Object.fromEntries(d1("SELECT bot_id, side, trade_id FROM bot_positions WHERE status = 'OPEN'").map((r) => [r.bot_id, r])),
        orders24h: d1("SELECT bot_id, received_at FROM bot_pending_orders WHERE received_at >= datetime('now', '-1 day')"),
      };
    } catch (e) { ledger = { error: String(e.message ?? e).slice(0, 160) }; }
  }
  const report = { checked_at: new Date(now).toISOString(), engine_release: release, strict_fill_engine: env.strictFill, ledger_error: ledger?.error ?? null, bots: [] };
  for (const bot of env.bots.length ? env.bots : Object.keys(FILE)) {
    const f = { enginePaused: env.paused.has(bot), workerPaused: ledger?.bots ? !!ledger.bots[bot]?.entries_paused : null };
    const auditFile = join(STATE, `audit-${FILE[bot]}.jsonl`), stateFile = join(STATE, `state-${FILE[bot]}.json`), lock = join(STATE, `engine-${FILE[bot]}.lock`);
    f.lockAlive = existsSync(lock) && now - statSync(lock).mtimeMs < 24 * 3600_000;
    if (existsSync(auditFile)) {
      const a = auditTail(readFileSync(auditFile, "utf8"));
      f.lastAuditAt = Object.values(a).map((r) => r.at).sort().at(-1);
      f.lastCandle = a.candle?.t ?? null; f.lastHeartbeat = a.heartbeat?.result ?? null; f.lastHeartbeatAt = a.heartbeat?.at ?? null;
      f.ledgerCheck = a.ledger_check?.status ?? null; f.pausedSkipAt = a.paused_skip?.at ?? null;
    }
    if (existsSync(stateFile)) {
      const s = JSON.parse(readFileSync(stateFile, "utf8"));
      f.engineLive = s.liveOrder ?? null; f.engineHolds = !!s.strategy?.broker?.pos && !!s.openEntryId;
    }
    if (ledger?.bots) {
      f.ledgerPending = ledger.pending[bot] ?? null; f.ledgerOpen = ledger.open[bot] ? `${ledger.open[bot].side} ${ledger.open[bot].trade_id}` : null;
      f.ordersSincePause = f.enginePaused && f.pausedSkipAt ? ledger.orders24h.filter((o) => o.bot_id === bot && o.received_at > f.pausedSkipAt).length : 0;
    }
    report.bots.push(assess(bot, f));
  }
  report.status = report.bots.some((b) => b.status !== "OK") || report.ledger_error ? "ATTENTION" : "OK";
  if (process.argv.includes("--json")) { console.log(JSON.stringify(report, null, 1)); return; }
  console.log(`ALPHA TERMINAL health ${report.checked_at} · engine ${release ?? "?"} · strict fill (engine) ${env.strictFill ? "on" : "off"} · ${report.status}`);
  if (report.ledger_error) console.log(`  ledger query failed: ${report.ledger_error}`);
  for (const b of report.bots) {
    const x = b.facts, yn = (v) => (v === null ? "?" : v ? "yes" : "NO");
    console.log(`  ${b.bot} ${b.status}: running ${yn(x.engine_running)} · connected ${yn(x.worker_connected)} · data fresh ${yn(x.market_data_fresh)} · ledger ${yn(x.ledger_synchronized)} · entries engine ${yn(x.entries_enabled_engine)} / Worker ${yn(x.entries_enabled_worker)} · exits managed ${yn(x.position_management)}`);
    for (const i of b.issues) console.log(`     - ${i}`);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

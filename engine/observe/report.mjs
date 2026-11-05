// Observation report: reads a run's audit log, metrics and local D1 and writes <run>/report.md (also printed).
// It only reports what was recorded; it never fills in missing data. Kraken's public OHLC is fetched once to
// check that every completed candle in the window was processed with the same values.
//   node observe/report.mjs [--run <dir>] [--no-kraken]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCompletedCandles, krakenBase } from "../src/kraken.mjs";
import { d1, enginePaths, fmtDur, readJson, readJsonl, runDir, runInfo } from "./lib.mjs";

const run = runDir();
const info = runInfo(run);
const paths = enginePaths(run);
const audit = readJsonl(paths.audit);
const metrics = readJsonl(join(run, "metrics.jsonl"));
const state = readJson(paths.state);
const STEP = 5 * 60_000;
const lines = [];
const say = (s = "") => lines.push(s);
const ms = (s) => Date.parse(s);

say(`# Observation report: ${info.id ?? run}`);
say(`Generated ${new Date().toISOString()}. PAPER only (local dev Worker + its own D1; no broker, no production).`);
say();
const startedMs = ms(info.started_at);
const endMs = info.stopped_at ? ms(info.stopped_at) : Date.now();
say(`- Profile: ${info.profile}, ${info.symbol} ${info.timeframe}. Planned: ${info.planned_hours} h.`);
say(`- Started ${info.started_at}; ${info.stopped_at ? `stopped ${info.stopped_at}` : "still running"}. Elapsed: ${fmtDur((endMs - startedMs) / 1000)}.`);
const elapsedH = (endMs - startedMs) / 3_600_000;
say(`- Planned duration reached: ${elapsedH >= (info.planned_hours ?? 48) ? "yes" : `no (${elapsedH.toFixed(1)} of ${info.planned_hours} h)`}.`);
say();

// ---- Process starts / restarts / gaps in monitoring (sleep, hangs)
const starts = audit.filter((r) => r.type === "process_start");
const stops = audit.filter((r) => r.type === "process_stop");
const restartsLog = existsSync(join(run, "restarts.log")) ? readFileSync(join(run, "restarts.log"), "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
const exits = restartsLog.filter((l) => / exited /.test(l));
say("## Processes and restarts");
say(`- Engine process starts: ${starts.length} (${starts.filter((s) => s.resumed).length} resumed from saved state). Clean stops: ${stops.length}.`);
say(`- Loop exits (crash or stop, then restart): ${exits.length}${exits.length ? "" : " (none)"}`);
for (const l of exits.slice(-20)) say(`  - ${l}`);
const gaps = metrics.filter((m) => m.since_prev_s !== null && m.since_prev_s > 150);
say(`- Monitor samples: ${metrics.length}. Gaps over 150 s between samples (PC asleep or monitor stalled): ${gaps.length}`);
for (const g of gaps.slice(0, 20)) say(`  - ${g.at}: ${fmtDur(g.since_prev_s)} since the previous sample`);
say();

// ---- Candles
const live = audit.filter((r) => r.type === "candle" && !r.warmup);
const warm = audit.filter((r) => r.type === "candle" && r.warmup);
const seen = new Map();
for (const c of live) seen.set(c.t, (seen.get(c.t) ?? 0) + 1);
const dups = [...seen].filter(([, n]) => n > 1);
const liveTimes = [...seen.keys()].map(ms).sort((a, b) => a - b);
const missing = [];
for (let i = 1; i < liveTimes.length; i++) for (let t = liveTimes[i - 1] + STEP; t < liveTimes[i]; t += STEP) missing.push(new Date(t).toISOString());
say("## Candles");
say(`- Warm-up candles (history, never sent): ${warm.length}. Live completed candles processed: ${live.length}${liveTimes.length ? ` (${new Date(liveTimes[0]).toISOString()} to ${new Date(liveTimes.at(-1)).toISOString()})` : ""}.`);
say(`- Missing between first and last live candle: ${missing.length}${missing.length ? `: ${missing.slice(0, 30).join(", ")}${missing.length > 30 ? " ..." : ""}` : ""}.`);
say(`- Candles processed more than once: ${dups.length}${dups.length ? `: ${dups.slice(0, 10).map(([t, n]) => `${t} x${n}`).join(", ")}` : ""}.`);
// Kraken returns trade-less 5m bars as gaps; the engine's gap handling is recorded as "reset" entries.
if (!process.argv.includes("--no-kraken") && liveTimes.length) {
  try {
    const kr = await fetchCompletedCandles({ symbol: info.symbol, intervalMin: 5, base: krakenBase() });
    const byT = new Map(kr.map((k) => [k.t, k]));
    const covered = kr.filter((k) => k.t >= liveTimes[0] && k.t <= liveTimes.at(-1));
    const notProcessed = covered.filter((k) => !seen.has(new Date(k.t).toISOString()));
    const diff = [];
    for (const c of live) {
      const k = byT.get(ms(c.t));
      if (!k) continue;
      if (["o", "h", "l", "c"].some((f) => Math.abs(Number(k[f]) - Number(c[f])) > 1e-9)) diff.push(`${c.t} engine ${c.o}/${c.h}/${c.l}/${c.c} vs Kraken now ${k.o}/${k.h}/${k.l}/${k.c}`);
    }
    const oldest = kr.length ? new Date(kr[0].t).toISOString() : "n/a";
    say(`- Kraken check (OHLC fetched now; Kraken keeps the last 720 candles, oldest ${oldest}): ${covered.length} Kraken candles in the live window; not processed by the engine: ${notProcessed.length}; OHLC differences: ${diff.length}.`);
    for (const k of notProcessed.slice(0, 20)) say(`  - not processed: ${new Date(k.t).toISOString()}`);
    for (const d of diff.slice(0, 20)) say(`  - differs: ${d}`);
    if (liveTimes[0] < kr[0]?.t) say(`  - Note: live candles before ${oldest} can no longer be checked against Kraken OHLC.`);
  } catch (e) { say(`- Kraken check failed: ${e.message ?? e}`); }
}
say();

// ---- Strategy decisions
const evCount = {};
const notable = [];
for (const c of live) for (const e of c.events ?? []) {
  evCount[e.type] = (evCount[e.type] ?? 0) + 1;
  if (/FILL|ORDER|CANCEL|EXIT|ENTRY|STOP|TRAIL|BREAK/i.test(e.type)) notable.push(`${c.t} ${e.type} ${JSON.stringify(e)}`);
}
say("## Strategy decisions (live candles)");
say(`- Event counts: ${Object.keys(evCount).length ? Object.entries(evCount).map(([k, v]) => `${k} ${v}`).join(", ") : "none"}.`);
for (const n of notable.slice(0, 60)) say(`  - ${n}`);
if (notable.length > 60) say(`  - ... ${notable.length - 60} more in the audit log`);
say();

// ---- Signals and the Worker
const sig = audit.filter((r) => r.type === "signal");
say("## Signals sent to the local Worker");
say(sig.length ? "" : "- No signals were finalised (no simulated entries or exits on live candles).");
for (const s of sig) say(`- ${s.at} ${s.id} ${s.action}: ${s.status}${s.code ? ` ${s.code}` : ""}${s.reason ? ` (${s.reason})` : ""}${s.delayed_min ? `, delayed ${s.delayed_min} min` : ""}, attempts ${s.attempts}`);
const pend = (state?.outbox ?? []).filter((x) => x.status === "pending");
if (pend.length) say(`- Still pending at report time: ${pend.map((x) => x.id).join(", ")}`);
say();

// ---- Ledger (D1) and cross-check
say("## ALPHA PAPER ledger (local D1)");
try {
  const alerts = d1(run, "SELECT alert_id, received_at, action, status, response_code, rejection_reason, requested_qty, accepted_qty FROM alerts ORDER BY id") ?? [];
  const fills = d1(run, "SELECT alert_id, side, kind, qty, price, price_source, realized_pnl, filled_at FROM paper_fills ORDER BY id") ?? [];
  const positions = d1(run, "SELECT id, status, qty, avg_entry_price, open_alert_id, close_alert_id, realized_pnl, opened_at, closed_at FROM paper_positions ORDER BY id") ?? [];
  const trades = d1(run, "SELECT id, direction, status, entry_qty, entry_avg_price, exit_avg_price, realized_pnl, open_alert_id, close_alert_id, opened_at, closed_at FROM trades WHERE source = 'ALPHA_PAPER' ORDER BY id") ?? [];
  say(`- Alerts received: ${alerts.length}. Paper fills: ${fills.length}. Positions: ${positions.length} (${positions.filter((p) => p.status === "OPEN").length} open). Paper trades: ${trades.length}.`);
  for (const a of alerts) say(`  - alert ${a.alert_id} ${a.action}: ${a.status} ${a.response_code ?? ""}${a.rejection_reason ? ` (${a.rejection_reason})` : ""}`);
  for (const f of fills) say(`  - fill ${f.alert_id} ${f.side} ${f.kind} qty ${f.qty} @ ${f.price} (${f.price_source}) pnl ${f.realized_pnl} at ${f.filled_at}`);
  for (const t of trades) say(`  - trade #${t.id} ${t.direction} ${t.status} ${t.entry_qty} @ ${t.entry_avg_price} -> ${t.exit_avg_price ?? "open"}, P&L ${t.realized_pnl} (${t.open_alert_id} -> ${t.close_alert_id ?? "-"})`);
  // Cross-check the engine's view against the ledger.
  const issues = [];
  const byAlert = new Map(alerts.map((a) => [a.alert_id, a]));
  const final = new Map(sig.map((s) => [s.id, s]));
  for (const s of sig) {
    const a = byAlert.get(s.id);
    if (s.status === "accepted" && !a) issues.push(`${s.id}: engine says accepted, no alert in D1`);
    if (s.status === "accepted" && !fills.some((f) => f.alert_id === s.id)) issues.push(`${s.id}: accepted but no paper fill`);
    if (s.status === "rejected" && a && fills.some((f) => f.alert_id === s.id)) issues.push(`${s.id}: engine says rejected but D1 has a fill`);
  }
  for (const a of alerts) if (a.alert_id.startsWith("ENG-") && !final.has(a.alert_id) && !pend.some((x) => x.id === a.alert_id)) issues.push(`${a.alert_id}: in D1 but not recorded by the engine`);
  for (const p of positions) if (p.status === "CLOSED" && !trades.some((t) => t.open_alert_id === p.open_alert_id)) issues.push(`position ${p.id}: closed without a trade row`);
  const open = positions.find((p) => p.status === "OPEN");
  if ((open?.open_alert_id ?? null) !== (state?.openEntryId && final.get(state.openEntryId)?.status === "accepted" ? state.openEntryId : null) && (open || state?.openEntryId)) {
    issues.push(`open position: ledger ${open?.open_alert_id ?? "none"}, engine ${state?.openEntryId ?? "none"} (${final.get(state?.openEntryId)?.status ?? "not sent"})`);
  }
  say(`- Engine vs ledger discrepancies: ${issues.length ? issues.length : "none found"}.`);
  for (const i of issues) say(`  - ${i}`);
} catch (e) { say(`- Could not read the local D1: ${e.message ?? e}`); }
const lc = audit.filter((r) => r.type === "ledger_check");
say(`- Engine ledger check changes: ${lc.length ? lc.map((r) => `${r.at} ${r.status}${r.issues?.length ? ` (${r.issues.join("; ")})` : ""}`).join(" | ") : "none recorded"}.`);
say();

// ---- Heartbeats, dashboard, errors
const hb = audit.filter((r) => r.type === "heartbeat");
const bot = {};
for (const m of metrics) { const k = m.dashboard?.bot ?? (m.dashboard?.error ? "DASHBOARD_ERROR" : "n/a"); bot[k] = (bot[k] ?? 0) + 1; }
const health = metrics.filter((m) => m.health?.status !== 200);
say("## Heartbeats, dashboard, API");
say(`- Heartbeat result changes: ${hb.length ? hb.map((r) => `${r.at} ${typeof r.result === "string" ? r.result : JSON.stringify(r.result)}`).slice(-20).join(" | ") : "none recorded"}.`);
say(`- Dashboard bot state per monitor sample: ${Object.entries(bot).map(([k, v]) => `${k} ${v}`).join(", ") || "n/a"}.`);
say(`- Worker /health failures: ${health.length} of ${metrics.length} samples${health.length ? ` (first ${health[0].at}, last ${health.at(-1).at})` : ""}.`);
const errs = audit.filter((r) => r.type === "error");
const byWhere = {};
for (const e of errs) byWhere[e.where ?? "?"] = (byWhere[e.where ?? "?"] ?? 0) + 1;
say(`- Engine errors: ${errs.length}${errs.length ? ` (${Object.entries(byWhere).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}.`);
for (const e of errs.slice(-15)) say(`  - ${e.at} ${e.where}: ${e.message}`);
const resets = audit.filter((r) => r.type === "reset");
say(`- Data-gap re-warms: ${resets.length}${resets.length ? `: ${resets.map((r) => `${r.at} ${r.reason}`).join("; ")}` : ""}.`);
say();

// ---- CPU / RAM
say("## CPU and RAM (sum of each process tree; CPU % of one core)");
for (const name of ["engine", "worker"]) {
  const s = metrics.map((m) => m[name]).filter((x) => x?.alive);
  const cpu = s.map((x) => x.cpu_pct).filter((x) => x !== null && x !== undefined);
  const ram = s.map((x) => x.rss_mb);
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : "n/a");
  say(`- ${name}: samples ${s.length}, CPU avg ${avg(cpu)}% max ${cpu.length ? Math.max(...cpu) : "n/a"}%, RAM avg ${avg(ram)} MB max ${ram.length ? Math.max(...ram) : "n/a"} MB (first ${ram[0] ?? "n/a"}, last ${ram.at(-1) ?? "n/a"} MB).`);
  const dead = metrics.filter((m) => m[name] && !m[name].alive).length;
  if (dead) say(`  - not running in ${dead} samples`);
}
say();
say("Raw evidence in this folder: engine-data/audit-SOLUSD-5m.jsonl, metrics.jsonl, engine.log, worker.log, restarts.log, d1/.");

const text = lines.join("\n");
writeFileSync(join(run, "report.md"), `${text}\n`);
console.log(text);

// Observation monitor: once a minute appends one sample to <run>/metrics.jsonl with the CPU and RAM of the
// engine and Worker process trees, Worker /health, what the dashboard shows for the bot, and the engine's own
// state (last candle, outbox counts, last error). Read-only: it never sends signals or changes anything.
//   node observe/monitor.mjs --run <dir> [--once]
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { dashboard, enginePaths, readEnv, readJson, runDir, runInfo } from "./lib.mjs";

const run = runDir();
const info = runInfo(run);
const base = `http://127.0.0.1:${info.port ?? 8787}`;
const secrets = readEnv(join(run, "secrets.env"));
const out = join(run, "metrics.jsonl");
const paths = enginePaths(run);
let prev = null; // { at, cpu: { worker, engine } } for CPU % between samples

/** Every process on the machine (Windows), so the loops' process trees can be summed. */
function processes() {
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return JSON.parse(raw);
}

function tree(all, rootPid) {
  const kids = new Map();
  for (const p of all) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const root = all.find((p) => p.ProcessId === rootPid);
  if (!root) return null;
  const seen = [root];
  for (let i = 0; i < seen.length; i++) for (const c of kids.get(seen[i].ProcessId) ?? []) if (c.ProcessId !== seen[i].ProcessId) seen.push(c);
  // The loop's own powershell.exe is included; it is idle while its child runs.
  return {
    processes: seen.length,
    names: [...new Set(seen.map((p) => p.Name))],
    rss_mb: Math.round(seen.reduce((a, p) => a + Number(p.WorkingSetSize ?? 0), 0) / 1048576),
    cpu_s: seen.reduce((a, p) => a + (Number(p.KernelModeTime ?? 0) + Number(p.UserModeTime ?? 0)) / 1e7, 0),
  };
}

async function sample() {
  const at = Date.now();
  const rec = { at: new Date(at).toISOString(), since_prev_s: prev ? Math.round((at - prev.at) / 1000) : null };
  const pids = readJson(join(run, "pids.json"), {});
  try {
    const all = processes();
    for (const name of ["worker", "engine"]) {
      const t = pids[name] ? tree(all, pids[name]) : null;
      if (!t) { rec[name] = { alive: false }; continue; }
      const dt = prev ? (at - prev.at) / 1000 : null;
      const pc = prev?.cpu?.[name];
      // CPU % of one core over the interval; null when the tree's process set changed (a restart).
      const cpu_pct = dt && pc !== undefined && t.cpu_s >= pc ? Math.round(((t.cpu_s - pc) / dt) * 1000) / 10 : null;
      rec[name] = { alive: true, processes: t.processes, rss_mb: t.rss_mb, cpu_pct, cpu_total_s: Math.round(t.cpu_s * 10) / 10 };
    }
  } catch (e) { rec.process_error = String(e.message ?? e).slice(0, 200); }
  rec.system = { free_mb: Math.round(freemem() / 1048576), total_mb: Math.round(totalmem() / 1048576) };

  try {
    const t0 = Date.now();
    const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
    rec.health = { status: h.status, ms: Date.now() - t0 };
  } catch (e) { rec.health = { status: null, error: String(e.cause?.code ?? e.message ?? e).slice(0, 120) }; }
  try {
    const d = await dashboard(base, secrets.DASHBOARD_PASSPHRASE);
    const s = d.bot?.status ?? {};
    rec.dashboard = {
      bot: d.bot?.state ?? null, age_s: d.bot?.age_seconds ?? null, ledger_check: s.ledger_check?.status ?? null,
      position: s.position ?? null, outbox: s.outbox ?? null, last_error: s.last_error ?? null,
    };
  } catch (e) { rec.dashboard = { error: String(e.message ?? e).slice(0, 160) }; }

  const st = readJson(paths.state);
  if (st) {
    const box = st.outbox ?? [];
    const count = (k) => box.filter((x) => x.status === k).length;
    rec.engine_state = {
      last_candle: st.lastCandle?.t ?? null, candles_processed: st.candlesProcessed ?? null, last_poll: st.lastPollAt ?? null,
      strategy_status: st.strategy?.status ?? null, open_entry: st.openEntryId ?? null, ledger_check: st.ledgerCheck?.status ?? null,
      outbox: { pending: count("pending"), accepted: count("accepted"), rejected: count("rejected"), skipped: count("skipped"), historical: count("historical") },
      last_error: st.lastError ?? null, resets: (st.resets ?? []).length,
    };
  } else rec.engine_state = null;

  appendFileSync(out, `${JSON.stringify(rec)}\n`);
  prev = { at, cpu: { worker: undefined, engine: undefined } };
  for (const name of ["worker", "engine"]) if (rec[name]?.alive) prev.cpu[name] = rec[name].cpu_total_s;
}

await sample();
if (!process.argv.includes("--once")) {
  const loop = async () => { try { await sample(); } catch (e) { console.error(`${new Date().toISOString()} monitor: ${e.stack ?? e}`); } };
  setInterval(loop, 60_000);
}

// Quick status of the observation run: is everything alive, latest candle, bot state, signals, errors.
//   node engine/observe/status.mjs [--run <dir>]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { enginePaths, fmtDur, OBS_DIR, readJson, readJsonl, runDir, runInfo } from "./lib.mjs";

const run = runDir();
const info = runInfo(run);
const active = existsSync(join(OBS_DIR, "CURRENT"));
const metrics = readJsonl(join(run, "metrics.jsonl"));
const m = metrics.at(-1) ?? {};
const audit = readJsonl(enginePaths(run).audit);
const st = readJson(enginePaths(run).state);
const now = Date.now();
const age = (iso) => (iso ? fmtDur((now - Date.parse(iso)) / 1000) : "n/a");
const live = audit.filter((r) => r.type === "candle" && !r.warmup);
const signals = audit.filter((r) => r.type === "signal");
const errors = audit.filter((r) => r.type === "error");
const starts = audit.filter((r) => r.type === "process_start").length;

console.log(`Run ${info.id} (${active ? "ACTIVE" : "not active"}), PAPER ${info.symbol} ${info.timeframe}, profile ${info.profile}`);
console.log(`  elapsed ${age(info.started_at)} of ${info.planned_hours} h planned${info.stopped_at ? `; stopped ${info.stopped_at}` : ""}`);
const sampleAgeS = m.at ? (now - Date.parse(m.at)) / 1000 : null;
if (sampleAgeS === null || sampleAgeS > 180) {
  console.log(`  WARNING: the newest monitor sample is ${age(m.at)} old, so the lines below are NOT current. The run has probably stopped (PC shut down, restarted or slept). Check restarts.log and the Windows System log.`);
}
console.log(`  last monitor sample ${age(m.at)} ago: worker ${m.worker?.alive ? `up ${m.worker.rss_mb} MB ${m.worker.cpu_pct ?? "-"}%` : "DOWN"}, engine ${m.engine?.alive ? `up ${m.engine.rss_mb} MB ${m.engine.cpu_pct ?? "-"}%` : "DOWN"}, /health ${m.health?.status ?? m.health?.error ?? "n/a"}`);
console.log(`  dashboard bot at that sample ${m.dashboard?.bot ?? m.dashboard?.error ?? "n/a"} (heartbeat then ${m.dashboard?.age_s ?? "n/a"} s old), ledger check ${st?.ledgerCheck?.status ?? "n/a"}`);
console.log(`  last candle ${st?.lastCandle?.t ?? "n/a"} (close ${st?.lastCandle?.close ?? "n/a"}), live candles processed ${live.length}, strategy ${st?.strategy?.status ?? "n/a"}`);
console.log(`  signals finalised ${signals.length}${signals.length ? `: ${signals.slice(-5).map((s) => `${s.id} ${s.status}${s.code ? `/${s.code}` : ""}`).join(", ")}` : ""}; pending ${(st?.outbox ?? []).filter((x) => x.status === "pending").length}`);
console.log(`  engine starts ${starts}, errors ${errors.length}${errors.length ? ` (last: ${errors.at(-1).at} ${errors.at(-1).where}: ${errors.at(-1).message})` : ""}`);
console.log(`Folder: ${run}`);
console.log(`Full report: node engine/observe/report.mjs`);

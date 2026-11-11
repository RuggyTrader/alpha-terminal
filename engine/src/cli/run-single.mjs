// Runs the PAPER engine until stopped. Restart-safe: state is saved after every step and one instance per
// data directory is enforced with a lock file. Suitable for a service manager (systemd, NSSM, Task Scheduler).
//   node src/cli/run.mjs            (settings from engine/.env or the environment)
//   node src/cli/run.mjs --once     (a single poll, then exit)

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, redacted } from "../config.mjs";
import { EngineRunner } from "../runner.mjs";

const cfg = loadConfig();
const lock = join(cfg.dataDir, `engine-${cfg.symbol}-${cfg.intervalMin}m.lock`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const runner = new EngineRunner(cfg, { log: (m) => console.log(`${new Date().toISOString()} ${m}`) });
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  if (pid && pid !== process.pid && alive(pid)) {
    console.error(`another engine (pid ${pid}) is already running for ${cfg.symbol} ${cfg.intervalMin}m; exiting`);
    process.exit(1);
  }
}
writeFileSync(lock, String(process.pid));
const release = () => { try { if (Number(readFileSync(lock, "utf8")) === process.pid) rmSync(lock); } catch { /* gone */ } };
console.log(`${new Date().toISOString()} [engine] PAPER only, no broker orders. config ${JSON.stringify(redacted(cfg))}`);
runner.audit({ type: "process_start", pid: process.pid, node: process.version, profile: cfg.profile, symbol: cfg.symbol, timeframe: `${cfg.intervalMin}m`, resumed: runner.state !== null });

let stopping = false;
let timer = null;
const stop = (sig) => {
  if (stopping) return;
  stopping = true;
  console.log(`${new Date().toISOString()} [engine] ${sig}: stopping after the current step`);
  runner.audit({ type: "process_stop", pid: process.pid, signal: sig });
  if (timer) clearTimeout(timer);
  release();
  process.exit(0);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

if (process.argv.includes("--once")) {
  await runner.tick();
  release();
  process.exit(0);
}

const loop = async () => {
  if (stopping) return;
  try {
    await runner.tick();
  } catch (e) {
    console.error(`${new Date().toISOString()} [engine] step failed: ${e.stack ?? e}`);
  }
  // Next poll: shortly after the next candle closes, or the regular poll interval, whichever is sooner.
  const step = cfg.intervalMin * 60_000;
  const untilClose = step - (Date.now() % step) + 5_000;
  timer = setTimeout(loop, Math.min(untilClose, cfg.pollSeconds * 1000));
};
await loop();

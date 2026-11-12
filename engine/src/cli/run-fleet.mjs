// Fleet process: several independent bots in one process (started by run.mjs when ENGINE_BOTS is set).
//   ENGINE_BOTS=ALPHA-02 node src/cli/run.mjs [--once]
// PAPER only. One lock per bot, with the SAME lock name a single engine would use for that bot's files, so a bot can
// never be run by two processes (a single engine and a fleet, or two fleets) at once.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { botList, loadBotConfigs, redacted } from "../config.mjs";
import { FleetRunner } from "../fleet.mjs";

const bots = loadBotConfigs(botList());
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const locks = bots.map(({ cfg }) => join(cfg.dataDir, `engine-${cfg.fileTag}.lock`));
for (const lock of locks) {
  if (!existsSync(lock)) continue;
  const pid = Number(readFileSync(lock, "utf8"));
  if (pid && pid !== process.pid && alive(pid)) {
    console.error(`another engine (pid ${pid}) already runs ${lock}; exiting`);
    process.exit(1);
  }
}
for (const lock of locks) writeFileSync(lock, String(process.pid));
const release = () => { for (const lock of locks) { try { if (Number(readFileSync(lock, "utf8")) === process.pid) rmSync(lock); } catch { /* gone */ } } };
const stamp = () => new Date().toISOString();

const fleet = new FleetRunner(bots, { log: (m) => console.log(`${stamp()} ${m}`) });
console.log(`${stamp()} [fleet] PAPER only, no broker orders. bots ${fleet.bots.map((b) => `${b.id} ${b.bot.symbol} ${b.bot.intervalMin}m`).join(", ")}; config ${JSON.stringify(redacted({ ...bots[0].cfg, botId: "(per bot)", symbol: "(per bot)" }))}`);
for (const b of fleet.bots) b.runner.audit({ type: "process_start", pid: process.pid, node: process.version, bot_id: b.id, profile: b.runner.cfg.profile, symbol: b.bot.symbol, timeframe: `${b.bot.intervalMin}m`, mode: "fleet", resumed: b.runner.state !== null });

let stopping = false;
const stop = (sig) => {
  if (stopping) return;
  stopping = true;
  console.log(`${stamp()} [fleet] ${sig}: stopping`);
  for (const b of fleet.bots) { try { b.runner.audit({ type: "process_stop", pid: process.pid, signal: sig }); } catch { /* best effort */ } }
  release();
  process.exit(0);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

if (process.argv.includes("--once")) {
  const r = await fleet.round();
  console.log(`${stamp()} [fleet] ${JSON.stringify(r)}`);
  release();
  process.exitCode = r.every((x) => x.ok) ? 0 : 3;
} else {
  const pollMs = Math.max(5, bots[0].cfg.pollSeconds) * 1000;
  for (;;) {
    if (stopping) break;
    await fleet.round();
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

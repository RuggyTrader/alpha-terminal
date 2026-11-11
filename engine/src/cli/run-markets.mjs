// Mirror-only multi-market process (started by run.mjs when ENGINE_MARKETS is set). PAPER only, hypothetical only:
// no funded signal, transfer or broker order exists in this process. One lock per market in the data folder; a
// market already run by another engine is refused, so no mirror account is ever fed by two processes.
//   ENGINE_MARKETS=BTCUSD,ETHUSD ENGINE_MIRROR=on node src/cli/run.mjs [--once]

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMarketConfigs, redacted } from "../config.mjs";
import { MarketsRunner } from "../markets.mjs";

const configs = loadMarketConfigs();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const locks = configs.map((c) => join(c.dataDir, `engine-${c.symbol}-${c.intervalMin}m.lock`));
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

const markets = new MarketsRunner(configs, { log: (m) => console.log(`${stamp()} ${m}`) });
console.log(`${stamp()} [markets] PAPER, mirror-only (hypothetical), no funded signals or broker orders. markets ${configs.map((c) => c.symbol).join(", ")}; config ${JSON.stringify(redacted({ ...configs[0], symbol: "(per market)" }))}`);
for (const m of markets.markets) m.runner.audit({ type: "process_start", pid: process.pid, node: process.version, profile: m.runner.cfg.profile, symbol: m.symbol, timeframe: `${m.runner.cfg.intervalMin}m`, mode: "mirror-only", resumed: m.runner.mirror !== null });

let stopping = false;
const stop = (sig) => {
  if (stopping) return;
  stopping = true;
  console.log(`${stamp()} [markets] ${sig}: stopping`);
  for (const m of markets.markets) { try { m.runner.audit({ type: "process_stop", pid: process.pid, signal: sig }); } catch { /* best effort */ } }
  release();
  process.exit(0);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

if (process.argv.includes("--once")) {
  const r = await markets.round();
  console.log(`${stamp()} [markets] ${JSON.stringify(r)}`);
  release();
  // Let Node exit on its own once the round is done. process.exit() while fetch sockets are still closing trips a
  // libuv assertion on Windows (UV_HANDLE_CLOSING) and turns a clean run into a crash exit code.
  process.exitCode = r.every((x) => x.ok) ? 0 : 3;
} else {
  const pollMs = Math.max(5, configs[0].pollSeconds) * 1000;
  for (;;) {
    if (stopping) break;
    await markets.round();
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

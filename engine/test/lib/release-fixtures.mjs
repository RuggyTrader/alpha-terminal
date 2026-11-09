// Shared fixtures for the release and state-migration tests. Test-only; never used by the engine.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CANDLES = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;

/**
 * `git clone --shared`, retried: on Windows a real-time scanner can briefly lock a just-written script during checkout
 * ("unable to stat just-written file"), which is unrelated to what the tests check.
 */
export function cloneRepo(repo, dest) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { execFileSync("git", ["clone", "--quiet", "--shared", repo, dest], { stdio: ["ignore", "pipe", "pipe"] }); return; } catch (e) {
      last = e;
      rmSync(dest, { recursive: true, force: true });
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 1500)"]);
    }
  }
  throw last;
}

/**
 * Local stand-in for Kraken's public OHLC endpoint serving the committed real SOLUSD 5m fixture, in its OWN process
 * (test/lib/ohlc-server.mjs): engines started with spawnSync block the test's event loop, so an in-process server could
 * never answer them. `visible` completed candles are available, so a test can release new market candles step by step.
 */
export async function startOhlcStub(visible = CANDLES.length - 1) {
  const control = join(mkdtempSync(join(tmpdir(), "alpha-ohlc-")), "visible");
  writeFileSync(control, String(visible));
  const child = spawn(process.execPath, [join(HERE, "ohlc-server.mjs"), control], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((res, rej) => {
    child.stdout.once("data", (d) => res(Number(String(d).trim())));
    child.once("exit", (c) => rej(new Error(`OHLC stand-in exited (${c})`)));
  });
  child.unref();
  return {
    base: `http://127.0.0.1:${port}`,
    show: (n) => writeFileSync(control, String(n)),
    close: async () => { child.kill(); rmSync(dirname(control), { recursive: true, force: true }); },
  };
}

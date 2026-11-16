// Every Worker test starts its own local Worker on a FIXED port. If something is already listening there (for example a
// server left behind by an interrupted earlier run), the test would silently talk to THAT server - with a different
// passphrase and database - and fail with misleading assertions (found 2026-11-16: orphaned servers on 8821/8822/8837
// made the engine-lifecycle and funded-sizing tests fail as "no LONG executed"). This makes that an explicit error.
import { execFileSync } from "node:child_process";

const PROBE = "const s=require('net').createServer();s.once('error',e=>process.exit(e.code==='EADDRINUSE'?3:4));s.listen(Number(process.argv[1]),'127.0.0.1',()=>s.close(()=>process.exit(0)))";

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const free = (port) => { try { execFileSync(process.execPath, ["-e", PROBE, String(port)], { stdio: "ignore", timeout: 10000 }); return true; } catch (e) { if (e.status === 3) return false; throw e; } };

/** Throws unless every given port on 127.0.0.1 is free (synchronous, so it works in any setup function). A port that a
 *  test has just released (it stopped its own server to restart it) is waited for, up to `waitMs`. */
export function assertPortFree(...ports) {
  const waitMs = 20_000;
  for (const port of ports) {
    const end = Date.now() + waitMs;
    while (!free(port)) {
      if (Date.now() > end) throw new Error(`port ${port} is still in use by another process after ${waitMs / 1000} s (a stale local Worker from an interrupted run?); stop it first - a test must never run against a server it did not start`);
      sleep(250);
    }
  }
}

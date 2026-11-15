// Graceful stop for unattended upgrades: the engine honours a stop request between rounds (saves, releases its locks,
// exits 0) and the supervisor does not restart it; a stale request never blocks the engine after a reboot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveLocks } from "../deploy/release.mjs";

const engineDir = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("a fleet engine with a stop request exits 0 at once, releases every lock and records the stop", () => {
  const d = mkdtempSync(join(tmpdir(), "graceful-"));
  const stop = join(d, "stop.request");
  writeFileSync(stop, "{}");
  writeFileSync(join(d, "e.env"), "ENGINE_SYNC=off\n");
  const r = spawnSync(process.execPath, ["src/cli/run.mjs"], {
    cwd: engineDir, encoding: "utf8", timeout: 30000,
    env: { ...process.env, ENGINE_ENV_FILE: join(d, "e.env"), ENGINE_DATA_DIR: d, ENGINE_STOP_FILE: stop, ENGINE_BOTS: "ALPHA-02,ALPHA-04", ENGINE_APPROVED_BOTS: "ALPHA-04", ENGINE_SYNC: "off" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /STOP_REQUEST: stopping/);
  assert.deepEqual(readdirSync(d).filter((f) => f.endsWith(".lock")), [], "no lock left behind");
  const audits = readdirSync(d).filter((f) => f.startsWith("audit-"));
  assert.ok(audits.length >= 2, "both bots audited");
  for (const a of audits) assert.match(readFileSync(join(d, a), "utf8"), /"process_stop".*"STOP_REQUEST"/);
});

test("liveLocks: a live pid counts (also when it cannot be signalled), a dead pid does not", () => {
  const d = mkdtempSync(join(tmpdir(), "locks-"));
  writeFileSync(join(d, "engine-A.lock"), String(process.pid));
  writeFileSync(join(d, "engine-B.lock"), "999999");
  assert.deepEqual(liveLocks(d).map((x) => x.lock), ["engine-A.lock"]);
  assert.deepEqual(liveLocks(join(d, "missing")), []);
});

test("the supervisor honours a fresh stop request, removes a stale one and passes the request file to the engine", () => {
  const ps = readFileSync(new URL("../deploy/run-release.ps1", import.meta.url), "utf8");
  assert.match(ps, /control\\stop\.request/);
  assert.match(ps, /TotalMinutes -gt 15/);
  assert.match(ps, /\$env:ENGINE_STOP_FILE = \$stopFile/);
  assert.match(ps, /if \(Test-StopRequest\) \{ Write-Log "stop requested; the supervisor exits without starting the engine"; exit 0 \}/);
  assert.match(ps, /engine stopped on request; the supervisor exits \(no restart\)/);
  assert.ok(existsSync(new URL("../deploy/release.mjs", import.meta.url)));
});

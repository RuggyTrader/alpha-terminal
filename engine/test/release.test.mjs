// Version-pinned production releases (deploy/release.mjs, deploy/run-release.ps1). Everything runs in a temporary
// clone and temporary roots; the development checkout, the real scheduled task and the live engine are never touched.
//   node --test test/release.test.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { activate, appDataProblem, installLauncher, prepare, resolveRef, rollback, selftest, status, taskXml, validate, verifyTree } from "../deploy/release.mjs";
import { cloneRepo, startOhlcStub } from "./lib/release-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Test roots live in the system temp folder (under %LOCALAPPDATA%), which the release tool refuses for production
// roots (packaged-app redirection; see deploy/release.mjs appDataProblem). Lifted for these temporary test folders only.
process.env.ALPHA_RELEASE_ALLOW_APPDATA = "1";
const ENGINE = join(HERE, "..");
const REPO = join(ENGINE, "..");
const WIN = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "alpha-release-"));
const clone = join(work, "repo");
const root = join(work, "prod");
const g = (...a) => execFileSync("git", ["-C", clone, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tool = (...a) => spawnSync(process.execPath, [join(ENGINE, "deploy", "release.mjs"), ...a], { encoding: "utf8" });
const taskAction = () => (WIN ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "(Get-ScheduledTask -TaskName 'ALPHA TERMINAL Engine' -ErrorAction SilentlyContinue).Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments + ' ' + $_.WorkingDirectory }"], { encoding: "utf8" }).stdout.trim() : "");

// Local stand-in for Kraken's public OHLC endpoint (its own process: engines run with spawnSync block this one).
let kraken, krakenBase = "";
let C1, C2, taskBefore;

before(async () => {
  taskBefore = taskAction();
  kraken = await startOhlcStub();
  krakenBase = kraken.base;
  cloneRepo(REPO, clone);
  g("config", "user.email", "release-test@example.invalid"); g("config", "user.name", "release test");
  // C1: the clone's HEAD plus this checkout's (possibly uncommitted) release tooling, committed in the CLONE only.
  for (const f of ["release.mjs", "run-release.ps1"]) copyFileSync(join(ENGINE, "deploy", f), join(clone, "engine", "deploy", f));
  g("add", "engine/deploy"); g("commit", "--quiet", "--allow-empty", "-m", "release tooling (test clone)");
  C1 = g("rev-parse", "HEAD");
  // Production-shaped configuration, outside every release.
  mkdirSync(join(root, "config"), { recursive: true });
  // ENGINE_FRESH_START_OK: these tests start from an empty state on purpose (state hand-over: state-migration.test.mjs).
  writeFileSync(join(root, "config", "engine.env"), ["ENGINE_PROFILE=solusd-5m", "ENGINE_SYNC=off", `KRAKEN_API_BASE=${krakenBase}`, "ENGINE_FRESH_START_OK=yes"].join("\n") + "\n");
});
after(async () => {
  await kraken?.close();
  try { rmSync(work, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

describe("release references", () => {
  it("accepts a full commit SHA and a tag; refuses branches, HEAD, short SHAs and expressions", () => {
    assert.equal(resolveRef(clone, C1).refType, "commit");
    g("tag", "engine-test-v1", C1);
    assert.deepEqual([resolveRef(clone, "engine-test-v1").commit, resolveRef(clone, "engine-test-v1").refType], [C1, "tag"]);
    const branch = g("rev-parse", "--abbrev-ref", "HEAD");
    for (const bad of [branch, "HEAD", C1.slice(0, 12), `${C1}~1`, "origin/v1.2.0-cloudflare", "refs/heads/" + branch, ""]) {
      assert.throws(() => resolveRef(clone, bad), /SHA|branch|tag|revision|required/, bad);
    }
    g("branch", "ambiguous-name", C1); g("tag", "ambiguous-name", C1);
    assert.throws(() => resolveRef(clone, "ambiguous-name"), /both a tag and a branch/);
  });
});

describe("production location guard", () => {
  it("refuses a release root or state folder under %LOCALAPPDATA% / %APPDATA% (redirected for packaged apps)", { skip: !process.env.LOCALAPPDATA && "Windows only" }, () => {
    delete process.env.ALPHA_RELEASE_ALLOW_APPDATA;
    try {
      const bad = join(process.env.LOCALAPPDATA, "AlphaTerminal-guard-test", "engine-prod");
      assert.throws(() => prepare({ repo: clone, ref: C1, root: bad }), /redirects that folder for packaged apps/);
      assert.throws(() => installLauncher({ repo: clone, ref: C1, root: bad }), /redirects that folder/);
      assert.equal(existsSync(bad), false, "nothing was created");
      assert.equal(appDataProblem(join(process.env.USERPROFILE, "AlphaTerminal", "engine-prod"), "root"), null, "%USERPROFILE%\AlphaTerminal is fine");
      assert.match(appDataProblem(join(process.env.APPDATA, "x"), "state folder"), /state folder/);
    } finally {
      process.env.ALPHA_RELEASE_ALLOW_APPDATA = "1";
    }
  });
});

describe("prepare, verify, repeat", () => {
  it("copies only runtime files from git objects, with a checksum manifest", () => {
    const r = prepare({ repo: clone, ref: C1, root });
    assert.equal(r.result, "prepared");
    const dir = join(root, "releases", C1.slice(0, 12));
    const v = verifyTree(dir);
    assert.equal(v.ok, true, v.problems.join("; "));
    const files = Object.keys(v.manifest.files);
    for (const need of ["src/cli/run.mjs", "src/runner.mjs", "src/ote.mjs", "src/broker.mjs", "src/config.mjs", "profiles/solusd-5m.env", "package.json"]) assert.ok(files.includes(need), need);
    for (const f of files) assert.ok(!/^(test|data|runs|parity|observations)\/|research|baseline|fill-semantics|ledger-price-gap|equity-svg|history-chunks|\.env$/.test(f) || f.startsWith("profiles/"), `not a runtime file: ${f}`);
    assert.ok(!files.some((f) => f.startsWith("deploy/")), "the release holds the engine only; the launcher is installed separately");
    assert.equal(v.manifest.commit, C1);
  });

  it("repeated preparation is a verified no-op; a tampered release is refused and detected", () => {
    const dir = join(root, "releases", C1.slice(0, 12));
    const before = readFileSync(join(dir, "RELEASE.json"), "utf8");
    assert.equal(prepare({ repo: clone, ref: C1, root }).result, "already prepared (unchanged)");
    assert.equal(readFileSync(join(dir, "RELEASE.json"), "utf8"), before);
    appendFileSync(join(dir, "src", "ote.mjs"), "\n// tampered\n");
    assert.equal(verifyTree(dir).ok, false);
    assert.throws(() => prepare({ repo: clone, ref: C1, root }), /does not verify/);
    writeFileSync(join(dir, "extra.mjs"), "x");
    assert.match(verifyTree(dir).problems.join(";"), /unexpected file extra\.mjs/);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(prepare({ repo: clone, ref: C1, root }).result, "prepared");
  });

  it("a new development commit does not change the pinned release", () => {
    const dir = join(root, "releases", C1.slice(0, 12));
    const pinned = readFileSync(join(dir, "src", "ote.mjs"), "utf8");
    appendFileSync(join(clone, "engine", "src", "ote.mjs"), "\n// development change after the release was pinned\n");
    g("commit", "--quiet", "-am", "development change");
    C2 = g("rev-parse", "HEAD");
    assert.notEqual(C2, C1);
    assert.equal(readFileSync(join(dir, "src", "ote.mjs"), "utf8"), pinned);
    assert.equal(verifyTree(dir).ok, true);
    // Even an uncommitted working-tree edit in the checkout never enters a release (files come from git objects).
    appendFileSync(join(clone, "engine", "src", "runner.mjs"), "\n// uncommitted\n");
    prepare({ repo: clone, ref: C2, root });
    assert.ok(!readFileSync(join(root, "releases", C2.slice(0, 12), "src", "runner.mjs"), "utf8").includes("uncommitted"));
    assert.ok(readFileSync(join(root, "releases", C2.slice(0, 12), "src", "ote.mjs"), "utf8").includes("development change after"));
  });
});

describe("configuration and activation", () => {
  it("validates the production profile and fixed $10 risk with the release's own config code; data forced outside releases", () => {
    const v = validate({ root, release: C1.slice(0, 12), expectProfile: "solusd-5m", expectRisk: 10 });
    assert.equal(v.ok, true, v.problems.join("; "));
    assert.equal(v.config.riskUSD, 10);
    assert.equal(v.config.allowLong, true);
    assert.equal(v.config.allowShort, true);
    assert.equal(v.config.dataDir, join(root, "data"), "default state folder");
    assert.equal(v.config.secret, "(not set)");
  });

  it("missing or invalid configuration fails safely and nothing is activated", () => {
    const cfg = join(root, "config", "engine.env");
    const good = readFileSync(cfg, "utf8");
    try {
      rmSync(cfg);
      assert.match(validate({ root, release: C1.slice(0, 12) }).problems.join(";"), /no configuration file/);
      writeFileSync(cfg, good + "ENGINE_SYNC=on\n"); // sync without API base and secret
      assert.match(validate({ root, release: C1.slice(0, 12) }).problems.join(";"), /rejected/);
      writeFileSync(cfg, good.replace("ENGINE_PROFILE=solusd-5m", "ENGINE_PROFILE=does-not-exist"));
      assert.equal(validate({ root, release: C1.slice(0, 12) }).ok, false);
      writeFileSync(cfg, good + "ENGINE_DATA_DIR=relative\\path\n");
      assert.match(validate({ root, release: C1.slice(0, 12) }).problems.join(";"), /must be an absolute path/);
      writeFileSync(cfg, good + `ENGINE_DATA_DIR=${join(root, "releases", "x")}\n`);
      assert.match(validate({ root, release: C1.slice(0, 12) }).problems.join(";"), /inside the releases folder/);
      writeFileSync(cfg, good + `ENGINE_DATA_DIR=${join(clone, "engine", "data")}\n`);
      assert.match(validate({ root, release: C1.slice(0, 12) }).problems.join(";"), /inside the git work tree/);
      writeFileSync(cfg, good.replace("ENGINE_FRESH_START_OK=yes", ""));
      assert.match(validate({ root, release: C1.slice(0, 12) }).problems.join(";"), /no saved engine state/);
      writeFileSync(cfg, good.replace("ENGINE_PROFILE=solusd-5m", "ENGINE_PROFILE=paper-test"));
      assert.match(validate({ root, release: C1.slice(0, 12), expectProfile: "solusd-5m", expectRisk: 10 }).problems.join(";"), /profile is paper-test/);
      assert.throws(() => activate({ root, release: C1.slice(0, 12), expectProfile: "solusd-5m", expectRisk: 10 }), /does not validate/);
      assert.equal(existsSync(join(root, "current")), false);
    } finally {
      writeFileSync(cfg, good);
    }
  });

  it("activate, status, rollback: pointers only; state in data\\ is preserved across release changes", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    const state = join(root, "data", "audit-SOLUSD-5m.jsonl");
    writeFileSync(state, JSON.stringify({ marker: "isolated test state" }) + "\n");
    activate({ root, release: C1.slice(0, 12), expectProfile: "solusd-5m", expectRisk: 10 });
    activate({ root, release: C2.slice(0, 12), expectProfile: "solusd-5m", expectRisk: 10 });
    let s = status({ root });
    assert.deepEqual([s.current.commit, s.previous.commit, s.current.files_verified], [C2, C1, true]);
    const r = rollback({ root });
    assert.equal(r.commit, C1);
    s = status({ root });
    assert.deepEqual([s.current.commit, s.previous.commit], [C1, C2]);
    assert.equal(JSON.parse(readFileSync(state, "utf8").trim()).marker, "isolated test state");
    assert.deepEqual(s.history.map((h) => h.action).slice(-3), ["activate", "activate", "rollback"]);
    rmSync(state);
  });

  it("the CLI refuses a branch reference and reports JSON errors", () => {
    const r = tool("prepare", "--repo", clone, "--ref", "ambiguous-name", "--root", root);
    assert.equal(r.status, 2);
    assert.match(JSON.parse(r.stdout).error, /both a tag and a branch/);
    const s = tool("status", "--root", root);
    assert.equal(s.status, 0);
    assert.equal(JSON.parse(s.stdout).current.commit, C1);
  });
});

describe("running the pinned release (isolated)", () => {
  it("self-test: one engine poll from the release with throwaway state; the release stays unchanged", () => {
    const r = selftest({ root, release: C1.slice(0, 12), krakenBase });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.state_files.some((f) => f.startsWith("state-SOLUSD-5m")));
    assert.ok(r.candles_processed >= 700, `real candles were fetched and processed (${r.candles_processed} of the fixture's 720)`);
    assert.equal(existsSync(join(root, "data", "state-SOLUSD-5m.json")), false, "the self-test never writes the root's state");
  });

  it("a second engine on the same data directory is refused", async () => {
    const dir = join(root, "releases", C1.slice(0, 12));
    const env = { ...process.env, ENGINE_ENV_FILE: join(root, "config", "engine.env"), ENGINE_DATA_DIR: join(work, "dup-data") };
    const first = spawn(process.execPath, ["src/cli/run.mjs"], { cwd: dir, env, stdio: "ignore" });
    try {
      const lock = join(work, "dup-data", "engine-SOLUSD-5m.lock");
      const end = Date.now() + 30000;
      while (!existsSync(lock) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
      assert.ok(existsSync(lock), "first engine holds the lock");
      const second = spawnSync(process.execPath, ["src/cli/run.mjs", "--once"], { cwd: dir, env, encoding: "utf8", timeout: 30000 });
      assert.equal(second.status, 1);
      assert.match(second.stderr, /another engine \(pid \d+\) is already running/);
    } finally {
      first.kill();
    }
  });

  it("launcher (-Once): a simulated restart loads the ACTIVE pinned release, not a development checkout", { skip: !WIN && "Windows launcher" }, () => {
    g("tag", "launcher-test", C1);
    installLauncher({ repo: clone, ref: C1, root });
    assert.equal(verifyTree(join(root, "bin")).ok, true);
    const run = () => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "bin", "run-release.ps1"), "-Root", root, "-Node", process.execPath, "-Once"], { encoding: "utf8", timeout: 180000 });
    let r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const sup = readFileSync(join(root, "logs", "supervisor.log"), "utf8");
    assert.match(sup, new RegExp(`active release ${C1.slice(0, 12)} commit ${C1}`));
    assert.match(sup, /profile solusd-5m, risk \$10/);
    assert.ok(sup.includes(`starting engine from ${join(root, "releases", C1.slice(0, 12))}`));
    assert.ok(!sup.includes(REPO), "never the development checkout");
    assert.ok(existsSync(join(root, "data", "state-SOLUSD-5m.json")), "state written to <root>\\data");
    // After a rollback-target switch, the next start runs the other release, keeping the same state file.
    activate({ root, release: C2.slice(0, 12) });
    r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(join(root, "logs", "supervisor.log"), "utf8"), new RegExp(`active release ${C2.slice(0, 12)} commit ${C2}`));
    // A tampered active release is never started.
    appendFileSync(join(root, "releases", C2.slice(0, 12), "src", "runner.mjs"), "\n// tampered\n");
    r = run();
    assert.equal(r.status, 4);
    assert.match(readFileSync(join(root, "logs", "supervisor.log"), "utf8"), /does not verify; not starting/);
  });

  it("task-xml: exports the real task read-only; the pinned definition differs only in its action; nothing registered", { skip: (!WIN || !taskBefore) && "needs the Windows task" }, () => {
    const r = taskXml({ root, node: process.execPath });
    assert.equal(r.installed_matches_original, true);
    assert.equal(r.unchanged_outside_action, true, "triggers, settings, principal and conhost command are untouched");
    assert.match(r.command, /conhost\.exe$/i);
    assert.ok(r.pinned_arguments.includes(join(root, "bin", "run-release.ps1")) && !r.pinned_arguments.includes(REPO));
    const pinned = readFileSync(r.pinned, "utf16le");
    assert.ok(pinned.includes(`<WorkingDirectory>${root}</WorkingDirectory>`));
    // original.xml is written once and never overwritten; repeating is safe.
    const first = readFileSync(r.original);
    taskXml({ root, node: process.execPath });
    assert.deepEqual(readFileSync(r.original), first);
    assert.equal(taskAction(), taskBefore, "the installed task's action is exactly as before the tests");
  });
});

// Engine state across setup switches: original (development-checkout) engine → pinned release → faulty release →
// release rollback → back to the original engine → full revert. Everything runs in temporary folders with a temporary
// clone and a local Kraken OHLC stand-in serving the committed real SOLUSD fixture; the live engine, its state and the
// scheduled task are never touched.
//   node --test test/state-migration.test.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { activate, envValue, installLauncher, migrateState, prepare, revertState, rollback, runtimeFiles, stateCheck, supervisorDataDir, validate } from "../deploy/release.mjs";
import { cloneRepo, startOhlcStub } from "./lib/release-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "..");
const REPO = join(ENGINE, "..");
const WIN = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "alpha-state-"));
const clone = join(work, "repo");
const oldEngine = join(work, "dev-checkout", "engine"); // stands in for outputs\alpha-terminal\engine
const root = join(work, "engine-prod");
const shared = join(work, "engine-state");                // the ONE state folder after migration
const STATE = "state-SOLUSD-5m.json";
const STEP = 20; // new market candles released per step
const g = (...a) => execFileSync("git", ["-C", clone, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let kraken, visible = 300, C1, C2, C3;
const history = []; // every state check, in order

/** The original setup: what run-windows-production.ps1 runs (cwd = engine folder, settings from engine\.env). */
const cleanEnv = () => { const e = { ...process.env }; delete e.ENGINE_ENV_FILE; delete e.ENGINE_DATA_DIR; return e; };
const runOld = () => spawnSync(process.execPath, ["src/cli/run.mjs", "--once"], { cwd: oldEngine, encoding: "utf8", timeout: 120000, env: cleanEnv() });
/** The pinned setup: the installed launcher, exactly as the scheduled task would start it (one poll). */
const runPinned = () => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "bin", "run-release.ps1"), "-Root", root, "-Node", process.execPath, "-Once"], { encoding: "utf8", timeout: 180000 });
const supLog = () => readFileSync(join(root, "logs", "supervisor.log"), "utf8");
const state = (dir) => { const s = stateCheck({ dir }); assert.equal(s.ok, true, JSON.stringify(s)); return s.states.find((x) => x.file === STATE); };
const outbox = (dir) => JSON.parse(readFileSync(join(dir, STATE), "utf8")).outbox.map((x) => `${x.id}|${x.status}`);

/** After each step: exactly STEP new candles processed, no fresh warm-up, every earlier signal kept once. */
function advanced(prev, cur, label) {
  assert.equal(cur.candlesProcessed - prev.candlesProcessed, STEP, `${label}: candles processed`);
  assert.equal(Date.parse(cur.lastCandle) - Date.parse(prev.lastCandle), STEP * 5 * 60_000, `${label}: last candle advanced by exactly ${STEP} candles`);
  assert.equal(cur.warmedUpAt, prev.warmedUpAt, `${label}: no fresh warm-up`);
  assert.equal(cur.resets, prev.resets, `${label}: no state reset`);
  assert.equal(cur.duplicate_signal_ids, 0, `${label}: no duplicated signal`);
  history.push({ label, lastCandle: cur.lastCandle, candlesProcessed: cur.candlesProcessed, signals: cur.signals });
}

before(async () => {
  kraken = await startOhlcStub(visible);
  cloneRepo(REPO, clone);
  g("config", "user.email", "state-test@example.invalid"); g("config", "user.name", "state test");
  for (const f of ["release.mjs", "run-release.ps1"]) copyFileSync(join(ENGINE, "deploy", f), join(clone, "engine", "deploy", f));
  g("add", "engine/deploy"); g("commit", "--quiet", "--allow-empty", "-m", "release tooling (test clone)");
  C1 = g("rev-parse", "HEAD");
  // C2: a faulty release (crashes at start). C3: a release whose strategy settings differ (would discard the state).
  writeFileSync(join(clone, "engine", "src", "cli", "run.mjs"), `throw new Error("simulated faulty release");\n` + readFileSync(join(clone, "engine", "src", "cli", "run.mjs"), "utf8"));
  g("commit", "--quiet", "-am", "faulty release"); C2 = g("rev-parse", "HEAD");
  g("checkout", "--quiet", C1, "--", "engine/src/cli/run.mjs");
  appendFileSync(join(clone, "engine", "profiles", "solusd-5m.env"), "STRAT_SWING_LEN=6\n");
  g("commit", "--quiet", "-am", "different strategy settings"); C3 = g("rev-parse", "HEAD");
  // The original engine folder, as in the development checkout: runtime files, its supervisor, engine\.env, engine\data.
  for (const [p, buf] of runtimeFiles(clone, C1)) { mkdirSync(dirname(join(oldEngine, p)), { recursive: true }); writeFileSync(join(oldEngine, p), buf); }
  mkdirSync(join(oldEngine, "deploy"), { recursive: true });
  copyFileSync(join(clone, "engine", "deploy", "run-windows-production.ps1"), join(oldEngine, "deploy", "run-windows-production.ps1"));
  execFileSync("git", ["init", "--quiet", join(work, "dev-checkout")]); // like the real development checkout: a git work tree
  writeFileSync(join(oldEngine, ".env"), ["# test engine settings", "ENGINE_PROFILE=solusd-5m", "ENGINE_SYNC=off", `KRAKEN_API_BASE=${kraken.base}`, "ALPHA_WEBHOOK_SECRET=test-only-not-a-secret"].join("\r\n") + "\r\n");
  // The pinned layout (prepared and activated, but holding no state yet).
  prepare({ repo: clone, ref: C1, root }); prepare({ repo: clone, ref: C2, root }); prepare({ repo: clone, ref: C3, root });
  installLauncher({ repo: clone, ref: C1, root });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "engine.env"), ["ENGINE_PROFILE=solusd-5m", "ENGINE_SYNC=off", `KRAKEN_API_BASE=${kraken.base}`].join("\n") + "\n");
});
after(async () => {
  await kraken?.close();
  try { rmSync(work, { recursive: true, force: true }); } catch { /* locked on Windows */ }
});

describe("engine state across every switch", () => {
  it("1. the original engine runs with saved state (warm-up, then new candles)", () => {
    let r = runOld();
    assert.equal(r.status, 0, r.stderr);
    const s0 = state(join(oldEngine, "data"));
    assert.ok(s0.candlesProcessed >= 290 && s0.warmedUpAt);
    history.push({ label: "original engine, warm-up", lastCandle: s0.lastCandle, candlesProcessed: s0.candlesProcessed, signals: s0.signals });
    kraken.show(visible += STEP);
    r = runOld();
    assert.equal(r.status, 0, r.stderr);
    advanced(s0, state(join(oldEngine, "data")), "original engine");
  });

  it("2. before migration the pinned layout refuses to start (it would begin from empty state)", () => {
    assert.match(validate({ root, release: C1.slice(0, 12) }).problems.join(";"), /no saved engine state/);
    assert.throws(() => activate({ root, release: C1.slice(0, 12) }), /no saved engine state/);
  });

  it("3. migrate-state moves the state to ONE shared folder and points both setups at it", () => {
    const before = stateCheck({ dir: join(oldEngine, "data") });
    const m = migrateState({ root, oldEngine, state: shared });
    assert.deepEqual(stateCheck({ dir: shared }).files, before.files, "moved byte for byte");
    assert.deepEqual(stateCheck({ dir: m.backup }).files, before.files, "verified backup");
    assert.equal(existsSync(join(oldEngine, "data")), false, "the old folder no longer exists under its name");
    assert.ok(existsSync(m.retired_old_data), "kept (renamed), never deleted");
    const rel = envValue(join(oldEngine, ".env"), "ENGINE_DATA_DIR");
    assert.equal(rel, relative(oldEngine, shared), "relative path: the only form the old supervisor accepts");
    assert.equal(supervisorDataDir(oldEngine, rel), shared, "the old supervisor's own path rule resolves to the shared folder");
    assert.equal(envValue(join(root, "config", "engine.env"), "ENGINE_DATA_DIR"), shared);
    assert.equal(envValue(join(oldEngine, ".env"), "ALPHA_WEBHOOK_SECRET"), "test-only-not-a-secret", "other settings untouched");
    assert.ok(readFileSync(join(oldEngine, ".env"), "utf8").startsWith("# test engine settings\r\n"), "comments and line endings kept");
    const v = validate({ root, release: C1.slice(0, 12), expectProfile: "solusd-5m", expectRisk: 10 });
    assert.equal(v.ok, true, v.problems.join("; "));
    assert.equal(v.config.state.resumable, true);
    activate({ root, release: C1.slice(0, 12), expectProfile: "solusd-5m", expectRisk: 10 });
    assert.throws(() => migrateState({ root, oldEngine, state: shared }), /already recorded/, "a second migration is refused");
  });

  it("4. the pinned release resumes from the latest state and processes new candles", { skip: !WIN && "Windows launcher" }, () => {
    const prev = state(shared);
    kraken.show(visible += STEP);
    const r = runPinned();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(supLog(), new RegExp(`active release ${C1.slice(0, 12)} .*state ${shared.replace(/\\/g, "\\\\")}`));
    advanced(prev, state(shared), "pinned release");
  });

  it("5. a faulty release fails without touching the state; a release that would discard it is refused", { skip: !WIN && "Windows launcher" }, () => {
    const before = stateCheck({ dir: shared }).files;
    activate({ root, release: C2.slice(0, 12) });
    kraken.show(visible += STEP);
    const r = runPinned();
    assert.notEqual(r.status, 0, "the faulty release does not run");
    assert.deepEqual(stateCheck({ dir: shared }).files, before, "state byte-identical after the failed start");
    assert.throws(() => activate({ root, release: C3.slice(0, 12) }), /DISCARD it and start a fresh warm-up/);
  });

  it("6. release rollback: the previous release resumes from the latest state, no candle skipped or replayed", { skip: !WIN && "Windows launcher" }, () => {
    const prev = state(shared);
    assert.equal(rollback({ root }).release, C1.slice(0, 12));
    const r = runPinned();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // The candles released while the faulty release was active are processed now, once.
    advanced(prev, state(shared), "after release rollback");
  });

  it("7. back to the ORIGINAL setup: it resumes the same, latest state (no stale copy anywhere)", () => {
    const prev = state(shared);
    const signalsBefore = outbox(shared);
    kraken.show(visible += STEP);
    const r = runOld();
    assert.equal(r.status, 0, r.stderr);
    const cur = state(shared);
    advanced(prev, cur, "original setup on the shared state");
    const after = outbox(shared).map((x) => x.split("|")[0]);
    for (const s of signalsBefore) assert.ok(after.includes(s.split("|")[0]), `signal ${s} kept`);
  });

  it("8. only one engine can run on the state, whichever setup starts it", { skip: !WIN && "Windows launcher" }, async () => {
    const first = spawn(process.execPath, ["src/cli/run.mjs"], { cwd: join(root, "releases", C1.slice(0, 12)), stdio: "ignore",
      env: { ...process.env, ENGINE_ENV_FILE: join(root, "config", "engine.env"), ENGINE_DATA_DIR: shared } });
    try {
      const lock = join(shared, "engine-SOLUSD-5m.lock");
      const end = Date.now() + 30000;
      while (!(existsSync(lock) && Number(readFileSync(lock, "utf8")) === first.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
      const old = runOld();
      assert.equal(old.status, 1);
      assert.match(old.stderr, /another engine \(pid \d+\) is already running/);
      assert.equal(runPinned().status, 3, "the pinned launcher refuses too");
      assert.throws(() => revertState({ root }), /is running/, "no state move while an engine runs");
    } finally {
      first.kill();
      await new Promise((r) => first.once("exit", r));
    }
  });

  it("9. full revert: the LATEST state goes back to the original folder and the original setup resumes it", () => {
    const prev = state(shared);
    const r1 = revertState({ root });
    assert.equal(r1.old_data, join(oldEngine, "data"));
    assert.equal(envValue(join(oldEngine, ".env"), "ENGINE_DATA_DIR"), undefined, "original .env value restored (it had none)");
    assert.equal(supervisorDataDir(oldEngine, "data"), join(oldEngine, "data"));
    assert.equal(existsSync(shared), false, "the shared folder is renamed, so nothing resumes a stale copy");
    assert.equal(envValue(join(root, "config", "engine.env"), "ENGINE_DATA_DIR"), join(oldEngine, "data"), "the pinned config follows the latest state too");
    assert.deepEqual(state(join(oldEngine, "data")), prev, "latest state carried back exactly");
    kraken.show(visible += STEP);
    const r = runOld();
    assert.equal(r.status, 0, r.stderr);
    advanced(prev, state(join(oldEngine, "data")), "original setup after revert");
    if (WIN) assert.equal(runPinned().status, 4, "the pinned launcher now refuses (state inside the development checkout)");
  });

  it("10. integrity across the whole sequence: monotonic candles, one warm-up, unique signals", () => {
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i].candlesProcessed > history[i - 1].candlesProcessed);
      assert.ok(history[i].signals >= history[i - 1].signals);
    }
    const final = state(join(oldEngine, "data"));
    assert.equal(final.resets, 0);
    assert.equal(final.duplicate_signal_ids, 0);
    const audit = readFileSync(join(oldEngine, "data", "audit-SOLUSD-5m.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const starts = audit.filter((a) => a.type === "process_start");
    assert.ok(starts.length >= 6, `one audit log carried through every switch (${starts.length} starts)`);
    assert.ok(starts.slice(1).every((s) => s.resumed === true), "every start after the first resumed saved state");
    assert.deepEqual(readdirSync(work).filter((f) => f.startsWith("engine-state")).length >= 1, true);
  });
});

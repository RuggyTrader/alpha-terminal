// Stage C of the Strategy Mirror rollout, rehearsed with REAL releases (docs/STRATEGY-MIRROR-ROLLOUT-PLAN.md):
//   OLD = 6b70cc97c579, the release pinned in production today (no mirror code)
//   NEW = this checkout's engine, committed in a temporary clone only
// Both are prepared with deploy/release.mjs (git objects + checksum manifest) in temporary roots. Nothing touches the
// production root, the scheduled task or the live engine.
//   Part 1: each release's OWN code (imported from releases/<id>/src), one shared state folder, a controlled clock and
//           an in-process ALPHA TERMINAL stand-in: upgrade, mirror on, restarts, rollback to OLD, re-enable. The funded
//           state must end byte-identical to a control run that stayed on OLD throughout.
//   Part 2: the real launcher (run-release.ps1 -Once) starts NEW with ENGINE_MIRROR=on and OLD after a rollback.
//   node --test test/mirror-release.test.mjs

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activate, installLauncher, prepare, rollback, status, validate } from "../deploy/release.mjs";
import { cloneRepo, startOhlcStub } from "./lib/release-fixtures.mjs";

process.env.ALPHA_RELEASE_ALLOW_APPDATA = "1"; // temporary test roots live under the system temp folder
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "..");
const REPO = join(ENGINE, "..");
const WIN = process.platform === "win32";
const OLD = "6b70cc97c57964eb8f0d0fabc761ffb8a77053b3";
const STEP = 300_000;
const C = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;
const work = mkdtempSync(join(tmpdir(), "alpha-mirror-release-"));
const clone = join(work, "repo");
const root = join(work, "prod");
const g = (...a) => execFileSync("git", ["-C", clone, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let NEW, oldDir, newDir, profileInputs;

before(() => {
  cloneRepo(REPO, clone);
  g("config", "user.email", "release-test@example.invalid"); g("config", "user.name", "release test");
  // NEW: this checkout's engine (possibly uncommitted) committed in the CLONE only.
  rmSync(join(clone, "engine", "src"), { recursive: true, force: true });
  cpSync(join(ENGINE, "src"), join(clone, "engine", "src"), { recursive: true });
  for (const f of ["release.mjs", "run-release.ps1"]) copyFileSync(join(ENGINE, "deploy", f), join(clone, "engine", "deploy", f));
  g("add", "-A", "engine"); g("commit", "--quiet", "--allow-empty", "-m", "mirror-capable engine (test clone)");
  NEW = g("rev-parse", "HEAD");
  mkdirSync(join(root, "config"), { recursive: true });
  for (const ref of [OLD, NEW]) prepare({ repo: clone, ref, root });
  oldDir = join(root, "releases", OLD.slice(0, 12));
  newDir = join(root, "releases", NEW.slice(0, 12));
});
after(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

// ---------------------------------------------------------------- Part 1: the releases' own code, controlled clock

/** In-process ALPHA TERMINAL stand-in: funded entries refused for capital (as production), mirror records idempotent. */
function alpha() {
  const a = { stored: new Map(), seqs: new Map(), mirrorCalls: 0, accounts: [] };
  a.http = async (url, init) => {
    const b = JSON.parse(init.body);
    if (url.endsWith("/webhook/engine-status")) return new Response("{}", { status: 200 });
    if (url.endsWith("/webhook/engine-ledger")) return new Response(JSON.stringify({ ok: true, position: null, alerts: {} }), { status: 200 });
    if (url.endsWith("/webhook/dry-run")) {
      return b.action === "CLOSE" ? new Response(JSON.stringify({ code: "NO_POSITION" }), { status: 422 })
        : new Response(JSON.stringify({ code: "INSUFFICIENT_PAPER_CAPITAL", message: "test" }), { status: 422 });
    }
    if (url.endsWith("/webhook/engine-mirror")) {
      a.mirrorCalls += 1;
      a.accounts.push(b.account);
      const results = b.items.map((it) => {
        const id = it.trade_id ?? it.event_id, text = JSON.stringify(it);
        if (a.stored.has(id)) return { seq: it.seq, status: a.stored.get(id) === text ? "duplicate" : "conflict" };
        if (a.seqs.has(it.seq)) return { seq: it.seq, status: "conflict", code: "SEQ_CONFLICT" };
        a.stored.set(id, text); a.seqs.set(it.seq, id);
        return { seq: it.seq, status: "stored" };
      });
      return new Response(JSON.stringify({ ok: true, results, account: {} }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return a;
}

async function runnerOf(dir) {
  return (await import(pathToFileURL(join(dir, "src", "runner.mjs")).href)).EngineRunner;
}
async function inputsOf(dir) {
  const { loadConfig } = await import(pathToFileURL(join(dir, "src", "config.mjs")).href);
  return loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, dir).inputs;
}

/** One engine "process" on a data folder: a given release, mirror on/off, at candle `visible`. */
function makeEngine(Runner, { dataDir, mirror, a, clock }) {
  const cfg = { symbol: "SOLUSD", intervalMin: 5, inputs: profileInputs, sync: true, apiBase: "http://alpha.test", webhookSecret: "test-secret",
    dataDir, lateBars: 2, krakenBase: "", mirror, profile: "solusd-5m" };
  return new Runner(cfg, { fetchCandles: async ({ sinceMs }) => C.slice(0, clock.visible).filter((k) => sinceMs === null || k.t > sinceMs),
    http: a.http, now: () => C[clock.visible - 1].t + STEP + 10_000, log: () => {} });
}
async function advance(engine, clock, to) { while (clock.visible < to) { clock.visible += 1; await engine.tick(); } }

describe("Part 1: upgrade, mirror activation, restart, rollback and re-enable on the releases' own code", () => {
  const ctl = { dir: mkdtempSync(join(tmpdir(), "alpha-ctl-")), clock: { visible: 200 }, a: alpha() };
  const run = { dir: mkdtempSync(join(tmpdir(), "alpha-run-")), clock: { visible: 200 }, a: alpha() };
  let OldRunner, NewRunner, e;
  // Compared without the sizing METADATA object ("sizing"), which universal sizing extends with the market's symbol and
  // the maximum-risk cap (docs/UNIVERSAL-POSITION-SIZING.md); every decision, order, outbox item and trade must match.
  // "plan"/"exit" (the recorded trade plan, 2026-11-13) are reporting metadata: every decision must still be byte-identical.
  const funded = (dir) => JSON.stringify(JSON.parse(readFileSync(join(dir, "state-SOLUSD-5m.json"), "utf8"),
    (k, v) => (k === "sizing" || (k === "plan" && v && typeof v === "object") || (k === "exit" && v && typeof v === "object" && "stop_history" in v) ? undefined : v)));
  const mirrorFile = (dir) => join(dir, "mirror-SOLUSD-5m.json");
  const M = () => JSON.parse(readFileSync(mirrorFile(run.dir), "utf8"));

  before(async () => {
    OldRunner = await runnerOf(oldDir);
    NewRunner = await runnerOf(newDir);
    profileInputs = await inputsOf(oldDir);
    assert.deepEqual(await inputsOf(newDir), profileInputs, "same strategy inputs in both releases");
    // Control: OLD release for the whole sequence.
    const c = makeEngine(OldRunner, { dataDir: ctl.dir, mirror: false, a: ctl.a, clock: ctl.clock });
    await c.tick();
    await advance(c, ctl.clock, 700);
  });

  it("1. production today: OLD release runs the funded track (shared state folder)", async () => {
    e = makeEngine(OldRunner, { dataDir: run.dir, mirror: false, a: run.a, clock: run.clock });
    await e.tick();
    await advance(e, run.clock, 300);
    assert.equal(existsSync(mirrorFile(run.dir)), false);
  });

  it("2. upgrade to NEW with ENGINE_MIRROR=off: funded state resumes exactly, no mirror file, no mirror request", async () => {
    e = makeEngine(NewRunner, { dataDir: run.dir, mirror: false, a: run.a, clock: run.clock });
    await advance(e, run.clock, 340);
    assert.equal(existsSync(mirrorFile(run.dir)), false);
    assert.equal(run.a.mirrorCalls, 0);
  });

  it("3. ENGINE_MIRROR=on, one controlled restart: own state, warm-up historical, activation once, then live", async () => {
    e = makeEngine(NewRunner, { dataDir: run.dir, mirror: true, a: run.a, clock: run.clock });
    await e.tick(); // the restart's first poll: no new candle, the mirror warms up on Kraken's history
    const m1 = M();
    assert.ok(m1.activatedAt, "activated");
    assert.equal(m1.candlesProcessed, 340, "warm-up on the available history");
    const warm = [...run.a.stored.values()].map((x) => JSON.parse(x)).filter((x) => x.type === "TRADE");
    assert.ok(warm.length > 0 && warm.every((t) => t.classification === "historical"));
    await advance(e, run.clock, 520); // the strategy trades at candles 480-484 and 495-499
    const m2 = M();
    assert.equal(m2.activatedAt, m1.activatedAt, "activation recorded once");
    const live = [...run.a.stored.values()].map((x) => JSON.parse(x)).filter((x) => x.type === "TRADE" && x.classification === "live");
    assert.ok(live.length > 0, "trades after activation are live");
    assert.ok(new Set(run.a.accounts.map((a) => a.activated_at)).size === 1);
  });

  it("4. restart (new process from the saved files) keeps both tracks", async () => {
    const before = { funded: funded(run.dir), mirror: readFileSync(mirrorFile(run.dir), "utf8") };
    e = makeEngine(NewRunner, { dataDir: run.dir, mirror: true, a: run.a, clock: run.clock });
    assert.equal(JSON.stringify(e.mirror), JSON.stringify(JSON.parse(before.mirror)), "mirror resumed from its file");
    await e.tick();
    assert.equal(funded(run.dir), before.funded, "nothing new: funded state unchanged by a restart");
    await advance(e, run.clock, 540);
  });

  it("5. rollback to OLD: funded track continues from the shared state; the mirror file is left untouched", async () => {
    const mirrorBefore = readFileSync(mirrorFile(run.dir), "utf8");
    e = makeEngine(OldRunner, { dataDir: run.dir, mirror: true, a: run.a, clock: run.clock }); // OLD ignores ENGINE_MIRROR
    await advance(e, run.clock, 620); // the strategy trades at candles 594-595 and 603-608 while the mirror is off
    assert.equal(readFileSync(mirrorFile(run.dir), "utf8"), mirrorBefore);
  });

  it("6. re-enable NEW with the mirror: it resumes (catch-up, observation gap), nothing recorded twice", async () => {
    const storedBefore = run.a.stored.size;
    e = makeEngine(NewRunner, { dataDir: run.dir, mirror: true, a: run.a, clock: run.clock });
    await e.tick();
    const m = M();
    assert.equal(m.resets.length, 0, "inside Kraken's window: no reset");
    assert.ok(m.observationGaps.some((g) => g.candles >= 78), "the rollback period is disclosed as an observation gap");
    await advance(e, run.clock, 700);
    const all = [...run.a.stored.values()].map((x) => JSON.parse(x));
    const ids = all.map((x) => x.trade_id ?? x.event_id);
    assert.equal(new Set(ids).size, ids.length, "no trade recorded twice");
    assert.ok(run.a.stored.size > storedBefore);
    const during = all.filter((t) => t.type === "TRADE" && Date.parse(t.entry_time) >= C[540].t && Date.parse(t.entry_time) < C[618].t);
    assert.ok(during.length >= 2 && during.every((t) => t.classification === "catch_up"), "trades of the rollback period are recorded, as catch_up");
    assert.deepEqual([...run.a.seqs.keys()].sort((x, y) => x - y), Array.from({ length: run.a.seqs.size }, (_, i) => i + 1), "contiguous sequence");
  });

  it("7. the funded state after upgrade, mirror, restarts, rollback and re-enable is byte-identical to the OLD-only control", () => {
    assert.equal(funded(run.dir), funded(ctl.dir));
  });

  it("8. the mirror recorded exactly the strategy's own trades over the same candles (no gap, no duplicate)", async () => {
    // Releases hold runtime files only; the research replay comes from this checkout (ote.mjs is byte-identical).
    const { runBacktest } = await import(pathToFileURL(join(ENGINE, "src", "cli", "backtest.mjs")).href);
    const ref = runBacktest({ candles: C.slice(0, 700), symbol: "SOLUSD", intervalMin: 5, inputs: profileInputs }).trades;
    const got = [...run.a.stored.values()].map((x) => JSON.parse(x)).filter((x) => x.type === "TRADE").sort((x, y) => x.seq - y.seq);
    assert.deepEqual(got.map((t) => [t.side, t.entry_time, t.exit_time, t.entry_price, t.exit_price]),
      ref.map((t) => [t.side, t.entryTime.replace(".000Z", "Z"), t.exitTime.replace(".000Z", "Z"), t.entryPrice, t.exitPrice]));
  });
});

// ---------------------------------------------------------------- Part 2: the real launcher

describe("Part 2: the real launcher with the prepared releases", { skip: !WIN && "Windows launcher" }, () => {
  let kraken;
  before(async () => { kraken = await startOhlcStub(); });
  after(async () => { await kraken?.close(); });
  const cfgFile = () => join(root, "config", "engine.env");
  const setCfg = (mirror) => writeFileSync(cfgFile(), ["ENGINE_PROFILE=solusd-5m", "ENGINE_SYNC=off", `KRAKEN_API_BASE=${kraken.base}`, "ENGINE_FRESH_START_OK=yes", `ENGINE_MIRROR=${mirror}`].join("\n") + "\n");
  const launch = () => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "bin", "run-release.ps1"), "-Root", root, "-Node", process.execPath, "-Once"], { encoding: "utf8", timeout: 180000 });
  const data = () => join(root, "data");

  it("OLD active, mirror off: the funded engine runs; validate reports no mirror", () => {
    setCfg("off");
    installLauncher({ repo: clone, ref: OLD, root });
    activate({ root, release: OLD.slice(0, 12), expectProfile: "solusd-5m", expectRisk: 10 });
    const r = launch();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(join(data(), "state-SOLUSD-5m.json")));
    assert.equal(validate({ root }).config.mirror, null, "OLD has no mirror setting");
  });

  it("upgrade: NEW validates with mirror on, keeps the saved state resumable, and the launcher starts it", () => {
    setCfg("on");
    const v = validate({ root, release: NEW.slice(0, 12), expectProfile: "solusd-5m", expectRisk: 10 });
    assert.equal(v.ok, true, v.problems.join("; "));
    assert.equal(v.config.mirror, true);
    assert.equal(v.config.state.resumable, true, "the funded state is resumed, not discarded");
    const before = JSON.parse(readFileSync(join(data(), "state-SOLUSD-5m.json"), "utf8"));
    activate({ root, release: NEW.slice(0, 12), expectProfile: "solusd-5m", expectRisk: 10 });
    kraken.show(C.length - 1);
    const r = launch();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(join(root, "logs", "supervisor.log"), "utf8"), new RegExp(`active release ${NEW.slice(0, 12)}`));
    const after = JSON.parse(readFileSync(join(data(), "state-SOLUSD-5m.json"), "utf8"));
    assert.equal(after.startedAt, before.startedAt, "same funded state continued (no fresh warm-up)");
    assert.equal(after.resets.length, before.resets.length);
    const m = JSON.parse(readFileSync(join(data(), "mirror-SOLUSD-5m.json"), "utf8"));
    assert.ok(m.activatedAt && m.candlesProcessed > 0, "independent mirror state created and activated");
    assert.ok(readdirSync(data()).some((f) => f === "mirror-SOLUSD-5m.json"));
  });

  it("rollback with ENGINE_MIRROR still on: a warning, not a refusal; OLD starts and leaves the mirror file alone", () => {
    const mirrorBefore = readFileSync(join(data(), "mirror-SOLUSD-5m.json"), "utf8");
    rollback({ root });
    assert.equal(status({ root }).current.commit, OLD);
    const v = validate({ root });
    assert.equal(v.ok, true, v.problems.join("; "));
    assert.match(v.warnings.join(" "), /no Strategy Mirror/);
    const r = launch();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(data(), "mirror-SOLUSD-5m.json"), "utf8"), mirrorBefore);
  });
});

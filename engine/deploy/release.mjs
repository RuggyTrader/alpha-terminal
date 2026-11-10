#!/usr/bin/env node
// Version-pinned production releases of the ALPHA TERMINAL PAPER engine. No dependencies; Node built-ins and git.
//
// A release is a copy of the engine's RUNTIME files taken from git objects at one exact commit (never a working tree,
// never a moving branch), with a SHA-256 manifest. Settings, secrets, saved state and logs live outside the releases
// and survive every release change. Nothing here contacts a broker or the ALPHA TERMINAL Worker.
//
// Layout under --root (e.g. %LOCALAPPDATA%\AlphaTerminal\engine-prod):
//   releases\<commit12>\    application files + RELEASE.json (manifest); replaceable, never edited in place
//   config\engine.env       the engine settings and secrets (operator-owned; never inside a release)
//   data\                   engine state, audit log, lock file, unless config sets ENGINE_DATA_DIR to an absolute
//                           shared state folder (the ONE state location; see migrate-state)
//   logs\                   supervisor and engine logs
//   bin\                    the launcher (run-release.ps1) and this tool, installed from an exact commit
//   current, previous       the active and the previous release id (text)
//   history.log             every prepare / activate / rollback
//
// Commands (all print JSON; exit code 0 = success):
//   prepare          --repo <git checkout> --ref <40-hex commit | tag> --root <dir>
//   install-launcher --repo <git checkout> --ref <40-hex commit | tag> --root <dir>
//   validate         --root <dir> [--release <id>] [--expect-profile solusd-5m] [--expect-risk 10]
//   activate         --root <dir> --release <id> [--expect-profile ...] [--expect-risk ...]
//   rollback         --root <dir>
//   status           --root <dir>
//   selftest         --root <dir> --release <id> [--kraken-base http://127.0.0.1:<port>]
//   state-check      --dir <state folder>                    (read-only summary: last candle, signals, lock, checksums)
//   migrate-state    --root <dir> --old-engine <dev checkout>\engine --state <absolute shared state folder>
//   revert-state     --root <dir>                            (undo migrate-state, carrying the LATEST state back)
//   task-xml         --root <dir> [--node <node.exe>]        (writes task\original.xml + task\pinned.xml; registers nothing)
// State is never copied into a second live location: migrate-state MOVES it to one shared folder that the old
// setup (via a relative ENGINE_DATA_DIR in its .env) and the pinned setup (absolute, in config) both use, so any
// switch in either direction resumes from the latest state, and the engine's lock file there keeps one engine.
// Activation and rollback only change which release the NEXT engine start uses; they never stop or start an engine.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TOOL_VERSION = 1;
// The engine's runtime entry points. Their relative-import closure is the release; research CLIs, tests,
// fixtures, parity references, reports and data are never copied.
const ENTRY_POINTS = ["src/cli/run.mjs", "src/cli/sync-setup.mjs"];
const ALWAYS = ["package.json"];
const LAUNCHER_FILES = ["deploy/run-release.ps1", "deploy/release.mjs"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const git = (repo, args, opts = {}) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
const gitOk = (repo, args) => spawnSync("git", ["-C", repo, ...args], { stdio: "ignore" }).status === 0;
class ReleaseError extends Error {}
const fail = (msg) => { throw new ReleaseError(msg); };

/**
 * Resolves an explicit, immutable reference: a full 40-hex commit SHA, or a tag (refs/tags/<name>) that is not also a
 * branch name. Branch names, HEAD, short SHAs, ranges and revision expressions are refused.
 */
export function resolveRef(repo, ref) {
  if (typeof ref !== "string" || ref.trim() === "") fail("a --ref is required: a full 40-character commit SHA or a release tag");
  ref = ref.trim();
  if (/^[0-9a-f]{40}$/.test(ref)) {
    if (!gitOk(repo, ["cat-file", "-e", `${ref}^{commit}`])) fail(`commit ${ref} does not exist in ${repo}`);
    return { commit: ref, ref, refType: "commit" };
  }
  if (/^[0-9a-f]{4,39}$/i.test(ref)) fail(`'${ref}' looks like a short SHA; use the full 40-character commit SHA`);
  if (/[~^:@{}\s]|\.\./.test(ref) || ref === "HEAD" || ref.startsWith("refs/heads/") || ref.startsWith("origin/")) fail(`'${ref}' is a revision expression or branch, not a fixed release reference`);
  const name = ref.replace(/^refs\/tags\//, "");
  if (!gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/tags/${name}`])) fail(`'${ref}' is not a tag (branches and other moving references are refused)`);
  const branches = git(repo, ["for-each-ref", "--format=%(refname)", `refs/heads/${name}`, `refs/remotes/*/${name}`], { encoding: "utf8" }).trim();
  if (branches) fail(`'${name}' is both a tag and a branch (${branches.split("\n").join(", ")}); use the full commit SHA`);
  const commit = git(repo, ["rev-parse", `refs/tags/${name}^{commit}`], { encoding: "utf8" }).trim();
  return { commit, ref: name, refType: "tag" };
}

/** Engine files at a commit: the relative-import closure of the entry points, package.json and profiles/*.env. */
export function runtimeFiles(repo, commit) {
  const all = new Set(git(repo, ["ls-tree", "-r", "--name-only", commit, "engine"], { encoding: "utf8" }).trim().split("\n").map((p) => p.replace(/^engine\//, "")));
  const read = (p) => git(repo, ["show", `${commit}:engine/${p}`]);
  const out = new Map();
  const queue = ENTRY_POINTS.filter((p) => all.has(p));
  if (!queue.includes("src/cli/run.mjs")) fail(`commit ${commit} has no engine/src/cli/run.mjs`);
  while (queue.length) {
    const p = queue.shift();
    if (out.has(p)) continue;
    const buf = read(p);
    out.set(p, buf);
    const text = buf.toString("utf8");
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const dep = join(dirname(p), m[1]).split(sep).join("/");
      if (!all.has(dep)) fail(`${p} imports ${m[1]}, which is not in commit ${commit}`);
      queue.push(dep);
    }
  }
  for (const p of ALWAYS) if (all.has(p)) out.set(p, read(p));
  for (const p of all) if (/^profiles\/[a-z0-9-]+\.env$/.test(p)) out.set(p, read(p));
  const pkg = JSON.parse(out.get("package.json")?.toString("utf8") ?? "{}");
  if (Object.keys(pkg.dependencies ?? {}).length) fail("the engine declares npm dependencies; this tool only supports the dependency-free engine");
  return out;
}

/** KEY=value from an env file (same parsing as src/config.mjs loadEnvFile); undefined when absent. */
export function envValue(file, key) {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1] !== key) continue;
    const v = m[2];
    const quoted = v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0];
    return quoted ? v.slice(1, -1) : v.replace(/\s+#.*$/, "");
  }
  return undefined;
}

/** Sets KEY=value in an env file, replacing an existing line or appending one; every other line is kept exactly. */
function setEnvValue(file, key, value) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let done = false;
  const out = lines.map((l) => (!l.trimStart().startsWith("#") && new RegExp(`^\\s*${key}\\s*=`).test(l) ? (done = true, `${key}=${value}`) : l));
  if (!done) out.push(`${key}=${value}`);
  atomicWrite(file, out.join(eol) + eol);
}

/** The folder of the git work tree containing p, or null. State inside a work tree can be wiped by `git clean -x`. */
function gitWorkTreeOf(p) {
  let d = resolve(p);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const isAbsolutePath = (v) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(v);

/** The engine state folder of a pinned root: ENGINE_DATA_DIR from its config when absolute, else <root>\data. */
export function stateDirOf(root) {
  const P = paths(root);
  const v = envValue(P.config, "ENGINE_DATA_DIR");
  if (v === undefined || v === "") return { dir: P.data, configured: false };
  if (!isAbsolutePath(v)) return { dir: null, configured: true, problem: `ENGINE_DATA_DIR in ${P.config} must be an absolute path (got '${v}')` };
  return { dir: resolve(v), configured: true };
}

/**
 * Folders that Windows redirects for packaged (MSIX) apps. A program started from such an app (for example the
 * Claude desktop app) that writes under %LOCALAPPDATA% or %APPDATA% actually writes into the app's private package
 * folder; processes started by Task Scheduler cannot see those files. Found on 2026-11-09: the pinned task failed with
 * 0x8007010B and the original supervisor ran on an empty folder. Production roots and state must live elsewhere
 * (e.g. %USERPROFILE%\AlphaTerminal). ALPHA_RELEASE_ALLOW_APPDATA=1 lifts this only for tests in temporary folders.
 */
export function appDataProblem(p, what) {
  if (process.env.ALPHA_RELEASE_ALLOW_APPDATA === "1" || !p) return null;
  const full = resolve(p).toLowerCase();
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA]) {
    if (base && (full === resolve(base).toLowerCase() || full.startsWith(resolve(base).toLowerCase() + sep))) {
      return `${what} ${resolve(p)} is under ${base}: Windows redirects that folder for packaged apps, so a scheduled task may not see it; use a folder such as %USERPROFILE%\\AlphaTerminal`;
    }
  }
  return null;
}
const refuseAppData = (p, what) => { const m = appDataProblem(p, what); if (m) fail(m); };

const paths = (root) => ({
  root: resolve(root), releases: join(resolve(root), "releases"), config: join(resolve(root), "config", "engine.env"),
  data: join(resolve(root), "data"), logs: join(resolve(root), "logs"), bin: join(resolve(root), "bin"), backups: join(resolve(root), "backups"),
  migration: join(resolve(root), "state-migration.json"),
  current: join(resolve(root), "current"), previous: join(resolve(root), "previous"), history: join(resolve(root), "history.log"),
});
const readText = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim() || null : null);
const atomicWrite = (f, text) => { const tmp = `${f}.tmp-${process.pid}`; writeFileSync(tmp, text); renameSync(tmp, f); };
const log = (P, entry) => { mkdirSync(P.root, { recursive: true }); appendFileSync(P.history, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); };

function writeTree(dir, files, manifestExtra) {
  const manifest = { ...manifestExtra, tool_version: TOOL_VERSION, files: {} };
  for (const [p, buf] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dest = join(dir, ...p.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    manifest.files[p] = { sha256: sha256(buf), size: buf.length };
  }
  writeFileSync(join(dir, "RELEASE.json"), JSON.stringify(manifest, null, 1) + "\n");
  return manifest;
}

/** Every file matches its checksum and no other file exists. */
export function verifyTree(dir) {
  const problems = [];
  if (!existsSync(join(dir, "RELEASE.json"))) return { ok: false, problems: [`${dir}: no RELEASE.json`], manifest: null };
  const manifest = JSON.parse(readFileSync(join(dir, "RELEASE.json"), "utf8"));
  const present = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else present.push(relative(dir, f).split(sep).join("/")); } };
  walk(dir);
  for (const [p, { sha256: want }] of Object.entries(manifest.files)) {
    const f = join(dir, ...p.split("/"));
    if (!existsSync(f)) { problems.push(`missing ${p}`); continue; }
    if (sha256(readFileSync(f)) !== want) problems.push(`modified ${p}`);
  }
  for (const p of present) if (p !== "RELEASE.json" && !manifest.files[p]) problems.push(`unexpected file ${p}`);
  return { ok: problems.length === 0, problems, manifest };
}

export function prepare({ repo, ref, root }) {
  refuseAppData(root, "the release root");
  const P = paths(root);
  const r = resolveRef(repo, ref);
  const id = r.commit.slice(0, 12);
  const dir = join(P.releases, id);
  if (existsSync(dir)) {
    const v = verifyTree(dir);
    if (!v.ok) fail(`release ${id} already exists but does not verify (${v.problems.join("; ")}); remove it deliberately before preparing again`);
    if (v.manifest.commit !== r.commit) fail(`release ${id} holds commit ${v.manifest.commit}, not ${r.commit}`);
    return { result: "already prepared (unchanged)", release: id, commit: r.commit, ref: r.ref, files: Object.keys(v.manifest.files).length };
  }
  const files = runtimeFiles(repo, r.commit);
  mkdirSync(P.releases, { recursive: true });
  const staging = join(P.releases, `.staging-${id}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  const manifest = writeTree(staging, files, { release: id, commit: r.commit, ref: r.ref, ref_type: r.refType, prepared_at: new Date().toISOString(),
    commit_date: git(repo, ["show", "-s", "--format=%cI", r.commit], { encoding: "utf8" }).trim() });
  renameSync(staging, dir);
  log(P, { action: "prepare", release: id, commit: r.commit, ref: r.ref });
  return { result: "prepared", release: id, commit: r.commit, ref: r.ref, ref_type: r.refType, files: Object.keys(manifest.files).length };
}

export function installLauncher({ repo, ref, root }) {
  refuseAppData(root, "the release root");
  const P = paths(root);
  const r = resolveRef(repo, ref);
  const files = new Map();
  for (const p of LAUNCHER_FILES) {
    if (!gitOk(repo, ["cat-file", "-e", `${r.commit}:engine/${p}`])) fail(`commit ${r.commit} has no engine/${p}`);
    files.set(p.replace("deploy/", ""), git(repo, ["show", `${r.commit}:engine/${p}`]));
  }
  const staging = `${P.bin}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  writeTree(staging, files, { launcher: true, commit: r.commit, ref: r.ref, installed_at: new Date().toISOString() });
  if (existsSync(P.bin)) { rmSync(`${P.bin}.old`, { recursive: true, force: true }); renameSync(P.bin, `${P.bin}.old`); }
  renameSync(staging, P.bin);
  rmSync(`${P.bin}.old`, { recursive: true, force: true });
  log(P, { action: "install-launcher", commit: r.commit, ref: r.ref });
  return { result: "launcher installed", commit: r.commit, files: [...files.keys()] };
}

/**
 * Loads the configuration with the RELEASE's own config code, with the data directory forced to the root's state
 * folder, and checks that the saved state there would be RESUMED by this release (same settings hash), not discarded.
 */
function checkConfig(P, dir, { expectProfile = null, expectRisk = null } = {}) {
  if (!existsSync(P.config)) return { ok: false, problems: [`no configuration file at ${P.config}`] };
  const sd = stateDirOf(P.root);
  if (!sd.dir) return { ok: false, problems: [sd.problem] };
  // Effective inputs = Pine defaults overridden by the profile and the env file, exactly as the engine computes them.
  const script = `const { loadConfig, redacted } = await import(${JSON.stringify(pathToFileURL(join(dir, "src", "config.mjs")).href)});
    const { DEFAULT_INPUTS } = await import(${JSON.stringify(pathToFileURL(join(dir, "src", "ote.mjs")).href)});
    const { inputsHash } = await import(${JSON.stringify(pathToFileURL(join(dir, "src", "runner.mjs")).href)});
    const c = loadConfig(process.env, process.cwd());
    const i = { ...DEFAULT_INPUTS, ...c.inputs };
    console.log(JSON.stringify({ profile: c.profile, symbol: c.symbol, intervalMin: c.intervalMin, sync: c.sync, apiBase: c.apiBase, dataDir: c.dataDir, riskUSD: i.riskUSD, allowLong: i.allowLong, allowShort: i.allowShort, sizing: c.sizing?.mode ?? "fixed", secret: redacted(c).webhookSecret, inputsHash: inputsHash(c), mirror: c.mirror === undefined ? null : c.mirror }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ENGINE_ENV_FILE: P.config, ENGINE_DATA_DIR: sd.dir },
  });
  if (r.status !== 0) return { ok: false, problems: [`configuration rejected by the release: ${(r.stderr || r.stdout).trim().split("\n").find((l) => /Error/.test(l)) ?? r.stderr.trim()}`] };
  const c = JSON.parse(r.stdout.trim().split("\n").at(-1));
  const problems = [];
  if (resolve(c.dataDir) !== sd.dir) problems.push(`data directory ${c.dataDir} is not ${sd.dir}`);
  for (const [path, what] of [[P.root, "the release root"], [c.dataDir, "the state folder"]]) { const m = appDataProblem(path, what); if (m) problems.push(m); }
  if (resolve(c.dataDir).startsWith(resolve(P.releases))) problems.push("data directory is inside the releases folder");
  const tree = gitWorkTreeOf(c.dataDir);
  if (tree) problems.push(`state folder ${c.dataDir} is inside the git work tree ${tree} (a 'git clean' could delete it); migrate it with migrate-state`);
  // The saved state must be resumed, not discarded: the engine starts a fresh warm-up when its settings hash differs.
  const stateFile = join(c.dataDir, `state-${c.symbol}-${c.intervalMin}m.json`);
  if (existsSync(stateFile)) {
    let saved = null;
    try { saved = JSON.parse(readFileSync(stateFile, "utf8")); } catch { problems.push(`saved state ${stateFile} is not valid JSON`); }
    c.state = saved ? { file: stateFile, inputsHash: saved.inputsHash, lastCandle: saved.lastCandle?.t ?? saved.lastCandle ?? null, candlesProcessed: saved.candlesProcessed ?? null, resumable: saved.inputsHash === c.inputsHash } : null;
    if (saved && saved.inputsHash !== c.inputsHash) problems.push(`the saved state was made with different strategy settings (${saved.inputsHash} vs ${c.inputsHash}); this release would DISCARD it and start a fresh warm-up`);
  } else {
    c.state = { file: stateFile, exists: false };
    // An empty state folder means a first start warms up from scratch and forgets any open position: only on purpose.
    if (envValue(P.config, "ENGINE_FRESH_START_OK") !== "yes") problems.push(`no saved engine state in ${c.dataDir}: run migrate-state first (or set ENGINE_FRESH_START_OK=yes in the config for a deliberate fresh start)`);
  }
  // Strategy Mirror: reported. ENGINE_MIRROR=on with a release that has no mirror is a WARNING, not a refusal: a rollback
  // to such a release must still start the funded engine (the mirror is then simply not running).
  const warnings = [];
  if (envValue(P.config, "ENGINE_MIRROR") === "on" && c.mirror !== true) warnings.push("ENGINE_MIRROR=on, but this release has no Strategy Mirror: the mirror will not run");
  if (expectProfile !== null && c.profile !== expectProfile) problems.push(`profile is ${c.profile}, expected ${expectProfile}`);
  if (expectRisk !== null && Number(c.riskUSD) !== Number(expectRisk)) problems.push(`risk per trade is ${c.riskUSD}, expected ${expectRisk}`);
  return { ok: problems.length === 0, problems, warnings, config: c };
}

export function validate({ root, release = null, expectProfile = null, expectRisk = null }) {
  const P = paths(root);
  const id = release ?? readText(P.current);
  if (!id) fail("no release given and none is active");
  const dir = join(P.releases, id);
  if (!existsSync(dir)) fail(`release ${id} is not prepared`);
  const files = verifyTree(dir);
  const problems = [...files.problems];
  if (files.manifest && files.manifest.commit.slice(0, 12) !== id) problems.push(`manifest commit ${files.manifest.commit} does not match release id ${id}`);
  const cfg = files.ok ? checkConfig(P, dir, { expectProfile, expectRisk }) : { ok: false, problems: [] };
  problems.push(...cfg.problems);
  return { ok: problems.length === 0, release: id, commit: files.manifest?.commit ?? null, ref: files.manifest?.ref ?? null, problems, warnings: cfg.warnings ?? [], config: cfg.config ?? null };
}

export function activate({ root, release, expectProfile = null, expectRisk = null }) {
  const P = paths(root);
  if (!release) fail("--release is required");
  const v = validate({ root, release, expectProfile, expectRisk });
  if (!v.ok) fail(`release ${release} does not validate: ${v.problems.join("; ")}`);
  const cur = readText(P.current);
  if (cur === release) return { result: "already active", release };
  if (cur) atomicWrite(P.previous, cur + "\n");
  atomicWrite(P.current, release + "\n");
  log(P, { action: "activate", release, commit: v.commit, previous: cur });
  return { result: "activated (used from the next engine start; nothing was restarted)", release, commit: v.commit, previous: cur, engine: engineState(P) };
}

export function rollback({ root }) {
  const P = paths(root);
  const cur = readText(P.current), prev = readText(P.previous);
  if (!prev) fail("no previous release to roll back to");
  const v = validate({ root, release: prev });
  if (!v.ok) fail(`previous release ${prev} does not validate: ${v.problems.join("; ")}`);
  atomicWrite(P.current, prev + "\n");
  if (cur) atomicWrite(P.previous, cur + "\n");
  log(P, { action: "rollback", release: prev, from: cur });
  return { result: "rolled back (used from the next engine start; state in data\\ is untouched)", release: prev, commit: v.commit, previous: cur, engine: engineState(P) };
}

function engineState(P) {
  return lockState(stateDirOf(P.root).dir ?? P.data);
}

/** Whether an engine holds a lock in a state folder (its pid is alive). */
export function lockState(dir) {
  if (!dir || !existsSync(dir)) return { running: false };
  const lock = readdirSync(dir).find((f) => /^engine-.*\.lock$/.test(f));
  if (!lock) return { running: false };
  const pid = Number(readFileSync(join(dir, lock), "utf8"));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { /* not running */ }
  return { running: alive, pid: alive ? pid : null, lock };
}

export function status({ root }) {
  const P = paths(root);
  const describe = (id) => {
    if (!id) return null;
    const dir = join(P.releases, id);
    if (!existsSync(dir)) return { release: id, prepared: false };
    const v = verifyTree(dir);
    return { release: id, commit: v.manifest?.commit, ref: v.manifest?.ref, ref_type: v.manifest?.ref_type, prepared_at: v.manifest?.prepared_at, files_verified: v.ok, problems: v.problems };
  };
  const launcher = existsSync(join(P.bin, "RELEASE.json")) ? (() => { const v = verifyTree(P.bin); return { commit: v.manifest.commit, verified: v.ok }; })() : null;
  return {
    root: P.root, current: describe(readText(P.current)), previous: describe(readText(P.previous)),
    prepared: existsSync(P.releases) ? readdirSync(P.releases).filter((d) => !d.startsWith(".")) : [],
    config_present: existsSync(P.config), state_dir: stateDirOf(P.root).dir, launcher, engine: engineState(P),
    migration: existsSync(P.migration) ? JSON.parse(readFileSync(P.migration, "utf8")) : null,
    history: existsSync(P.history) ? readFileSync(P.history, "utf8").trim().split("\n").slice(-5).map((l) => JSON.parse(l)) : [],
  };
}

/**
 * Starts the release once (`run.mjs --once`) with an ISOLATED copy of the configuration (sync forced off) and a
 * throwaway data directory. Never touches the root's data, logs or the Worker.
 */
export function selftest({ root, release, krakenBase = null }) {
  const P = paths(root);
  const v = validate({ root, release });
  if (!v.ok) fail(`release ${release} does not validate: ${v.problems.join("; ")}`);
  const dir = join(P.releases, release);
  const tmp = mkdtempSync(join(tmpdir(), "alpha-selftest-"));
  try {
    const env = join(tmp, "engine.env");
    // The real settings minus anything that could reach the Worker: sync off, no API base, no secret.
    const lines = readFileSync(P.config, "utf8").split(/\r?\n/).filter((l) => !/^\s*(ENGINE_SYNC|ALPHA_API_BASE|ALPHA_WEBHOOK_SECRET|ENGINE_DATA_DIR|KRAKEN_API_BASE|ENGINE_REMOTE_SETTINGS)\s*=/.test(l));
    writeFileSync(env, [...lines, "ENGINE_SYNC=off", "ENGINE_REMOTE_SETTINGS=off", ...(krakenBase ? [`KRAKEN_API_BASE=${krakenBase}`] : [])].join("\n") + "\n");
    const r = spawnSync(process.execPath, ["src/cli/run.mjs", "--once"], {
      cwd: dir, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, ENGINE_ENV_FILE: env, ENGINE_DATA_DIR: join(tmp, "data"), ENGINE_SYNC: "off", ALPHA_API_BASE: "", ALPHA_WEBHOOK_SECRET: "" },
    });
    const state = existsSync(join(tmp, "data")) ? readdirSync(join(tmp, "data")) : [];
    // The poll must have fetched and processed real candles (not merely written an empty state).
    const sf = state.find((f) => /^state-.*\.json$/.test(f));
    const saved = sf ? JSON.parse(readFileSync(join(tmp, "data", sf), "utf8")) : null;
    const processed = saved?.candlesProcessed ?? 0;
    const ok = r.status === 0 && /PAPER only/.test(r.stdout) && processed > 0;
    const after = verifyTree(dir);
    return { ok: ok && after.ok, release, commit: v.commit, exit: r.status, state_files: state, candles_processed: processed, last_candle: saved?.lastCandle?.t ?? null, release_unchanged: after.ok,
      output: (r.stdout + r.stderr).split("\n").filter(Boolean).slice(-6) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- engine state: one location, moved never forked

const FINAL_STATUSES = new Set(["accepted", "rejected", "skipped", "historical", "late"]);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function listFiles(dir) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else out.push(relative(dir, f).split(sep).join("/")); } };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}
const checksums = (dir) => Object.fromEntries(listFiles(dir).map((f) => [f, sha256(readFileSync(join(dir, ...f.split("/"))))]));

/** Copies every file of src into dst (which must not hold files) and verifies each copy byte for byte. */
function copyVerified(src, dst) {
  if (listFiles(dst).length) fail(`${dst} already holds files; refusing to mix two states`);
  const want = checksums(src);
  for (const f of Object.keys(want)) {
    const to = join(dst, ...f.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(join(src, ...f.split("/"))));
  }
  mkdirSync(dst, { recursive: true });
  const got = checksums(dst);
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`copy of ${src} to ${dst} does not verify`);
  return want;
}

/**
 * The data folder the CURRENT (development-checkout) supervisor uses: run-windows-production.ps1 computes
 * [IO.Path]::GetFullPath((Join-Path <engine dir> <ENGINE_DATA_DIR>)). That expression fails on an absolute path, so
 * only relative values work there. On Windows the exact PowerShell expression is evaluated to be certain.
 */
export function supervisorDataDir(engineDir, value) {
  if (isAbsolutePath(value)) fail(`ENGINE_DATA_DIR '${value}' is absolute: the current supervisor (run-windows-production.ps1) cannot use it`);
  if (process.platform !== "win32") return resolve(engineDir, value);
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", "[IO.Path]::GetFullPath((Join-Path $env:ALPHA_ENGINE_DIR $env:ALPHA_DATA_VALUE))"], {
    encoding: "utf8", env: { ...process.env, ALPHA_ENGINE_DIR: engineDir, ALPHA_DATA_VALUE: value },
  });
  if (r.status !== 0 || !r.stdout.trim()) fail(`the supervisor's path rule cannot resolve '${value}': ${r.stderr.trim()}`);
  return resolve(r.stdout.trim());
}

/** Read-only summary of an engine state folder: what a switch must preserve. */
export function stateCheck({ dir }) {
  if (!dir || !existsSync(dir)) return { ok: false, dir, error: "no such state folder" };
  const states = listFiles(dir).filter((f) => /^state-.*\.json$/.test(f)).map((f) => {
    let s;
    try { s = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return { file: f, valid: false }; }
    const ids = (s.outbox ?? []).map((x) => x.id);
    return {
      file: f, valid: true, inputsHash: s.inputsHash, lastCandle: s.lastCandle?.t ?? s.lastCandle ?? null, candlesProcessed: s.candlesProcessed ?? null,
      warmedUpAt: s.warmedUpAt ?? null, resets: (s.resets ?? []).length, signals: ids.length, duplicate_signal_ids: ids.length - new Set(ids).size,
      pending_signals: (s.outbox ?? []).filter((x) => !FINAL_STATUSES.has(x.status)).length,
      open_position: s.strategy?.broker?.pos ? { side: s.strategy.broker.pos.side, qty: s.strategy.broker.pos.qty } : null,
      risk_setting: s.settings ?? null,
    };
  });
  const ok = states.length > 0 && states.every((s) => s.valid && s.duplicate_signal_ids === 0);
  return { ok, dir: resolve(dir), engine: lockState(dir), states, files: checksums(dir) };
}

/**
 * Moves the live engine state from the development checkout's data folder to ONE shared state folder outside any git
 * work tree, and points BOTH setups at it: the old supervisor via a relative ENGINE_DATA_DIR in <old-engine>\.env, the
 * pinned launcher via an absolute ENGINE_DATA_DIR in <root>\config\engine.env. Refuses while any engine runs.
 * Nothing is deleted: a verified backup goes to <root>\backups, and the old folder is renamed (*.migrated-<time>) so
 * it can never be resumed by mistake. Any failure undoes the steps already done.
 */
export function migrateState({ root, oldEngine, state }) {
  const P = paths(root);
  if (!oldEngine || !state) fail("--old-engine and --state are required");
  if (existsSync(P.migration)) fail(`a migration is already recorded (${P.migration}); revert it first`);
  if (!existsSync(P.config)) fail(`no configuration file at ${P.config}`);
  if (!isAbsolutePath(state)) fail("--state must be an absolute path");
  refuseAppData(root, "the release root");
  refuseAppData(state, "the state folder");
  const engineDir = resolve(oldEngine), target = resolve(state);
  const envFile = join(engineDir, ".env");
  if (!existsSync(envFile)) fail(`no ${envFile}`);
  const oldValue = envValue(envFile, "ENGINE_DATA_DIR");
  const oldData = supervisorDataDir(engineDir, oldValue ?? "data");
  if (!existsSync(oldData) || !listFiles(oldData).some((f) => /^state-.*\.json$/.test(f))) fail(`no engine state in ${oldData}`);
  if (target === oldData) fail("the state is already there");
  if (target.startsWith(resolve(P.releases))) fail("the state folder must not be inside the releases folder");
  const tree = gitWorkTreeOf(target);
  if (tree) fail(`the state folder must be outside any git work tree (${tree})`);
  if (listFiles(target).length) fail(`${target} already holds files`);
  const rel = relative(engineDir, target);
  if (isAbsolutePath(rel)) fail("the state folder must be on the same drive as the engine (the old supervisor needs a relative path)");
  for (const d of [oldData, target]) { const e = lockState(d); if (e.running) fail(`an engine (pid ${e.pid}) is running on ${d}; stop it first`); }
  const before = stateCheck({ dir: oldData });
  if (!before.ok) fail(`the current state does not check out: ${JSON.stringify(before.states)}`);

  const t = stamp();
  const backup = join(P.backups, `state-${t}`);
  const envBackup = join(P.backups, `old-engine-env-${t}`);
  const cfgBackup = join(P.backups, `config-env-${t}`);
  const retired = `${oldData}.migrated-${t}`;
  const undo = [];
  try {
    copyVerified(oldData, backup);
    mkdirSync(P.backups, { recursive: true });
    writeFileSync(envBackup, readFileSync(envFile)); undo.push(() => writeFileSync(envFile, readFileSync(envBackup)));
    writeFileSync(cfgBackup, readFileSync(P.config)); undo.push(() => writeFileSync(P.config, readFileSync(cfgBackup)));
    copyVerified(oldData, target); undo.push(() => renameSync(target, `${target}.aborted-${t}`));
    renameSync(oldData, retired); undo.push(() => renameSync(retired, oldData));
    setEnvValue(envFile, "ENGINE_DATA_DIR", rel);
    setEnvValue(P.config, "ENGINE_DATA_DIR", target);
    const viaSupervisor = supervisorDataDir(engineDir, envValue(envFile, "ENGINE_DATA_DIR"));
    if (viaSupervisor !== target) fail(`the old supervisor would use ${viaSupervisor}, not ${target}`);
    const after = stateCheck({ dir: target });
    if (JSON.stringify(after.files) !== JSON.stringify(before.files)) fail("the moved state differs from the original");
    const record = { at: new Date().toISOString(), old_engine: engineDir, old_env_value: oldValue ?? null, old_data: oldData, retired_old_data: retired, state: target, relative_value: rel, backup, env_backup: envBackup, config_backup: cfgBackup };
    writeFileSync(P.migration, JSON.stringify(record, null, 1) + "\n");
    log(P, { action: "migrate-state", from: oldData, to: target, backup });
    return { result: "state moved; both setups now use one state folder", ...record, state_check: after.states };
  } catch (e) {
    for (const f of undo.reverse()) { try { f(); } catch { /* best effort; the backup remains */ } }
    throw e;
  }
}

/**
 * Undoes migrate-state: the LATEST state (from the shared folder, possibly advanced by the pinned engine) goes back to
 * the original data folder, the old .env gets its original ENGINE_DATA_DIR back, and the pinned config points at the
 * same folder, so whichever setup starts next resumes the latest state. Refuses while any engine runs.
 */
export function revertState({ root }) {
  const P = paths(root);
  if (!existsSync(P.migration)) fail("no migration is recorded");
  const m = JSON.parse(readFileSync(P.migration, "utf8"));
  for (const d of [m.state, m.old_data]) { const e = lockState(d); if (e.running) fail(`an engine (pid ${e.pid}) is running on ${d}; stop it first`); }
  if (existsSync(m.old_data) && listFiles(m.old_data).length) fail(`${m.old_data} holds files again; resolve manually`);
  const latest = stateCheck({ dir: m.state });
  if (!latest.ok) fail(`the shared state does not check out: ${JSON.stringify(latest.states)}`);
  const t = stamp();
  copyVerified(m.state, join(P.backups, `state-before-revert-${t}`));
  copyVerified(m.state, m.old_data);
  renameSync(m.state, `${m.state}.reverted-${t}`);
  const envFile = join(m.old_engine, ".env");
  if (m.old_env_value === null) {
    const text = readFileSync(envFile, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    atomicWrite(envFile, text.split(/\r?\n/).filter((l) => !/^\s*ENGINE_DATA_DIR\s*=/.test(l)).join(eol));
  } else setEnvValue(envFile, "ENGINE_DATA_DIR", m.old_env_value);
  setEnvValue(P.config, "ENGINE_DATA_DIR", m.old_data);
  const resolved = supervisorDataDir(m.old_engine, envValue(envFile, "ENGINE_DATA_DIR") ?? "data");
  if (resolved !== m.old_data) fail(`after revert the old supervisor would use ${resolved}, not ${m.old_data}`);
  renameSync(P.migration, `${P.migration}.reverted-${t}`);
  log(P, { action: "revert-state", to: m.old_data, from: m.state });
  return { result: "state reverted to the original folder (latest state carried back)", old_data: m.old_data, state_check: stateCheck({ dir: m.old_data }).states };
}

// ---------------------------------------------------------------- scheduled task definition (read-only here)

const xmlEscape = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Exports the CURRENT scheduled task (read-only, Export-ScheduledTask) and writes two definitions under <root>\task:
 *   original.xml  the task exactly as installed today (written once, never overwritten): the restore definition
 *   pinned.xml    identical except the action's Arguments and WorkingDirectory, which start <root>\bin\run-release.ps1
 * Nothing is registered. Switching later is `schtasks /Create /TN <name> /XML <file> /F` (owner approval); restoring
 * is the same command with original.xml. (A PowerShell script that registers a task is removed by Microsoft Defender
 * as potentially unwanted software on this PC; these XML files are not.)
 */
export function taskXml({ root, node = null, taskName = "ALPHA TERMINAL Engine" }) {
  if (process.platform !== "win32") fail("task-xml is Windows only");
  refuseAppData(root, "the release root");
  const P = paths(root);
  const dir = join(P.root, "task");
  mkdirSync(dir, { recursive: true });
  const exported = join(dir, `.export-${process.pid}.xml`);
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "[IO.File]::WriteAllText($env:ALPHA_OUT, (Export-ScheduledTask -TaskName $env:ALPHA_TASK -ErrorAction Stop), [Text.Encoding]::Unicode)"],
  { encoding: "utf8", env: { ...process.env, ALPHA_OUT: exported, ALPHA_TASK: taskName } });
  if (r.status !== 0 || !existsSync(exported)) fail(`could not export the scheduled task '${taskName}': ${r.stderr.trim()}`);
  const current = readFileSync(exported, "utf16le").replace(/^\uFEFF/, "");
  rmSync(exported, { force: true });
  const original = join(dir, "original.xml");
  if (!existsSync(original)) writeFileSync(original, "\uFEFF" + current, "utf16le");
  const base = readFileSync(original, "utf16le").replace(/^\uFEFF/, "");
  const execs = base.match(/<Exec>[\s\S]*?<\/Exec>/g) ?? [];
  if (execs.length !== 1) fail(`expected exactly one action in the task, found ${execs.length}`);
  const ps = join(process.env.SystemRoot ?? "C:\\WINDOWS", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const nodeExe = node ?? process.execPath;
  const args = `--headless "${ps}" -NoProfile -ExecutionPolicy Bypass -File "${join(P.bin, "run-release.ps1")}" -Root "${P.root}" -Node "${nodeExe}"`;
  let exec = execs[0];
  exec = /<Arguments>/.test(exec) ? exec.replace(/<Arguments>[\s\S]*?<\/Arguments>/, `<Arguments>${xmlEscape(args)}</Arguments>`) : exec.replace("</Command>", `</Command>\n      <Arguments>${xmlEscape(args)}</Arguments>`);
  exec = /<WorkingDirectory>/.test(exec) ? exec.replace(/<WorkingDirectory>[\s\S]*?<\/WorkingDirectory>/, `<WorkingDirectory>${xmlEscape(P.root)}</WorkingDirectory>`) : exec.replace("</Exec>", `  <WorkingDirectory>${xmlEscape(P.root)}</WorkingDirectory>\n    </Exec>`);
  const pinned = base.replace(execs[0], exec);
  writeFileSync(join(dir, "pinned.xml"), "\uFEFF" + pinned, "utf16le");
  const command = (x) => /<Command>([\s\S]*?)<\/Command>/.exec(x)?.[1];
  return {
    result: "task definitions written; nothing was registered",
    task: taskName, original: original, pinned: join(dir, "pinned.xml"),
    installed_matches_original: current === base,
    command: command(pinned), pinned_arguments: args, pinned_working_directory: P.root,
    unchanged_outside_action: pinned.replace(exec, "") === base.replace(execs[0], ""),
    switch_with: `schtasks /Create /TN "${taskName}" /XML "${join(dir, "pinned.xml")}" /F`,
    restore_with: `schtasks /Create /TN "${taskName}" /XML "${original}" /F`,
  };
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n) => { const i = rest.indexOf(`--${n}`); return i === -1 ? null : rest[i + 1]; };
  const common = { root: opt("root"), repo: opt("repo"), ref: opt("ref"), release: opt("release"), expectProfile: opt("expect-profile"), expectRisk: opt("expect-risk"), krakenBase: opt("kraken-base"),
    dir: opt("dir"), oldEngine: opt("old-engine"), state: opt("state"), node: opt("node"), taskName: opt("task-name") ?? undefined };
  const cmds = { prepare, "install-launcher": installLauncher, validate, activate, rollback, status, selftest, "state-check": stateCheck, "migrate-state": migrateState, "revert-state": revertState, "task-xml": taskXml };
  try {
    if (!cmds[cmd]) fail(`usage: release.mjs <${Object.keys(cmds).join("|")}> --root <dir> [...]`);
    if (!common.root && cmd !== "state-check") fail("--root is required");
    if ((cmd === "prepare" || cmd === "install-launcher") && !common.repo) fail("--repo is required");
    const out = cmds[cmd](common);
    console.log(JSON.stringify(out, null, 1));
    process.exit(out.ok === false ? 1 : 0);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e instanceof ReleaseError ? e.message : String(e.stack ?? e) }, null, 1));
    process.exit(2);
  }
}

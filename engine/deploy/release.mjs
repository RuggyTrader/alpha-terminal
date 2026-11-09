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
//   data\                   engine state, audit log, lock file (ENGINE_DATA_DIR is forced here)
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

const paths = (root) => ({
  root: resolve(root), releases: join(resolve(root), "releases"), config: join(resolve(root), "config", "engine.env"),
  data: join(resolve(root), "data"), logs: join(resolve(root), "logs"), bin: join(resolve(root), "bin"),
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

/** Loads the configuration with the RELEASE's own config code, forcing the data directory under the root. */
function checkConfig(P, dir, { expectProfile = null, expectRisk = null } = {}) {
  if (!existsSync(P.config)) return { ok: false, problems: [`no configuration file at ${P.config}`] };
  // Effective inputs = Pine defaults overridden by the profile and the env file, exactly as the engine computes them.
  const script = `const { loadConfig, redacted } = await import(${JSON.stringify(pathToFileURL(join(dir, "src", "config.mjs")).href)});
    const { DEFAULT_INPUTS } = await import(${JSON.stringify(pathToFileURL(join(dir, "src", "ote.mjs")).href)});
    const c = loadConfig(process.env, process.cwd());
    const i = { ...DEFAULT_INPUTS, ...c.inputs };
    console.log(JSON.stringify({ profile: c.profile, symbol: c.symbol, intervalMin: c.intervalMin, sync: c.sync, apiBase: c.apiBase, dataDir: c.dataDir, riskUSD: i.riskUSD, allowLong: i.allowLong, allowShort: i.allowShort, sizing: c.sizing?.mode ?? "fixed", secret: redacted(c).webhookSecret }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ENGINE_ENV_FILE: P.config, ENGINE_DATA_DIR: P.data },
  });
  if (r.status !== 0) return { ok: false, problems: [`configuration rejected by the release: ${(r.stderr || r.stdout).trim().split("\n").find((l) => /Error/.test(l)) ?? r.stderr.trim()}`] };
  const c = JSON.parse(r.stdout.trim().split("\n").at(-1));
  const problems = [];
  if (resolve(c.dataDir) !== resolve(P.data)) problems.push(`data directory ${c.dataDir} is not ${P.data}`);
  if (resolve(c.dataDir).startsWith(resolve(P.releases))) problems.push("data directory is inside the releases folder");
  if (expectProfile !== null && c.profile !== expectProfile) problems.push(`profile is ${c.profile}, expected ${expectProfile}`);
  if (expectRisk !== null && Number(c.riskUSD) !== Number(expectRisk)) problems.push(`risk per trade is ${c.riskUSD}, expected ${expectRisk}`);
  return { ok: problems.length === 0, problems, config: c };
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
  return { ok: problems.length === 0, release: id, commit: files.manifest?.commit ?? null, ref: files.manifest?.ref ?? null, problems, config: cfg.config ?? null };
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
  if (!existsSync(P.data)) return { running: false };
  const lock = readdirSync(P.data).find((f) => /^engine-.*\.lock$/.test(f));
  if (!lock) return { running: false };
  const pid = Number(readFileSync(join(P.data, lock), "utf8"));
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
    config_present: existsSync(P.config), launcher, engine: engineState(P),
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
    const ok = r.status === 0 && /PAPER only/.test(r.stdout) && state.some((f) => f.startsWith("state-"));
    const after = verifyTree(dir);
    return { ok: ok && after.ok, release, commit: v.commit, exit: r.status, state_files: state, release_unchanged: after.ok,
      output: (r.stdout + r.stderr).split("\n").filter(Boolean).slice(-6) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n) => { const i = rest.indexOf(`--${n}`); return i === -1 ? null : rest[i + 1]; };
  const common = { root: opt("root"), repo: opt("repo"), ref: opt("ref"), release: opt("release"), expectProfile: opt("expect-profile"), expectRisk: opt("expect-risk"), krakenBase: opt("kraken-base") };
  const cmds = { prepare, "install-launcher": installLauncher, validate, activate, rollback, status, selftest };
  try {
    if (!cmds[cmd]) fail(`usage: release.mjs <${Object.keys(cmds).join("|")}> --root <dir> [...]`);
    if (!common.root) fail("--root is required");
    if ((cmd === "prepare" || cmd === "install-launcher") && !common.repo) fail("--repo is required");
    const out = cmds[cmd](common);
    console.log(JSON.stringify(out, null, 1));
    process.exit(out.ok === false ? 1 : 0);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e instanceof ReleaseError ? e.message : String(e.stack ?? e) }, null, 1));
    process.exit(2);
  }
}

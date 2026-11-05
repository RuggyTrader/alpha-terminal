// Shared helpers for the observation scripts (start.ps1 creates the run folder these read).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OBS_DIR = join(ENGINE_DIR, "observations");

/** The run folder: --run <dir>, else the active run, else the newest one. */
export function runDir(argv = process.argv) {
  const i = argv.indexOf("--run");
  if (i > 0 && argv[i + 1]) return resolve(argv[i + 1]);
  const cur = join(OBS_DIR, "CURRENT");
  if (existsSync(cur)) return readFileSync(cur, "utf8").trim();
  if (!existsSync(OBS_DIR)) throw new Error("no observation runs yet (engine/observations is missing)");
  const runs = readdirSync(OBS_DIR).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort();
  if (!runs.length) throw new Error("no observation runs yet");
  return join(OBS_DIR, runs.at(-1));
}

export const readJson = (f, dflt = null) => { try { return JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { return dflt; } };

export function readJsonl(f) {
  if (!existsSync(f)) return [];
  const out = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { out.push({ type: "unparsable_line", text: line.slice(0, 200) }); }
  }
  return out;
}

export function readEnv(f) {
  const out = {};
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export const runInfo = (run) => readJson(join(run, "run.json"), {});
export const enginePaths = (run) => {
  const data = join(run, "engine-data");
  return { data, state: join(data, "state-SOLUSD-5m.json"), audit: join(data, "audit-SOLUSD-5m.jsonl") };
};

/** Read-only query against the run's local D1 (the SQLite file wrangler dev persists). */
export function d1(run, sql) {
  const dir = join(run, "d1", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!file) return null;
  const db = new DatabaseSync(join(dir, file), { readOnly: true });
  try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); }
}

export async function dashboard(base, passphrase) {
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  if (!cookie) throw new Error(`login failed (${login.status})`);
  const r = await fetch(`${base}/api/dashboard`, { headers: { Cookie: cookie, "X-Alpha-Terminal": "1" } });
  if (r.status !== 200) throw new Error(`dashboard ${r.status}`);
  return (await r.json()).data;
}

export const fmtDur = (s) => {
  if (s === null || s === undefined || !Number.isFinite(s)) return "n/a";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${Math.round(s % 60)}s`;
};

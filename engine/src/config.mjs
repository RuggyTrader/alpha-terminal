// Engine configuration. Everything comes from the environment or an env file OUTSIDE source control
// (default: engine/.env, or the path in ENGINE_ENV_FILE). Secrets are never written to logs or state files.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_INPUTS } from "./ote.mjs";

// Validated for the engine so far. Other supported crypto only after their own validation; futures and gold
// stay disabled until a truthful data feed exists.
export const ENGINE_SYMBOLS = Object.freeze(["SOLUSD"]);

export function loadEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const v = m[2];
    // Quoted values are taken literally; otherwise a " # comment" after the value is ignored.
    const quoted = v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0];
    out[m[1]] = quoted ? v.slice(1, -1) : v.replace(/\s+#.*$/, "");
  }
  return out;
}

const INPUT_ENV = Object.fromEntries(Object.keys(DEFAULT_INPUTS).map((k) => [`STRAT_${k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`, k]));

export function loadConfig(env = process.env, baseDir = process.cwd()) {
  const fileEnv = loadEnvFile(resolve(baseDir, env.ENGINE_ENV_FILE ?? ".env"));
  const get = (k, d) => (env[k] ?? fileEnv[k] ?? d);
  const symbol = get("ENGINE_SYMBOL", "SOLUSD");
  if (!ENGINE_SYMBOLS.includes(symbol)) throw new Error(`${symbol} is not enabled for the engine (enabled: ${ENGINE_SYMBOLS.join(", ")})`);
  const intervalMin = Number(get("ENGINE_INTERVAL_MIN", "5"));
  if (![1, 5, 15, 30, 60].includes(intervalMin)) throw new Error(`unsupported ENGINE_INTERVAL_MIN ${intervalMin}`);

  // Strategy inputs: Pine defaults, optionally overridden with STRAT_<INPUT_NAME> (e.g. STRAT_RISK_USD=20).
  const inputs = {};
  for (const [envKey, input] of Object.entries(INPUT_ENV)) {
    const v = get(envKey, undefined);
    if (v === undefined) continue;
    const d = DEFAULT_INPUTS[input];
    inputs[input] = typeof d === "boolean" ? v === "true" : typeof d === "number" ? Number(v) : v;
    if (typeof d === "number" && !Number.isFinite(inputs[input])) throw new Error(`${envKey} must be a number`);
  }

  const sync = get("ENGINE_SYNC", "off") === "on";
  const apiBase = get("ALPHA_API_BASE", "").replace(/\/+$/, "");
  const webhookSecret = get("ALPHA_WEBHOOK_SECRET", "");
  if (sync && (!apiBase || !webhookSecret)) throw new Error("ENGINE_SYNC=on needs ALPHA_API_BASE and ALPHA_WEBHOOK_SECRET");

  return {
    symbol, intervalMin, inputs, sync, apiBase, webhookSecret,
    dataDir: resolve(baseDir, get("ENGINE_DATA_DIR", "data")),
    pollSeconds: Number(get("ENGINE_POLL_SECONDS", "20")),
    lateBars: Number(get("ENGINE_LATE_BARS", "2")),
    krakenBase: get("KRAKEN_API_BASE", ""),
  };
}

/** Config safe to print (no secret). */
export const redacted = (cfg) => ({ ...cfg, webhookSecret: cfg.webhookSecret ? "(set)" : "(not set)" });

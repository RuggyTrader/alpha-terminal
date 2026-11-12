// Engine configuration. Everything comes from the environment or an env file OUTSIDE source control
// (default: engine/.env, or the path in ENGINE_ENV_FILE). Secrets are never written to logs or state files.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_INPUTS } from "./ote.mjs";
import { FUNDED_SYMBOLS, fundedStatus, getInstrument } from "./instruments.mjs";
import { BOTS, botIdPrefix, botTag, selectBots } from "./bots.mjs";

// Funded markets come ONLY from the instrument registry (src/instruments.mjs): verified specs + owner approval.
// Futures, gold and stocks are not listed there and stay unavailable until their rules and a data feed are verified.
export const ENGINE_SYMBOLS = FUNDED_SYMBOLS;
// Strategy Mirror only (ENGINE_FUNDED=off): hypothetical trades, never a funded signal, transfer or broker order.
// Pair mapping and completed 5m OHLC verified against Kraken (AssetPairs XXBTZUSD tick 0.1, XETHZUSD tick 0.01).
export const MIRROR_ONLY_SYMBOLS = Object.freeze(["BTCUSD", "ETHUSD"]);

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
  // Optional named profile (profiles/<name>.env), lowest precedence: environment > env file > profile > Pine defaults.
  const profile = (env.ENGINE_PROFILE ?? fileEnv.ENGINE_PROFILE ?? "") || null;
  if (profile !== null && !/^[a-z0-9-]{1,40}$/.test(profile)) throw new Error(`invalid ENGINE_PROFILE ${profile}`);
  const profileFile = profile === null ? null : resolve(baseDir, "profiles", `${profile}.env`);
  if (profileFile !== null && !existsSync(profileFile)) throw new Error(`profile ${profile} not found (profiles/${profile}.env)`);
  const profileEnv = profileFile === null ? {} : loadEnvFile(profileFile);
  if (Object.keys(profileEnv).some((k) => /SECRET|API_BASE|SYNC/.test(k))) throw new Error(`profile ${profile} may only hold strategy/engine settings, not secrets or sync targets`);
  const get = (k, d) => (env[k] ?? fileEnv[k] ?? profileEnv[k] ?? d);
  // ENGINE_FUNDED=off: a mirror-only market. The funded track (signals to the PAPER ledger, ledger checks, engine
  // status and website risk settings) does not run at all; only the Strategy Mirror does.
  const fundedSetting = get("ENGINE_FUNDED", "on");
  if (!["on", "off"].includes(fundedSetting)) throw new Error("ENGINE_FUNDED must be on or off");
  const funded = fundedSetting === "on";
  const symbol = get("ENGINE_SYMBOL", "SOLUSD");
  if (funded && !ENGINE_SYMBOLS.includes(symbol)) throw new Error(`${symbol} is not enabled for the engine (enabled: ${ENGINE_SYMBOLS.join(", ")}): ${fundedStatus(symbol).reason}`);
  if (!funded && !MIRROR_ONLY_SYMBOLS.includes(symbol)) throw new Error(`${symbol} is not enabled as a mirror-only market (enabled: ${MIRROR_ONLY_SYMBOLS.join(", ")})`);
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

  // Position sizing (src/sizing.mjs, docs/UNIVERSAL-POSITION-SIZING.md). A funded engine that trades against the ALPHA
  // PAPER ledger (sync on) sizes from its strategy wallet's available equity: "percent" is its default, and "fixed"
  // (the Pine formula, risk in USD regardless of equity) is refused unless ENGINE_SIZING_FIXED_REASON records why
  // (research or parity runs only). Without a ledger (sync off) "fixed" stays the default for local research.
  const mode = get("ENGINE_SIZING", funded && sync ? "percent" : "fixed");
  if (!["fixed", "percent", "dollar"].includes(mode)) throw new Error(`ENGINE_SIZING must be fixed, percent or dollar, not ${mode}`);
  // dollar (fleet bots): the bot's own dollar risk per trade, from the registry / the website's per-bot setting.
  const riskUSD = mode === "dollar" ? Number(get("ENGINE_RISK_USD", "")) : null;
  if (mode === "dollar" && !(riskUSD > 0)) throw new Error("ENGINE_SIZING=dollar needs ENGINE_RISK_USD (a positive dollar amount)");
  const fixedReason = get("ENGINE_SIZING_FIXED_REASON", "").trim();
  if (funded && sync && mode === "fixed" && !fixedReason) {
    throw new Error("ENGINE_SIZING=fixed for a funded engine that trades against the PAPER ledger needs ENGINE_SIZING_FIXED_REASON (research only); funded sizing is percent of available equity (docs/UNIVERSAL-POSITION-SIZING.md)");
  }
  // Maximum risk per trade: "setting" (default) = the strategy's risk setting (the website's, $10 today); a number; or off.
  const maxRiskRaw = get("ENGINE_MAX_RISK_USD", "setting");
  if (maxRiskRaw !== "setting" && maxRiskRaw !== "off" && !(Number(maxRiskRaw) > 0)) throw new Error("ENGINE_MAX_RISK_USD must be setting, off or a positive number");
  const pct = (k, d, lo, hi) => {
    const v = Number(get(k, String(d)));
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k} must be between ${lo} and ${hi}`);
    return v;
  };
  const sizing = {
    mode,
    riskPct: pct("ENGINE_RISK_PCT", 1, 0.01, 10),
    riskUSD, simulatedShort: mode === "dollar",
    feePct: pct("ENGINE_FEE_PCT", 0.4, 0, 2),
    priceBufferPct: pct("ENGINE_PRICE_BUFFER_PCT", 0.5, 0, 5),
    maxRisk: maxRiskRaw === "setting" || maxRiskRaw === "off" ? maxRiskRaw : Number(maxRiskRaw),
    fixedReason: mode === "fixed" ? fixedReason || null : null,
    symbol, instrument: getInstrument(symbol),
  };
  // Without the website (sync off) percent mode needs a simulated balance to size from.
  const localCapital = get("ENGINE_PAPER_CAPITAL", "");
  if (localCapital !== "" && !(Number(localCapital) >= 0)) throw new Error("ENGINE_PAPER_CAPITAL must be a number ≥ 0");

  return {
    sizing, localCapital: localCapital === "" ? null : Number(localCapital),
    profile: profile ?? "default", symbol, intervalMin, inputs, sync, apiBase, webhookSecret,
    dataDir: resolve(baseDir, get("ENGINE_DATA_DIR", "data")),
    pollSeconds: Number(get("ENGINE_POLL_SECONDS", "20")),
    lateBars: Number(get("ENGINE_LATE_BARS", "2")),
    krakenBase: get("KRAKEN_API_BASE", ""),
    // Take the risk per trade set on the ALPHA TERMINAL website (versioned, confirmed back). Off by default.
    remoteSettings: funded && get("ENGINE_REMOTE_SETTINGS", "off") === "on",
    // Strategy Mirror (src/mirror.mjs): an independent, hypothetical copy of the strategy with margin-0 semantics,
    // reported separately from the funded ledger. Off by default: turning it on is a deliberate activation.
    mirror: (() => {
      const v = get("ENGINE_MIRROR", "off");
      if (!["on", "off"].includes(v)) throw new Error("ENGINE_MIRROR must be on or off");
      if (!funded && v !== "on") throw new Error("ENGINE_FUNDED=off runs only the Strategy Mirror: it needs ENGINE_MIRROR=on");
      return v === "on";
    })(),
    funded,
    // Explicit Strategy Mirror ENTRY records for entry notifications. Off by default: turn on only after the Worker
    // that stores them (migration 0006) is deployed; an older Worker would leave them pending.
    mirrorEvents: (() => {
      const v = get("ENGINE_MIRROR_EVENTS", "off");
      if (!["on", "off"].includes(v)) throw new Error("ENGINE_MIRROR_EVENTS must be on or off");
      return v === "on";
    })(),
    // Conservative limit fills: a resting limit order fills only when price trades this many ticks THROUGH it (a touch
    // may stay unfilled in the queue). 0 (default) keeps the TradingView emulator rule unchanged.
    limitThroughTicks: (() => {
      const v = Number(get("ENGINE_LIMIT_THROUGH_TICKS", "0"));
      if (!Number.isInteger(v) || v < 0 || v > 20) throw new Error("ENGINE_LIMIT_THROUGH_TICKS must be an integer 0-20");
      return v;
    })(),
  };
}

/**
 * Mirror-only markets of a multi-market process (ENGINE_MARKETS=BTCUSD,ETHUSD), or [] when not set. Each market gets
 * its own config from the same settings: ENGINE_FUNDED=off, its own symbol, its own state and audit files. SOLUSD is
 * refused here: it runs in its own (funded) engine, and a second SOLUSD mirror would report into the same account.
 */
export function marketList(env = process.env, baseDir = process.cwd()) {
  const fileEnv = loadEnvFile(resolve(baseDir, env.ENGINE_ENV_FILE ?? ".env"));
  const raw = (env.ENGINE_MARKETS ?? fileEnv.ENGINE_MARKETS ?? "").trim();
  if (!raw) return [];
  const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
  for (const m of list) if (!MIRROR_ONLY_SYMBOLS.includes(m)) throw new Error(`ENGINE_MARKETS: ${m} is not a mirror-only market (allowed: ${MIRROR_ONLY_SYMBOLS.join(", ")})`);
  if (new Set(list).size !== list.length) throw new Error("ENGINE_MARKETS lists a market twice");
  return list;
}

export function loadMarketConfigs(env = process.env, baseDir = process.cwd()) {
  return marketList(env, baseDir).map((symbol) => loadConfig({ ...env, ENGINE_SYMBOL: symbol, ENGINE_FUNDED: "off" }, baseDir));
}

/**
 * Fleet bots (ENGINE_BOTS=ALPHA-01,ALPHA-02), or [] when not set. docs/MULTI-BOT-ARCHITECTURE.md.
 * The bot registry (src/bots.mjs) is the source of each bot's market, timeframe, profile, risk policy and wallet: the
 * environment supplies only the shared settings (sync target, secret, data folder, poll interval). A bot's risk policy
 * can never be loosened by the environment: ENGINE_RISK_PCT / ENGINE_MAX_RISK_USD are taken from the registry.
 * Production runs ACTIVE bots only; PROPOSED bots need allowProposed (research, backtests, tests).
 */
export function botList(env = process.env, baseDir = process.cwd()) {
  const fileEnv = loadEnvFile(resolve(baseDir, env.ENGINE_ENV_FILE ?? ".env"));
  const raw = (env.ENGINE_BOTS ?? fileEnv.ENGINE_BOTS ?? "").trim();
  if (!raw) return [];
  if ((env.ENGINE_MARKETS ?? fileEnv.ENGINE_MARKETS ?? "").trim()) throw new Error("ENGINE_BOTS and ENGINE_MARKETS cannot both be set");
  return raw.split(",").map((x) => x.trim()).filter(Boolean);
}

export function loadBotConfigs(ids, env = process.env, baseDir = process.cwd(), { list = BOTS, allowProposed = false } = {}) {
  return selectBots(ids, { list, allowProposed }).map((bot) => {
    if (!bot.profile) throw new Error(`${bot.id}: no strategy profile; the owner's inputs for ${bot.symbol} ${bot.intervalMin}m are required`);
    // Strategy inputs come ONLY from the bot's own profile file: STRAT_* in the environment or env file are ignored
    // for fleet bots, so no global setting can leak into another bot's strategy.
    const strategyFree = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("STRAT_")));
    const fileEnv = loadEnvFile(resolve(baseDir, env.ENGINE_ENV_FILE ?? ".env"));
    const leaked = Object.keys(fileEnv).filter((k) => k.startsWith("STRAT_"));
    if (leaked.length) throw new Error(`${bot.id}: strategy inputs (${leaked.join(", ")}) in the shared env file would override bot profiles; remove them`);
    const sizingEnv = bot.ledgerApi === "bot"
      ? { ENGINE_SIZING: "dollar", ENGINE_RISK_USD: String(bot.riskUSD), ENGINE_FEE_PCT: "0.2", ENGINE_REMOTE_SETTINGS: "off" }
      : { ENGINE_RISK_PCT: "1", ENGINE_MAX_RISK_USD: String(bot.riskUSD) };
    const cfg = loadConfig({
      ...strategyFree, ENGINE_SYMBOL: bot.symbol, ENGINE_INTERVAL_MIN: String(bot.intervalMin), ENGINE_PROFILE: bot.profile,
      ENGINE_FUNDED: bot.funded ? "on" : "off", ...sizingEnv,
      // the single-engine settings that would mix bots are not inherited
      ENGINE_MARKETS: "", ENGINE_BOTS: "",
    }, baseDir);
    return { bot, cfg: { ...cfg, botId: bot.id, botName: bot.name, fileTag: botTag(bot), idPrefix: botIdPrefix(bot), priority: bot.priority, wallet: bot.wallet,
      ledgerApi: bot.ledgerApi, group: bot.group } };
  });
}


/** Config safe to print (no secret). */
export const redacted = (cfg) => ({ ...cfg, webhookSecret: cfg.webhookSecret ? "(set)" : "(not set)" });

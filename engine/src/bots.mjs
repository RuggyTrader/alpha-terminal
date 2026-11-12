// Bot registry (docs/MULTI-BOT-ARCHITECTURE.md). A bot is ONE independent strategy instance dedicated to one market
// and one timeframe: its own id, exact profile (immutable, versioned), inputs, candle stream, strategy state, pending
// orders, positions (LONG or SHORT), exits, wallet, dollar risk, fees, trade history, statistics, mirror, health and
// recovery files. Bots share only the process, the market-data cache and the account-wide safety checks.
//
// Status:
//   ACTIVE    approved by the owner and running in production.
//   PROPOSED  exact settings exist but activation is not approved yet: refused outside research, backtests and tests.
//   DISABLED  kept for its history; never run.
//
// Ledger path:
//   legacy  ALPHA-02 today: the pre-fleet engine path (/webhook/dry-run, SOLUSD wallet, long-only percent sizing). It
//           keeps its file names, signal ids and mirror account so its saved state resumes unchanged.
//   bot     the fleet path (/webhook/bot-order): its OWN wallet, dollar-risk sizing, LONG and SHORT (simulated, fully
//           collateralised), Ndax-equivalent fees, positive net profit swept to MAIN at every close.
//
// Every future market, timeframe or strategy is added HERE as its own bot (docs/MARKET-INTEGRATION-CHECKLIST.md).
// Crypto market data comes from Kraken unless the owner explicitly names another provider.

import { getInstrument } from "./instruments.mjs";

export const BOT_STATUSES = Object.freeze(["ACTIVE", "PROPOSED", "DISABLED"]);
export const BOT_ID_RE = /^ALPHA-\d{2}$/;
/** Allocation groups: money allocated to a group is split equally between its enabled funded bots. */
export const GROUPS = Object.freeze({ SOLANA: { symbol: "SOLUSD", name: "Solana" }, BITCOIN: { symbol: "BTCUSD", name: "Bitcoin" }, ETHEREUM: { symbol: "ETHUSD", name: "Ethereum" } });

const bot = (b) => Object.freeze({
  wallet: b.id,              // the bot's OWN wallet (no other bot can spend it)
  riskUSD: 10,               // the funded bot's dollar risk per trade (owner-editable, versioned); reference Pine risk is $10
  funded: true, mirror: true, legacy: false, ledgerApi: "bot", provider: "kraken", note: null,
  ...b,
});

export const BOTS = Object.freeze([
  bot({ id: "ALPHA-01", name: "ALPHA 01", group: "SOLANA", symbol: "SOLUSD", intervalMin: 1, profile: "solusd-1m", status: "PROPOSED", priority: 2,
    note: "Exact owner settings supplied 2026-11-12; activation awaits approval (stage S2, after the SOL wallet split)." }),
  bot({ id: "ALPHA-02", name: "ALPHA 02", group: "SOLANA", symbol: "SOLUSD", intervalMin: 5, profile: "solusd-5m", status: "ACTIVE", priority: 1,
    legacy: true, ledgerApi: "legacy", wallet: "SOLUSD",
    note: "Production SOLUSD 5m engine (release af924ffa4703). Moves to its own wallet and the bot ledger path at stage S1 (approval)." }),
  bot({ id: "ALPHA-03", name: "ALPHA 03", group: "BITCOIN", symbol: "BTCUSD", intervalMin: 1, profile: "btcusd-1m", status: "PROPOSED", priority: 3,
    note: "Exact owner settings supplied 2026-11-12; activation awaits approval (stage B1)." }),
  bot({ id: "ALPHA-04", name: "ALPHA 04", group: "BITCOIN", symbol: "BTCUSD", intervalMin: 5, profile: "btcusd-5m", status: "PROPOSED", priority: 4,
    note: "Exact owner settings supplied 2026-11-12; activation awaits approval (stage B1)." }),
  bot({ id: "ALPHA-05", name: "ALPHA 05", group: "ETHEREUM", symbol: "ETHUSD", intervalMin: 1, profile: null, status: "DISABLED", priority: 5, funded: false,
    note: "ETHUSD is not requested; inactive." }),
  bot({ id: "ALPHA-06", name: "ALPHA 06", group: "ETHEREUM", symbol: "ETHUSD", intervalMin: 5, profile: null, status: "DISABLED", priority: 6, funded: false,
    note: "ETHUSD is not requested; inactive." }),
]);

/** File/lock tag: legacy keeps `SOLUSD-5m` (production state resumes); new bots carry their id. */
export const botTag = (b) => (b.legacy ? `${b.symbol}-${b.intervalMin}m` : `${b.id}-${b.symbol}-${b.intervalMin}m`);
/** Funded signal id prefix: legacy keeps `ENG-SOLUSD-5`; new bots `ENG-ALPHA-01-SOLUSD-1`. */
export const botIdPrefix = (b) => (b.legacy ? `ENG-${b.symbol}-${b.intervalMin}` : `ENG-${b.id}-${b.symbol}-${b.intervalMin}`);

/** Problems with a registry (empty = valid). Used by the fleet before starting and by the permanent tests. */
export function registryProblems(list = BOTS) {
  const p = [];
  const ids = new Set(), tags = new Set(), strategies = new Set(), legacy = new Set(), wallets = new Set();
  for (const b of list) {
    if (!BOT_ID_RE.test(b.id ?? "")) p.push(`${b.id}: bot id must look like ALPHA-NN`);
    if (ids.has(b.id)) p.push(`${b.id}: duplicate bot id`);
    ids.add(b.id);
    if (!BOT_STATUSES.includes(b.status)) p.push(`${b.id}: unknown status ${b.status}`);
    if (!getInstrument(b.symbol)) p.push(`${b.id}: ${b.symbol} has no verified instrument specification`);
    if (b.provider !== "kraken") p.push(`${b.id}: crypto market data comes from Kraken unless the owner names another provider`);
    if (!GROUPS[b.group] || GROUPS[b.group].symbol !== b.symbol) p.push(`${b.id}: group ${b.group} does not match ${b.symbol}`);
    if (![1, 5, 15, 30, 60].includes(b.intervalMin)) p.push(`${b.id}: unsupported timeframe ${b.intervalMin}m`);
    if (b.status !== "DISABLED" && !b.profile) p.push(`${b.id}: needs its own exact strategy profile (no placeholder inputs)`);
    if (b.profile && !new RegExp(`^${b.symbol.toLowerCase()}-${b.intervalMin}m$`).test(b.profile)) p.push(`${b.id}: profile ${b.profile} is not the ${b.symbol} ${b.intervalMin}m profile`);
    if (b.funded && b.status !== "DISABLED" && getInstrument(b.symbol)?.fundedEligible !== true) p.push(`${b.id}: ${b.symbol} is not funded-eligible`);
    if (!(b.riskUSD > 0)) p.push(`${b.id}: riskUSD must be a positive dollar amount`);
    if (!["bot", "legacy"].includes(b.ledgerApi)) p.push(`${b.id}: unknown ledger path ${b.ledgerApi}`);
    if (!b.legacy && b.wallet !== b.id) p.push(`${b.id}: a fleet bot owns its own wallet (wallet must be its id)`);
    if (wallets.has(b.wallet)) p.push(`${b.id}: wallet ${b.wallet} is shared with another bot`);
    wallets.add(b.wallet);
    const tag = botTag(b);
    if (tags.has(tag)) p.push(`${b.id}: state files ${tag} collide with another bot`);
    tags.add(tag);
    const key = `${b.symbol}|${b.intervalMin}|${b.profile ?? `(none:${b.id})`}`;
    if (strategies.has(key)) p.push(`${b.id}: same market, timeframe and profile as another bot`);
    strategies.add(key);
    if (b.legacy) {
      if (legacy.has(b.symbol)) p.push(`${b.id}: only one legacy bot per market`);
      legacy.add(b.symbol);
    }
  }
  return p;
}

export const getBot = (id, list = BOTS) => list.find((b) => b.id === id) ?? null;
export const groupBots = (group, list = BOTS) => list.filter((b) => b.group === group && b.status !== "DISABLED" && b.funded);

/**
 * The bots a fleet may run. Production: ACTIVE only. `allowProposed` is for research, backtests and tests, and still
 * refuses DISABLED bots and bots without their own profile.
 */
export function selectBots(ids, { list = BOTS, allowProposed = false } = {}) {
  const problems = registryProblems(list);
  if (problems.length) throw new Error(`bot registry invalid: ${problems.join("; ")}`);
  if (new Set(ids).size !== ids.length) throw new Error("a bot is listed twice");
  return ids.map((id) => {
    const b = getBot(id, list);
    if (!b) throw new Error(`${id}: unknown bot`);
    if (b.status === "DISABLED") throw new Error(`${id}: disabled`);
    if (b.status === "PROPOSED" && !allowProposed) throw new Error(`${id}: PROPOSED, not approved for activation (${b.note ?? "owner approval required"})`);
    if (!b.profile) throw new Error(`${id}: no strategy profile`);
    return b;
  });
}

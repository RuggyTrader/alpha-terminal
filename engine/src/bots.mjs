// Bot registry (docs/MULTI-BOT-ARCHITECTURE.md). A bot is ONE independent strategy instance dedicated to one market
// and one timeframe: its own id, profile, inputs, candle stream, strategy state, pending orders, positions, exits,
// trade history, statistics, health and recovery files. Bots share only the process, the market-data cache and the
// central capital/risk protection (src/capital.mjs and the Worker's ledger).
//
// Status:
//   ACTIVE    approved by the owner and allowed to run in production.
//   PROPOSED  a planned configuration. NOT authorised: the fleet refuses to run it outside research/backtests.
//   DISABLED  kept for its history; never run.
//
// ALPHA-02 is today's production SOLUSD 5m engine. It keeps its existing file names and ids (`legacy: true`) so the
// running state, signals and mirror account resume unchanged; every new bot carries its bot id in file names and ids.
//
// Every future market, timeframe or strategy is added HERE as its own bot (docs/MARKET-INTEGRATION-CHECKLIST.md).

import { getInstrument } from "./instruments.mjs";

export const BOT_STATUSES = Object.freeze(["ACTIVE", "PROPOSED", "DISABLED"]);
export const BOT_ID_RE = /^ALPHA-\d{2}$/;

const bot = (b) => Object.freeze({
  wallet: b.symbol,          // capital source: the market's PAPER strategy wallet, shared by every bot on that market
  allocationCapUSD: null,    // optional per-bot cap on capital it may hold reserved at once (null = shared, no cap)
  riskPct: 1, maxRiskUSD: 10, // default funded policy: 1% of available allocated equity, at most $10 target risk
  funded: true, mirror: true, legacy: false, note: null,
  ...b,
});

export const BOTS = Object.freeze([
  bot({ id: "ALPHA-01", name: "ALPHA 01", symbol: "SOLUSD", intervalMin: 1, profile: null, status: "PROPOSED", priority: 2,
    note: "Awaiting the owner's exact SOLUSD 1m TradingView inputs and Strategy Report. The 5m inputs are NOT assumed for 1m." }),
  bot({ id: "ALPHA-02", name: "ALPHA 02", symbol: "SOLUSD", intervalMin: 5, profile: "solusd-5m", status: "ACTIVE", priority: 1, legacy: true,
    note: "The production SOLUSD 5m engine (release af924ffa4703, percent sizing 1% / max $10)." }),
  bot({ id: "ALPHA-03", name: "ALPHA 03", symbol: "BTCUSD", intervalMin: 1, profile: null, status: "PROPOSED", priority: 3, funded: false,
    note: "Future. BTCUSD is not funded-eligible (instrument registry); 1m inputs not supplied." }),
  bot({ id: "ALPHA-04", name: "ALPHA 04", symbol: "BTCUSD", intervalMin: 5, profile: null, status: "PROPOSED", priority: 4, funded: false,
    note: "Future. BTCUSD is not funded-eligible; mirror-only research (Multi-Crypto V2) awaits its own approval." }),
  bot({ id: "ALPHA-05", name: "ALPHA 05", symbol: "ETHUSD", intervalMin: 1, profile: null, status: "PROPOSED", priority: 5, funded: false,
    note: "Future. ETHUSD is not funded-eligible; 1m inputs not supplied." }),
  bot({ id: "ALPHA-06", name: "ALPHA 06", symbol: "ETHUSD", intervalMin: 5, profile: null, status: "PROPOSED", priority: 6, funded: false,
    note: "Future. ETHUSD is not funded-eligible; mirror-only research (Multi-Crypto V2) awaits its own approval." }),
]);

/** File/lock tag: legacy keeps `SOLUSD-5m` (production state resumes); new bots carry their id. */
export const botTag = (b) => (b.legacy ? `${b.symbol}-${b.intervalMin}m` : `${b.id}-${b.symbol}-${b.intervalMin}m`);
/** Funded signal id prefix: legacy keeps `ENG-SOLUSD-5`; new bots `ENG-ALPHA-01-SOLUSD-1`. */
export const botIdPrefix = (b) => (b.legacy ? `ENG-${b.symbol}-${b.intervalMin}` : `ENG-${b.id}-${b.symbol}-${b.intervalMin}`);

/** Problems with a registry (empty = valid). Used by the fleet before starting and by the permanent tests. */
export function registryProblems(list = BOTS) {
  const p = [];
  const ids = new Set(), tags = new Set(), strategies = new Set(), legacy = new Set();
  for (const b of list) {
    if (!BOT_ID_RE.test(b.id ?? "")) p.push(`${b.id}: bot id must look like ALPHA-NN`);
    if (ids.has(b.id)) p.push(`${b.id}: duplicate bot id`);
    ids.add(b.id);
    if (!BOT_STATUSES.includes(b.status)) p.push(`${b.id}: unknown status ${b.status}`);
    if (!getInstrument(b.symbol)) p.push(`${b.id}: ${b.symbol} has no verified instrument specification`);
    if (![1, 5, 15, 30, 60].includes(b.intervalMin)) p.push(`${b.id}: unsupported timeframe ${b.intervalMin}m`);
    if (b.status === "ACTIVE" && !b.profile) p.push(`${b.id}: an ACTIVE bot needs a strategy profile (the owner's inputs)`);
    if (b.funded && b.status === "ACTIVE" && getInstrument(b.symbol)?.fundedEligible !== true) p.push(`${b.id}: ${b.symbol} is not funded-eligible`);
    if (!(b.riskPct > 0 && b.riskPct <= 10)) p.push(`${b.id}: riskPct must be in (0, 10]`);
    if (!(b.maxRiskUSD > 0)) p.push(`${b.id}: maxRiskUSD must be positive (a hard cap, never "setting")`);
    if (b.allocationCapUSD !== null && !(b.allocationCapUSD > 0)) p.push(`${b.id}: allocationCapUSD must be null or positive`);
    const tag = botTag(b);
    if (tags.has(tag)) p.push(`${b.id}: state files ${tag} collide with another bot`);
    tags.add(tag);
    // Two bots running the same profile on the same market and timeframe would be the same strategy twice.
    const key = `${b.symbol}|${b.intervalMin}|${b.profile ?? `(none:${b.id})`}`;
    if (strategies.has(key)) p.push(`${b.id}: same market, timeframe and profile as another bot`);
    strategies.add(key);
    if (b.legacy) {
      const lk = `${b.symbol}|${b.intervalMin}`;
      if (legacy.has(lk)) p.push(`${b.id}: only one legacy bot per market and timeframe`);
      legacy.add(lk);
    }
  }
  return p;
}

export const getBot = (id, list = BOTS) => list.find((b) => b.id === id) ?? null;

/**
 * The bots a fleet may run. Production: ACTIVE only. `allowProposed` is for research, backtests and tests, and still
 * refuses DISABLED bots and bots without a profile.
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
    if (!b.profile && !allowProposed) throw new Error(`${id}: no strategy profile`);
    return b;
  });
}

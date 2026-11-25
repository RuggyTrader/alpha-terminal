// Jupiter Perps PAPER execution adapter. PAPER ONLY, by construction:
//   * there is no wallet, no key, no signer and no code path that sends or executes a transaction;
//   * request bodies are BUILT (in the shapes of the official Jupiter CLI's perps-api.jup.ag/v2 client,
//     github.com/jup-ag/cli src/clients/PerpsClient.ts) and VALIDATED, then handed to the shared ledger's simulated keeper;
//   * the only network calls are read-only and pass through guardedFetch (GET to allow-listed market-data hosts, and the
//     Solana JSON-RPC read methods getMultipleAccounts / getAccountInfo). Anything else throws.
import { liquidationPrice, positionValue, pnl } from "./costs.mjs";

export const LIVE_EXECUTION_ENABLED = false; // a constant, not a setting: there is no live path to enable
export const PERPS_API = "https://perps-api.jup.ag/v2";
export const MINTS = { SOL: "So11111111111111111111111111111111111111112", BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
const READ_HOSTS = new Set(["perps-api.jup.ag", "data-api.binance.vision", "api.mainnet-beta.solana.com", "raw.githubusercontent.com"]);
const READ_RPC = new Set(["getMultipleAccounts", "getAccountInfo"]);
const PAPER_WALLET = "PAPER-NO-WALLET";

/** The only fetch the PAPER engine uses: read-only by construction. */
export function guardedFetch(fetchFn = fetch) {
  return async (url, init = {}) => {
    const u = new URL(url), method = (init.method ?? "GET").toUpperCase();
    if (!READ_HOSTS.has(u.host)) throw new Error(`PAPER guard: host ${u.host} is not allow-listed`);
    if (u.host === "perps-api.jup.ag" && (method !== "GET" || !/^\/v2\/(market-stats)$/.test(u.pathname))) throw new Error(`PAPER guard: ${method} ${u.pathname} on the Perps API is not allowed (read-only market-stats only)`);
    if (method !== "GET") {
      if (u.host !== "api.mainnet-beta.solana.com") throw new Error(`PAPER guard: ${method} to ${u.host} refused`);
      const body = JSON.parse(init.body ?? "{}"); if (!READ_RPC.has(body.method)) throw new Error(`PAPER guard: RPC method ${body.method} refused`);
    }
    return fetchFn(url, init);
  };
}

const atomic = (usd) => String(Math.round(usd * 1e6));
/** Build a Jupiter-compatible request body for an approved plan (never sent). */
export function buildRequest(rq, { asset, refPrice, maxSlippageBps = 100 }) {
  const side = rq.side;
  if (rq.type === "OPEN" || rq.type === "INCREASE") {
    const body = { asset, inputToken: "USDC", inputTokenAmount: atomic(rq.collateralUsdDelta), side, maxSlippageBps: String(maxSlippageBps), sizeUsdDelta: atomic(rq.sizeUsdDelta), walletAddress: PAPER_WALLET };
    return { method: "POST", path: "/positions/increase", body, refPrice, key: rq.key };
  }
  const body = { positionPubkey: `PAPER-${asset}-${side}`, receiveToken: "USDC", maxSlippageBps: String(maxSlippageBps), ...(rq.type === "CLOSE" ? { entirePosition: true } : { sizeUsdDelta: atomic(rq.sizeUsdDelta), entirePosition: false }) };
  return { method: "POST", path: "/positions/decrease", body, refPrice, key: rq.key };
}
/** Build the stop-loss (TP/SL) request for a position (never sent). */
export function buildStopRequest(asset, pos) {
  return { method: "POST", path: "/tpsl", body: { walletAddress: PAPER_WALLET, positionPubkey: `PAPER-${asset}-${pos.side}`, tpsl: [{ receiveToken: "USDC", triggerPrice: atomic(pos.stop), requestType: "sl", entirePosition: true }] } };
}

/** Validate a request against Jupiter's documented constraints. Returns a list of problems (empty = valid). */
export function validateRequest(req, { rm, positions = {} } = {}) {
  const e = [], b = req.body ?? {};
  const isUint = (x) => typeof x === "string" && /^\d+$/.test(x);
  if (req.path === "/positions/increase") {
    if (!["SOL", "BTC", "ETH"].includes(b.asset)) e.push("asset must be SOL, BTC or ETH");
    if (!["long", "short"].includes(b.side)) e.push("side must be long or short");
    if (!isUint(b.inputTokenAmount) || !isUint(b.sizeUsdDelta)) e.push("amounts must be atomic integer strings");
    const coll = Number(b.inputTokenAmount) / 1e6, size = Number(b.sizeUsdDelta) / 1e6, existing = positions[b.asset];
    if (!existing && coll < (rm?.minCollateralUsd ?? 10) - 1e-6) e.push("minimum collateral is $10 for a new position");
    const lev = existing ? (existing.sizeUsd + size) / (existing.collateralUsd + coll) : size / coll;
    if (!existing && lev < (rm?.minLeverage ?? 1.1) - 1e-6) e.push("minimum leverage is 1.1x");
    if (lev > 250) e.push("maximum leverage is 250x");
    if (b.walletAddress !== PAPER_WALLET) e.push("PAPER requests must not carry a real wallet");
  } else if (req.path === "/positions/decrease") {
    if (!/^PAPER-/.test(b.positionPubkey ?? "")) e.push("PAPER position keys only");
    if (!b.entirePosition && !isUint(b.sizeUsdDelta)) e.push("partial decrease needs sizeUsdDelta");
  } else if (req.path === "/tpsl") {
    if (!b.tpsl?.length || !isUint(b.tpsl[0].triggerPrice)) e.push("trigger price required");
  } else e.push(`unsupported path ${req.path}`);
  if (!isUint(b.maxSlippageBps ?? "0")) e.push("maxSlippageBps must be an integer string");
  return e;
}

/** Simulated on-chain view of a ledger position, in the field names of the Perps API Position type. */
export function positionView(asset, p, mark, c) {
  return { positionPubkey: `PAPER-${asset}-${p.side}`, asset, side: p.side, leverage: p.sizeUsd / p.collateralUsd, sizeUsd: p.sizeUsd, collateralUsd: p.collateralUsd,
    entryPriceUsd: p.entry, markPriceUsd: mark, liquidationPriceUsd: liquidationPrice(p, c), borrowFeesUsd: p.borrowAccrued,
    pnlBeforeFeesUsd: pnl(p, mark), valueUsd: positionValue(p, mark, c), tpslRequests: p.stop ? [{ requestType: "sl", triggerPriceUsd: p.stop }] : [] };
}

/** Read-only market stats (mark price) from the Perps API, for health and oracle-vs-substitute comparison. */
export async function fetchMarketStats(fetchFn) {
  const out = {};
  for (const a of ["SOL", "BTC", "ETH"]) { const r = await fetchFn(`${PERPS_API}/market-stats?mint=${MINTS[a]}`); if (!r.ok) throw new Error(`market-stats ${a} HTTP ${r.status}`); const j = await r.json(); out[a] = { priceUsd: Number(j.price), volumeUsd: Number(j.volume) }; }
  return out;
}
/** Read-only Binance substitute candles (closed hours only) after `sinceT`. */
export async function fetchBars(fetchFn, symbol, sinceT, nowT) {
  const rows = []; let t = sinceT; const end = Math.floor(nowT / 3_600_000) * 3_600_000;
  while (t < end) {
    const r = await fetchFn(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000&startTime=${t}`); if (!r.ok) throw new Error(`klines ${symbol} HTTP ${r.status}`);
    const b = await r.json(); if (!b.length) break;
    for (const x of b) if (x[0] < end) rows.push([x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]);
    t = b.at(-1)[0] + 3_600_000;
  }
  return rows;
}

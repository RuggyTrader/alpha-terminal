// READ-ONLY Jupiter Perps on-chain parameter reader (research / PAPER). No wallet, no keys, no signing, no transactions:
// it only calls the public Solana JSON-RPC method getMultipleAccounts and decodes the accounts with the program's Anchor IDL.
// The IDL is fetched at run time from the repository Jupiter's docs link to (it carries no licence, so it is not vendored);
// its SHA-256 is recorded with every snapshot so a layout change is detectable.
import { createHash } from "node:crypto";

export const PROGRAM = "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu";
export const POOL = "5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq";
export const CUSTODY = { SOL: "7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz", ETH: "AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn", BTC: "5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm", USDC: "G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa", USDT: "4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk" };
export const IDL_URL = "https://raw.githubusercontent.com/julianfssen/jupiter-perps-anchor-idl-parsing/main/src/idl/jupiter-perpetuals-idl-json.json";
export const RATE_POWER = 1e9, BPS = 1e4, DBPS = 1e5, HOURS_PER_YEAR = 24 * 365;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

/** Decode one Anchor account (8-byte discriminator skipped) with the IDL's type tree. Integers come back as BigInt. */
export function decodeAccount(idl, accountName, buf) {
  const types = Object.fromEntries([...(idl.types ?? []), ...(idl.accounts ?? [])].map((t) => [t.name, t]));
  let o = 8;
  const read = (ty) => {
    if (typeof ty === "string") {
      switch (ty) {
        case "u8": return buf.readUInt8(o++);
        case "bool": return buf.readUInt8(o++) !== 0;
        case "u16": { const v = buf.readUInt16LE(o); o += 2; return v; }
        case "u32": { const v = buf.readUInt32LE(o); o += 4; return v; }
        case "i32": { const v = buf.readInt32LE(o); o += 4; return v; }
        case "f32": { const v = buf.readFloatLE(o); o += 4; return v; }
        case "u64": { const v = buf.readBigUInt64LE(o); o += 8; return v; }
        case "i64": { const v = buf.readBigInt64LE(o); o += 8; return v; }
        case "u128": { const v = buf.readBigUInt64LE(o) + (buf.readBigUInt64LE(o + 8) << 64n); o += 16; return v; }
        case "i128": { const lo = buf.readBigUInt64LE(o), hi = buf.readBigInt64LE(o + 8); o += 16; return lo + (hi << 64n); }
        case "publicKey": { const v = b58encode(buf.subarray(o, o + 32)); o += 32; return v; }
        case "string": { const n = buf.readUInt32LE(o); o += 4; const v = buf.subarray(o, o + n).toString("utf8"); o += n; return v; }
        default: throw new Error(`unsupported type ${ty}`);
      }
    }
    if (ty.defined) { const d = types[ty.defined]; if (!d) throw new Error(`unknown type ${ty.defined}`); return readDef(d.type); }
    if (ty.array) { const [t, n] = ty.array; return Array.from({ length: n }, () => read(t)); }
    if (ty.vec) { const n = buf.readUInt32LE(o); o += 4; return Array.from({ length: n }, () => read(ty.vec)); }
    if (ty.option) { const has = buf.readUInt8(o++); return has ? read(ty.option) : null; }
    throw new Error(`unsupported type ${JSON.stringify(ty)}`);
  };
  const readDef = (def) => {
    if (def.kind === "struct") return Object.fromEntries(def.fields.map((f) => [f.name, read(f.type)]));
    if (def.kind === "enum") { const i = buf.readUInt8(o++); const v = def.variants[i]; if (v.fields) return { [v.name]: v.fields.map((f) => read(f.type ?? f)) }; return v.name; }
    throw new Error(`unsupported kind ${def.kind}`);
  };
  return readDef(types[accountName].type);
}

/** Hourly borrow rate (fraction of position size per hour) of a custody, as the reference implementation computes it. */
export function hourlyBorrowRate(c) {
  const debt = c.debt > c.borrowLendInterestsAccured ? (c.debt - c.borrowLendInterestsAccured + BigInt(RATE_POWER) - 1n) / BigInt(RATE_POWER) : 0n;
  const owned = Number(c.assets.owned + debt), locked = Number(c.assets.locked + debt);
  if (!(owned > 0 && locked > 0)) return 0;
  const util = locked / owned;
  if (c.fundingRateState.hourlyFundingDbps !== 0n) return util * (Number(c.fundingRateState.hourlyFundingDbps) / DBPS);
  const j = c.jumpRateState, tu = Number(j.targetUtilizationRate) / RATE_POWER, min = Number(j.minRateBps) / BPS, tgt = Number(j.targetRateBps) / BPS, max = Number(j.maxRateBps) / BPS;
  const yearly = util <= tu ? min + ((tgt - min) * util) / tu : tgt + (Math.max(0, max - tgt) * Math.max(0, util - tu)) / Math.max(1e-12, 1 - tu);
  return yearly / HOURS_PER_YEAR;
}

/** Summarise the parameters the cost model needs from a decoded custody. */
export function custodyParams(c) {
  return {
    increaseBps: Number(c.increasePositionBps), decreaseBps: Number(c.decreasePositionBps),
    tradeImpactFeeScalar: Number(c.pricing.tradeImpactFeeScalar), maxLeverage: Number(c.pricing.maxLeverage) / BPS,
    hourlyBorrowRate: hourlyBorrowRate(c), utilization: Number(c.assets.locked) / Math.max(1, Number(c.assets.owned)),
    priceImpactBuffer: { feeFactor: Number(c.priceImpactBuffer.feeFactor), exponent: c.priceImpactBuffer.exponent, deltaImbalanceThresholdDecimal: Number(c.priceImpactBuffer.deltaImbalanceThresholdDecimal), maxFeeBps: Number(c.priceImpactBuffer.maxFeeBps) },
    maxPositionSizeUsd: Number(c.maxPositionSizeUsd) / 1e6, oracleMaxPriceAgeSec: c.oracle.maxPriceAgeSec,
    permissions: c.permissions, minInterestFeeBps: Number(c.minInterestFeeBps), minInterestFeeGracePeriodSeconds: Number(c.minInterestFeeGracePeriodSeconds),
  };
}

/** Fetch a read-only snapshot of the pool and BTC/ETH/SOL/USDC/USDT custodies. */
export async function fetchSnapshot({ rpc = "https://api.mainnet-beta.solana.com", fetchFn = fetch } = {}) {
  const idlText = await (await fetchFn(IDL_URL)).text(), idl = JSON.parse(idlText);
  const keys = [POOL, ...Object.values(CUSTODY)];
  const r = await (await fetchFn(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [keys, { encoding: "base64", commitment: "confirmed" }] }) })).json();
  if (r.error) throw new Error(JSON.stringify(r.error));
  const accs = r.result.value.map((v) => Buffer.from(v.data[0], "base64"));
  const pool = decodeAccount(idl, "Pool", accs[0]);
  const custodies = Object.fromEntries(Object.keys(CUSTODY).map((k, i) => { const c = decodeAccount(idl, "Custody", accs[i + 1]); return [k, custodyParams(c)]; }));
  return { fetchedAt: new Date().toISOString(), slot: r.result.context.slot, idlSha256: createHash("sha256").update(idlText).digest("hex"), rpc,
    pool: { name: pool.name, aumUsd: Number(pool.aumUsd) / 1e6, maxPositionUsd: Number(pool.limit.maxPositionUsd) / 1e6 }, custodies };
}

if (process.argv[1]?.endsWith("onchain.mjs")) {
  const s = await fetchSnapshot();
  const out = process.argv[2];
  const text = JSON.stringify(s, (k, v) => (typeof v === "bigint" ? v.toString() : v), 1);
  if (out) (await import("node:fs")).writeFileSync(out, text + "\n");
  console.log(text);
}

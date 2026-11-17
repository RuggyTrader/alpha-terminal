#!/usr/bin/env node
// Kraken order minimums snapshot (public, no key): GET https://api.kraken.com/0/public/AssetPairs
//   node src/research/r8/kraken-minimums.mjs --out <dir>/kraken-minimums.json
// Saves { fetched_at, source, markets: { BASE: { pair, minQty, minCost, lotDecimals } } } for every online */USD pair.
import { writeFileSync } from "node:fs";

/** Pure: Kraken AssetPairs result -> per-base USD minimums. Exported for tests. */
export function parseAssetPairs(result) {
  const out = {};
  for (const [pair, v] of Object.entries(result)) {
    if (pair.endsWith(".d") || !v.wsname) continue;
    const [base, quote] = v.wsname.split("/");
    if (quote !== "USD" || (v.status && v.status !== "online")) continue;
    const b = base === "XBT" ? "BTC" : base === "XDG" ? "DOGE" : base;
    out[b] = { pair, minQty: Number(v.ordermin ?? 0), minCost: Number(v.costmin ?? 0), lotDecimals: Number(v.lot_decimals ?? 8) };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--out"), out = i === -1 ? "kraken-minimums.json" : process.argv[i + 1];
  const res = await fetch("https://api.kraken.com/0/public/AssetPairs", { headers: { "User-Agent": "research-client/1.0" } });
  if (!res.ok) throw new Error(`Kraken AssetPairs ${res.status}`);
  const j = await res.json();
  if (j.error?.length) throw new Error(j.error.join(","));
  const markets = parseAssetPairs(j.result);
  writeFileSync(out, JSON.stringify({ fetched_at: new Date().toISOString(), source: "Kraken public AssetPairs", markets }, null, 1));
  console.log(`${Object.keys(markets).length} USD pairs -> ${out}`);
}

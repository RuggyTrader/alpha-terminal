// Research lab: venue cost models (research only). Every number is labelled as VERIFIED or ASSUMED.
// VERIFIED: Kraken Pro entry-tier fees from archived official pages (docs/research/costs/HISTORICAL-REPORT.md §4);
//           Ndax 0.20 % flat (archived 2019, 2023, 2024 and today).
// ASSUMED:  fee switch dates (known to within months), minimum order value, exit slippage beyond the observed spread.
const D = (s) => Date.parse(s);

export const KRAKEN_FEE_HISTORY = Object.freeze([
  { from: -Infinity, maker: 0.0016, taker: 0.0026, evidence: "archived pages 2017-09 .. 2024-03-05" },
  { from: D("2024-05-01"), maker: 0.0025, taker: 0.004, evidence: "archived pages 2024-07-07 .. 2025-10-04 (switch date assumed)" },
  { from: D("2026-01-01"), maker: 0.004, taker: 0.008, evidence: "archived 2026-03-27, 2026-07; live page 2026-11-22 (switch date assumed)" },
]);

/** Fee rates at time t. basis "current" applies today's schedule to all history (the decision-relevant view). */
export function krakenFee(t, basis = "current") {
  if (basis === "current") return { maker: 0.004, taker: 0.008 };
  let f = KRAKEN_FEE_HISTORY[0];
  for (const x of KRAKEN_FEE_HISTORY) if (t >= x.from) f = x;
  return { maker: f.maker, taker: f.taker };
}

/**
 * A venue: { name, fee(t) -> {maker, taker}, minUsd, exitSlip(asset, t) (fraction, taker exits only), notes }.
 * Exit slippage = half-spread + impact for a ~$5-50 market order. BTC/ETH USD books on Kraken were observed at
 * <= 0.003 % per side (2019-2026) but crash minutes are wider, so 0.10 % is ASSUMED; other coins 0.25 % (ASSUMED,
 * not observed). `stress` doubles slippage.
 */
export function venue(name, { basis = "current", stress = 1 } = {}) {
  const deep = new Set(["BTC", "ETH"]);
  const slip = (asset) => (deep.has(asset) ? 0.001 : asset === "SOL" ? 0.0015 : 0.0025) * stress;
  if (name === "kraken") return { name: `Kraken USD (${basis} fees)`, fee: (t) => krakenFee(t, basis), minUsd: 5, exitSlip: slip,
    notes: "fees VERIFIED; $5 minimum order value ASSUMED (Kraken resets unit minimums to about $5); slippage ASSUMED" };
  if (name === "ndax") return { name: "Ndax CAD (0.20 % flat)", fee: () => ({ maker: 0.002, taker: 0.002 }), minUsd: 1, exitSlip: (a) => slip(a) + 0.0025 * stress,
    notes: "fee VERIFIED; price path is KRAKEN's (Ndax has no free intraday history), so Ndax fills are HYPOTHETICAL; Ndax CAD books are wider (+0.25 % ASSUMED)" };
  throw new Error(`unknown venue ${name}`);
}

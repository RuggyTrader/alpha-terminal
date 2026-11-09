// User-visible disclosures about simulated execution. Keep the wording identical to the Worker
// (worker/src/costs.ts PAPER_FILL_DISCLOSURE); worker/test/disclosures.test.mjs checks both copies.

export const PAPER_FILL_DISCLOSURE =
  "PAPER fills are simulated using the Kraken reference price when the signal is processed, not necessarily the Pine strategy's original entry or exit price. Maker/taker classifications are inferred from strategy order types and are not verified against a live exchange order book.";

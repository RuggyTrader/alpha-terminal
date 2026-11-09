// Fee-compatible ROLLBACK release of the production Worker (cde07af).
//
// Purpose: a known-good Worker that can run on a database where the PAPER execution-cost release (migration 0004,
// worker/src/costs.ts on the development branch) has already recorded fees, WITHOUT charging any new fee.
//   * Reads schema 4: FEE ledger entries, wallet fees_micro, position fees/slippage, trade gross/fees/net columns.
//   * Reconciles: available + reserved = funding + realized - fees, and fees = -SUM(FEE entries).
//   * Never writes, changes, refunds or duplicates a FEE entry. New fills cost nothing (profile "none").
//   * A trade whose position paid fees before the rollback is still recorded NET of those fees, with gross beside it.
//   * Works on schema 3 too (interrupted rollout, migration not yet applied): every fee-aware query is skipped.

export const ROLLBACK_RELEASE = "worker-rollback-fee-compat (cde07af + fee compatibility)";

export const PAPER_FILL_DISCLOSURE =
  "PAPER fills are simulated using the Kraken reference price when the signal is processed, not necessarily the Pine strategy's original entry or exit price. Maker/taker classifications are inferred from strategy order types and are not verified against a live exchange order book.";

/** True once migration 0004 (schema_version >= 4) is applied. Read per request: the value can change under a running Worker. */
export async function feeSchemaReady(db: D1Database): Promise<boolean> {
  const r = await db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).first<{ value: string }>();
  return Number(r?.value ?? 0) >= 4;
}

/** Shown in Settings: costs are off for new fills on this release; earlier fees stay in the books. */
export function rollbackCosts(ready: boolean) {
  return {
    profile: "none",
    name: "Execution costs disabled (fee-compatible rollback release)",
    maker_pct: 0, taker_pct: 0, taker_slippage_pct: 0, min_qty: 0, min_notional_usd: 0,
    fee_source: "none: this rollback release charges no fees on new fills",
    slippage_source: "none",
    caveat: ready
      ? "Simulated execution costs are DISABLED for new fills on this rollback release. Fees recorded before the rollback remain in the ledger and in net P&L; they are not refunded or charged again."
      : "Simulated execution costs are DISABLED. The database has not been migrated to schema 4, so no fees exist.",
    disabled: true,
    release: ROLLBACK_RELEASE,
    fill_disclosure: PAPER_FILL_DISCLOSURE,
  };
}

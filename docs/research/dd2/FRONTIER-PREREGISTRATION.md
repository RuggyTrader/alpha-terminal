# DD2 frontier: achievable historical return at 2 / 3 / 5 / 10 / 15 % maximum drawdown (pre-registration)

**Research only.** This does not change the owner's 2 % requirement and is not a request to raise it. Written and
committed before the frontier was run.

## Protocol (identical to DD2 except the drawdown limit `C`)

Same data, periods, execution model, costs (base: 0.40 % + 0.05 %), exchange minimums, strict drawdown and the same
complete 2,912-configuration grid as `PREREGISTRATION.md`. For each `C` ∈ {2, 3, 5, 10, 15} %:

1. **Training:** eligible if drawdown < C, net > 0, ≥ 10 trades; keep the top 3 per family × universe by training net.
2. **Validation:** eligible if drawdown < C, net > 0, ≥ 5 trades. Up to five candidates by validation net (≤ 2 per
   family); **the C-winner is the top one.**
3. **Test:** evaluated for the candidates.
   * **Disclosure:** the test period was already looked at once, in DD2; this is a second look.
   * Nothing is chosen from it.

## Robustness and overfitting diagnostics (fixed now; diagnostics, not selection)

For each C-winner:

* **Consistency:** net > 0 and drawdown < C in training, validation **and** test.
* **Decay:** test CAGR ÷ training CAGR.
* **Neighbours:** among configurations that differ by one step in one setting (same family and universe), the share
  that are profitable with drawdown < C in all three periods.
* **Resampled drawdown:** P(drawdown > C), from 20,000 reshuffles of its own 2016–2026 trades (trade-level balances,
  which understate intraday drawdown).
* **Stress costs:** test net at 0.40 % + 0.15 %.

**Labels (fixed now):**

* **Robust:** consistent, decay ≥ 0.25, neighbours ≥ 50 %, P(drawdown > C) ≤ 25 %, stress-cost test net > 0.
* **Fragile:** consistent but fails at least one of the other conditions.
* **Overfitted / failed:** not consistent (loses money or breaks C in the test).

Also reported for each C: the share of all training-eligible configurations that remain consistent in validation and
test (a population-level check of how often training winners survive).

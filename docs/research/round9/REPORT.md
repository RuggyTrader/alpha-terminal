# Research round 9 report: strategy discovery tournament

**Result: no candidate passes.** Three are INCONCLUSIVE (F1, F3, F5) and two FAILED (F2, F4). Research only; nothing was traded or deployed.

## Record

| Step | Commit / file |
|---|---|
| Pre-registration (before data and runs) | `7288171` |
| Families, driver and tests (before any run) | `7fc53ef` |
| Results | `r9-results.json`; the per-file data hashes are in `provenance` |
| Kraken minimums used | `kraken-minimums-2026-11-17.json` (public AssetPairs) |
| Reproduction | a second fresh process produced a **byte-identical** results file. Every trade satisfies net = gross − fees; the driver aborts otherwise. |

**Universes:**
- **Development / validation:** BTC, ETH, SOL, LTC, LINK, XRP, ADA, AVAX.
- **Independent (15 never-used markets):** AXS, ENJ, CHZ, SUSHI, 1INCH, STORJ, ANKR, KNC, UMA, BAL, ZRX, LRC, QNT, FET, NMR.
  - SKL was excluded: not listed on Kraken in USD.
  - ENJ (June 2024), LRC, STORJ and BAL stop early on Coinbase. Each held position was closed at its last close, with costs.

**Primary run:** **$20 per market** (the real wallet size), 0.20% per fill + 0.05% slippage, long only, 2% risk per trade, Kraken minimums enforced.

## Candidates (independent = 15 untouched markets, 2022-01 → 2026-11, $ per $20 per market, pooled)

| Family (selected config) | Dev net | Val net | **Indep net** (gross / fees) | Trades | Markets + | 99% CI per trade | Stress 0.40+0.10 | **$100 run** | Executable signals at $20 | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| F1 regime Donchian (4h, 55/20) | +50.2 | +54.8 | **+26.8** (32.1 / 5.3) | 129 | 7/15 | −0.15 … +0.82 | +15.0 | **+147.3** | **8%** (129 of 1,647) | INCONCLUSIVE |
| F3 regime-adaptive (4h, ER 0.3) | +37.6 | +12.4 | **+52.5** (72.8 / 20.3) | 478 | 4/15 | −0.06 … +0.33 | +29.6 | **−88.1** | 12% | INCONCLUSIVE |
| F5 regime relative strength (1d, L30, top 3) | +22.5 | +8.5 | **+10.6** | 19 entries | portfolio | weekly −0.29% … +0.79% | +9.6 | **−34.0** | 9% | INCONCLUSIVE |
| F4 reversion after extreme bars (4h, k3) | −0.5 | −1.2 | +0.3 | 41 | 5/15 | −0.09 … +0.10 | −0.9 | −5.2 | 12% | FAILED |
| F2 vol-normalised momentum (1d) | no configuration reached 30 development trades | | | | | | | | | FAILED |

**Buy-and-hold on the independent markets** at $20 each: between −$4.05 (QNT) and −$19.90 (LRC). Total −$265.6 on $300; cash is $0.

## Gates failed

| Candidate | Failed gates |
|---|---|
| F1 | g3 breadth (7/15 < 9), g5 CI, g9 concentration (QNT +14.2, SUSHI +10.5, one trade +19.7 of +26.8), g11 feasibility |
| F3 | g3 breadth (4/15), g5 CI, g7 drawdown (worst 55%), g9 concentration (FET +50.2 of +52.5), g11 feasibility |
| F5 | g4 (19 < 30 entries), g5 CI, g9, g10 (L90 neighbour −1.1), g11 feasibility |
| F4 | nearly every gate |

## What the round shows

1. **The small-account constraint dominates.**
   - With $20 per market and 2% risk per trade, **88–92% of all entry signals were below Kraken's order minimums** and could not be placed. Most alt-coin minimums are 15–1,300 coins, roughly $5–$30, against a $0.40 risk budget.
   - The few executable trades are a **selected** subset: those with tight stops, and therefore larger positions.
2. **The positive $20 results are not reliable evidence of an edge.**
   - F3 is +$52.5 at $20 but −$88.1 at $100, where most signals are executable. Its $20 profit is a selection artifact.
   - F5 behaves the same way: +$10.6 at $20, −$34.0 at $100.
3. **F1 (regime-filtered Donchian breakout, 4h, 55/20) is the only consistent rule:**
   - positive in development, validation (6 of 8 markets) and on independent markets;
   - positive at stress costs, at $20 and at $100 (+$147 on $1,500, about +9.8% in ~5 years);
   - all three parameter neighbours positive (+26.8, +9.6, +4.3);
   - lowest fee drag (7.9% of gross profit).

   **It still fails:**
   - its result is concentrated in two markets;
   - the 99% interval includes zero;
   - only 7 of 15 markets were positive;
   - it is infeasible at $20.
4. **Mean reversion (F4) failed again,** as did round 7's R1. Costs and stops consume the small rebounds.
5. **Volatility-normalised momentum (F2) produced too few executable trades to evaluate** at $20. That is a failure under the frozen rule (fewer than 30 development trades), not evidence for or against momentum.

## Status

No candidate is ELIGIBLE FOR FURTHER VALIDATION. **No forward-trial proposal is made.** Nothing was re-run with changed settings.

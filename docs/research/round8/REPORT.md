# Research round 8 report: cross-sectional momentum rotation (X1)

**Status: FAILED.** Research only; no bot, parameter or deployment change.

## Record

- **Pre-registration:** `931cf8a`, committed before the data was downloaded and before any run.
- **Addendum A1 and the tested backtester:** `44744b2`, before any run.
- **Results:** `r8-results.json`; data hashes are in its `provenance`.

## Selection on development (BTC, ETH, SOL, LTC, LINK, AVAX, ADA, BCH, DOGE, XRP; 2021-07 → 2024-07)

| L / K | Net $ (per $100) | Entries |
|---|---|---|
| **30 / 2 (selected)** | **+136.58** | 93 |
| 30 / 3 | +123.10 | 116 |
| 90 / 2 | +43.45 | 47 |
| 90 / 3 | +14.62 | 71 |

## Out of sample

| Test | Net $ | Comparison |
|---|---|---|
| Validation (same 10 markets, 2024-07 → 2026-11) | **+15.89** | buy-and-hold −32.86 |
| **Independent** (10 never-used markets, 2022 → 2026-11) | **−96.53** | buy-and-hold −89.85 |
| Independent at 0.40% + 0.10% | −97.60 | |
| Secondary (round 7's 8 markets) | −87.97 | buy-and-hold −81.44 |

**Independent universe:** MKR, COMP, CRV, GRT, SNX, MANA, XTZ, ICP, BAT, YFI. NEAR and SAND were excluded by the pre-registered data rule (history too short).

## Gates

| # | Gate | Result |
|---|---|---|
| 1 | Development net > 0 | pass |
| 2 | Validation net > 0 | pass |
| 3 | Independent net > 0 | **fail** |
| 4 | Positive at stress costs | **fail** |
| 5 | ≥ 30 entries | pass |
| 6 | Bootstrap lower bound > 0 | **fail** (weekly mean −0.68%, 95% CI −1.95% … +0.95%) |
| 7 | Max drawdown ≤ 40% | **fail** (97%) |
| 8 | Positive in ≥ 3 of 5 years | **fail** (2022 −91.05, 2023 +7.74, 2024 +1.59, 2025 −10.79, 2026 −4.02) |
| 9 | No market > 50% of the net | **fail** (no profit at all) |

## Why it failed (checked, not a defect)

1. **The rule was ruined in 2022.**
   - In January 2022 it held that month's leaders, CRV and YFI. They fell 54% and 37% before the next weekly exit.
   - Through 2022 it kept rotating into the most recent winners, which then collapsed.
   - The portfolio was down about 85% by November 2022, and the later years could not recover it.
2. **The data was checked:**
   - no single-day move beyond ×3 or ÷3;
   - the trades shown are genuine moves.
3. **It did worse than buy-and-hold on both independent universes.**
   - The absolute-momentum cash filter came too late with a 30-day lookback and weekly decisions.

## Lesson (for the registry)

- The strong development result (+137) came from the 2021 bull market in large caps. It **did not transfer** to smaller, never-used markets.
- This confirms round 7's finding: trend gains in crypto are concentrated in a few markets and periods.
- Per the pre-registration, **no** variant, such as another lookback, a stop or a BTC regime filter, may be tried on these markets to rescue it.

# Research round 8: cross-sectional momentum rotation (PRE-REGISTRATION, 2026-11-17)

Written and committed **before** the round-8 data is downloaded and **before any round-8 run**. Every setting below is frozen.

- **Research only:** no bot, parameter or deployment change. The live PAPER bots are untouched.
- **Nothing here is a profit claim.** The best possible outcome is ELIGIBLE FOR FURTHER VALIDATION (a separate, owner-approved forward PAPER observation), never "proven".

## Why this family

Round 7's two positive single-market rules (T1 Donchian trend, M1 time-series momentum) were **INCONCLUSIVE because their gains were concentrated**. One market (XLM) supplied 85% of T1's independent result, only 4 of 8 markets were positive for M1, and drawdowns were large.

**Hypothesis.** A **portfolio** rule that each week holds only the few markets with the strongest recent trend, and holds cash when none is trending up, earns positive net returns after realistic costs. It should do so with returns that are less concentrated and drawdowns that are smaller than single-market trend rules.

This is **cross-sectional** (relative-strength) momentum. No earlier round tested it: every earlier rule traded one market at a time.

## The rule (X1), complete

- **Data:** daily candles (UTC). A decision uses completed daily bars only.
- **Rebalance:** every 7th day, counted from the first day of the evaluated period.
- **Score:** each market's L-day return, close(t) / close(t−L) − 1. A market is eligible only if both closes exist.
- **Target:** the top K markets by score **among those with score > 0** (absolute-momentum filter). Each gets a target of 1/K of portfolio equity. A slot with no eligible market is held as cash.
- **Trading:**
  - Orders fill at the **next day's open**.
  - A held market that stays in the target is **kept unchanged** (no resizing).
  - A market leaving the target is sold in full. A market entering the target is bought at 1/K of the equity at that open, capped by the available cash.
  - Orders under $0.50 notional are skipped (Kraken minimum).
- **Costs (selected):** 0.20% per fill + 0.05% slippage, applied on every buy and sell.
- **Sensitivity:** 0.40% + 0.10%, and 0.80% per fill.
- **Not used:** no stop-loss, no leverage, no shorting. The weekly exit and the cash filter are the only risk controls; drawdown is reported and gated.
- **Capital:** $100 portfolio per run.

### Grid (4 configurations)

L ∈ {30, 90} days × K ∈ {2, 3}.

## Data (Coinbase Exchange public candles, daily)

| Set | Markets | Period | Use |
|---|---|---|---|
| **Development** | BTC, ETH, SOL, LTC, LINK, AVAX, ADA, BCH, DOGE, XRP | 2021-07-01 → 2024-07-01 | choose ONE configuration |
| **Validation (time)** | the same 10 | 2024-07-01 → 2026-11-15 | out-of-sample in time |
| **Independent (never used by any round)** | NEAR, MKR, COMP, CRV, GRT, SNX, MANA, SAND, XTZ, ICP, BAT, YFI | 2022-01-01 → 2026-11-15 | **the confirmatory test** |
| Secondary (reported, not a gate) | round 7's independent 8: DOT, ATOM, UNI, AAVE, XLM, ETC, FIL, ALGO | 2022-01-01 → 2026-11-15 | used before by single-market rules only |

**Data rule (fixed now).**
- A listed independent market whose Coinbase daily history does not start on or before 2022-01-01 is **excluded and reported**.
- The list is **never extended or substituted** after the data is seen.
- If fewer than 8 independent markets remain, the round is **INCONCLUSIVE** by construction.

## Selection

The configuration with the **highest development net** among those with **≥ 30 development entries** is the single candidate.

All four configurations are reported.

## Acceptance (ALL required; selected costs unless stated)

1. Development net > 0.
2. Validation net > 0.
3. Independent net > 0.
4. Independent net > 0 at **0.40% + 0.10%**.
5. **≥ 30** independent entries.
6. **Weekly-return bootstrap:**
   - Use the independent portfolio's weekly returns, resampled with a moving-block bootstrap (block of 4 weeks, 10,000 resamples, fixed seed).
   - The **95%** lower bound of the mean weekly return must be > 0.
   - This is one pre-selected candidate, so no multiplicity correction applies.
7. **Drawdown:** independent max drawdown ≤ **40%**.
8. **Regime:** independent net positive in **≥ 3 of the 5** calendar years 2022–2026.
9. **Concentration:** no single market contributes more than **50%** of the independent net profit (sum of its realised and final open P&L).

**Also reported (not gates):**
- equal-weight buy-and-hold of the same universe, and cash;
- gross vs net and fee drag;
- turnover;
- exposure (share of time invested);
- the 0.80% scenario;
- the secondary universe.

## Interpretation

- **Pass:** ELIGIBLE FOR FURTHER VALIDATION only.
- **Fail:** FAILED, recorded in `FAILED-CANDIDATES.md` and in the registry.
- **Partly positive but failing a gate:** INCONCLUSIVE.
- **Not allowed:** changing a threshold, a market, a period or the grid after results, or re-running with new settings to rescue the result.

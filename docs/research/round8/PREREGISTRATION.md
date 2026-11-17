# Research round 8: account size, order minimums and portfolio-level trend (PRE-REGISTRATION, 2026-11-17)

Written and committed on the Mac continuation branch **before any round-8 data was downloaded or any round-8 run**.
The Mac session had no network access to the exchange data APIs when this was written, so no round-8 result could exist.
Every setting below is frozen.

- **Research only.** No bot, profile, allocation, risk setting or deployment is changed by this round.
- **Nothing here is a profit claim.** A candidate that passes becomes **ELIGIBLE FOR FURTHER VALIDATION** only. That means a
  research-only forward shadow test (`engine/src/research/forward/`), and then a separate owner decision on a PAPER trial.

## 1. Why this round

Round 7 found two INCONCLUSIVE long-only rules, T1 (Donchian 55/20, 4h) and M1 (30-day momentum, daily). Both were
positive out of sample, but one market carried most of the net (XLM was 85% of T1's net), and each market was traded in
its own $100 wallet. Two questions remain open:

1. **Account size.** Earlier work found that ~88–92% of signals could not meet Kraken's order minimums under the
   $20-per-bot, 2%-risk model. Higher-timeframe rules use wider stops, which makes this worse: the dollar risk is fixed,
   so a wider stop means a smaller position. Section 4 explains this. **Which sizing scheme can actually execute the
   signals, without raising total risk?**
2. **Concentration.** Do the round-7 leads survive as **one diversified $100 portfolio** on markets **no round has
   touched**, so that no single market has to carry the result?

## 2. Hypotheses

- **H8-1 (feasibility).** Under the production model (scenario A: $20 per bot, 2% risk), most higher-timeframe signals
  cannot be executed. A shared $100 account (B, C, D) executes ≥ 60% of them while risking no more per trade.
- **H8-2 (profitability).** At least one of three fixed, long-only rules has positive net expectancy after realistic
  costs as a shared-cash portfolio on 20 untouched markets, and the result is not concentrated in one market.

## 3. Candidates (`engine/src/research/r8/families.mjs`). No parameter grid.

| Id | Rule | Timeframe | Origin |
|---|---|---|---|
| R8-T1-240-55-20 | Close above the prior 55-bar high → enter; exit on a close below the prior 20-bar low; 2×ATR(14) initial stop | 4h (built from 1h) | round 7 T1 LONG, **frozen** |
| R8-M1-1440-30 | Every 7th bar: hold while the 30-day return is > 0; 3×ATR trailing stop | 1d | round 7 M1 LONG, **frozen** |
| R8-P3-1440-30-3 | Every 7th UTC day: rank the basket by 30-day return and hold the top 3 with a return > 0 (otherwise cash). Exit at the next open when a market leaves the selection; 3×ATR trailing stop | 1d | **new**; settings fixed a priori and never tuned |

**SHORT is not tested.** Every SHORT rule failed in round 7, and simulated shorts are not executable on the funded venue.

## 4. Account size and order minimums (H8-1)

**The constraint.** A trade can meet the minimum only when its notional reaches it:
`qty = equity × risk / stop distance`, so the **minimum equity per trade = min notional × stop % / risk %**.
Worked example: a $10 minimum, a 10% stop (normal for a daily 3×ATR) and 2% risk need **$50 of equity per trade**.
A $20 wallet cannot do it.

| Scenario | Capital | Sizing (frozen) |
|---|---|---|
| **A** production model | $20 isolated wallet **per market** | 2% of wallet equity at risk; 1 position; below the minimum → skipped |
| **B** one $100 strategy (**primary**) | $100 shared | 2% of equity at risk per trade; at most 5 positions; capped by cash; below the minimum → skipped |
| **C** fixed fraction | $100 shared | 20% of equity notional per position (the stop only drives exits); at most 5 positions |
| **D** risk budget | $100 shared | 1% risk per trade; notional ≤ 25% of equity; **total open risk ≤ 6%**. Below the minimum, the quantity may be raised to the minimum **only if** that trade's risk is ≤ 2% **and** the 6% total still holds; otherwise skipped |

**No scenario uses leverage.** Total exposure never exceeds equity. No scenario risks more than 2% on one trade.
B, C and D are hypothetical research accounts. **The real allocation is not changed.**

**Reported for every candidate × scenario:**
- entry attempts, distinct setups and executed setups. A rejected setup is re-attempted while its condition holds, so
  consecutive attempts on one market count as **one setup**. Executable % = executed setups / setups;
- rejections by reason (`BELOW_MIN_QTY`, `BELOW_MIN_COST`, `INSUFFICIENT_CASH`,
  `MAX_POSITIONS`, `RISK_BUDGET_FULL`);
- trades raised to the minimum (D);
- the median minimum equity per signal (formula above).

## 5. Data

| Item | Value |
|---|---|
| Source | Coinbase Exchange public candles (`engine/src/research/download.mjs`): 1h (4h built from 1h) and daily. Gaps are reported and never filled |
| Order minimums | Kraken public AssetPairs (`ordermin`, `costmin`, `lot_decimals`), snapshot saved with its fetch time (`r8/kraken-minimums.mjs`) |
| Period | 2021-07-01 → 2026-11-15 (the same period as rounds 3–7; **not untouched in time**, see §9) |
| **Untouched markets (confirmatory)** | GRT, CRV, SNX, COMP, BAT, ZEC, XTZ, MANA, SAND, AXS, CHZ, 1INCH, YFI, SUSHI, LRC, ICP, ENJ, STORJ, BAL, QNT. None appears anywhere in this repository's research before this commit (checked with `grep`) |
| Examined markets (secondary, reported only) | The 18 markets used by rounds 1–7. They cannot confirm anything |

**Mechanical eligibility screen** (applied before any strategy is run; exclusions recorded, **never replaced**):
1. the Coinbase USD product returns data from on or before 2021-07-01;
2. ≤ 2% of 1h candles are missing;
3. a Kraken USD pair with a published minimum exists.

If fewer than 12 markets pass, the round is reported as **UNDERPOWERED** and no candidate can pass.

## 6. Execution and costs (`engine/src/research/r8/portfolio.mjs`, tested)

**Execution:**
- Completed bars only. Decisions are taken at the close and fill at the next bar's open (one bar of latency).
- Exits first, then entries, then resting stops. Stops fill at the stop or a worse gap open.
- No limit orders, so there is no non-fill model to apply.
- Quantities are rounded down to Kraken's lot precision.
- Shared cash; no leverage.

**Costs:**
- **Selected:** 0.20% per fill (the production fee model) + 0.05% adverse slippage per market or stop fill.
- **Stress:** 0.40% per fill (Kraken's lowest-tier taker fee) + 0.10% slippage. This also covers wider spreads on the
  smaller untouched markets.
- Gross, fees and net are always reported separately.

## 7. Acceptance (H8-2): primary scenario B, untouched basket, ALL of these

1. Portfolio net > 0 at the selected costs.
2. Portfolio net > 0 at the stress costs.
3. **Significance.** Over 99.5% moving-block bootstrap intervals (3-month blocks, 4,000 resamples, fixed seed) of mean
   monthly net return, the lower bound is > 0. That is a 95% interval with a Bonferroni correction for 3 candidates,
   made stricter to match round 7.
4. ≥ 100 trades.
5. Max drawdown ≤ 30%.
6. Net positive in ≥ 3 of the 5 calendar years 2022–2026.
7. **Concentration.** No single market supplies > 40% of the summed profit of the profitable markets.
8. **Feasibility.** ≥ 60% of distinct setups executable in scenario B.

**Also reported (not gates):**
- scenarios A, C and D;
- the examined-market basket;
- benchmarks: cash ($0), an equal-weight buy-and-hold of the same basket (one entry and one exit at the selected costs),
  and BTC buy-and-hold;
- exposure, win rate and fee drag.

## 8. Interpretation rules

- **Passing:** ELIGIBLE FOR FURTHER VALIDATION. The candidate is registered for the forward shadow test with
  `start_at` = the registration time.
- **Failing:** the candidate is recorded in `FAILED-CANDIDATES.md` and the registry with every failed criterion.
- **Not allowed:**
  - changing a threshold, market, period, scenario or candidate after a result is seen;
  - re-running with new settings to rescue a candidate;
  - quoting scenario C or D as the result when B fails.
- If nothing passes, the report says so. **No "best of the rest" is promoted.**

## 9. Known limitations, stated in advance

- **Untouched markets, not untouched time.** Crypto markets are highly correlated, and the 2021–2026 regime is shared
  with rounds 3–7. A pass is weaker evidence than new time would be. That is why passing leads only to forward testing.
- **Survivorship.** The market list was chosen from pairs that are listed today. Delisted coins are missing, which
  flatters long-only results.
- **Bar-level execution.** No intrabar path, so a stop and a target in the same bar resolve stop first (no targets are
  used here).
- **Fees.** NDAX 0.20% is the production benchmark. Kraken taker fees are higher and are covered by the stress test.

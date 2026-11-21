# Strategy selection: ONE long-term strategy (PRE-REGISTRATION, 2026-11-21)

**Status:** written and committed **before** the pre-2021 data is downloaded and **before any run**. Every setting below is frozen.
- Research only, offline, on branch `research/strategy-select`.
- Nothing trades.
- Production is not touched.

## Why this design

Rounds 1–9 tested many short-horizon and single-market rules; none passed. The owner now wants **one** long-term, low-maintenance strategy.

**What the past results point to.** The only consistent signal in 9 rounds came from **slow trend rules** (round 3 MA-50 BTC, round 7 T1/M1, round 9 F1). Those rules hold for weeks and trade rarely, so fees matter little.

**What this round tests.** Four **published, precisely specified** slow rules with their **literature-default parameters**. There is no grid search; the only parameters varied are pre-listed neighbours, used for robustness only.

**What makes the test honest.** Every BTC/ETH/SOL period since 2021-06 has been seen by earlier rounds. Coinbase's free history for BTC (2015) and ETH (2016) **before 2021-06 has never been used by any round**. That period (2016-01-01 → 2021-05-31, including the 2018 bear market) is the confirmatory test.

## Candidates (all daily bars, UTC; long only; spot; no leverage)

| ID | Rule (frozen) | Source of the parameter |
|---|---|---|
| **S1 SMA trend** | Hold the asset when the daily close is above its 200-day simple moving average; otherwise cash. | Faber (2007): a 10-month average ≈ 200 trading days |
| **S2 Time-series momentum** | Every 7th day, hold if the 84-day (12-week) return is positive; otherwise cash. | Moskowitz, Ooi & Pedersen (2012); crypto momentum horizons in Liu & Tsyvinski (2021) |
| **S3 SMA trend + volatility targeting** | Weight = 1{close > SMA200} × min(1, 40% / annualised 30-day realised volatility). The position is re-sized only when the target weight changes by ≥ 0.10. | Moreira & Muir (2017); 40% ≈ half of BTC's long-run volatility |
| **S4 Turtle-style breakout** | Enter on a close above the prior 55-day high. Exit on a close below the prior 20-day low, or a close below entry − 2×ATR(20). | Turtle "System 2" (55/20), Faith (2007) |
| Baselines | Buy-and-hold; cash | — |

**Robustness neighbours** (reported, and used only by gate G5):
- S1: SMA 150 / 250;
- S2: 56 / 112 days;
- S3: vol target 30% / 50%;
- S4: 40/20 and 70/30.

## Portfolio, execution, costs

**Portfolio:**
- **$100 shared portfolio**, split equally into one sleeve per asset; each sleeve runs the rule independently.
- Untouched test: **BTC + ETH** ($50 each).
- Seen period: **BTC + ETH + SOL** ($33.33 each).

**Execution:** signals on the daily close; trades at the **next day's open**. There are no intra-day stops (S4's ATR exit is checked on the close and filled at the next open, which is conservative).

**Costs:**
- Primary: **0.20% per fill + 0.05% slippage** on traded notional (the production PAPER fee model).
- Stress: **0.40% + 0.10%**.

**Order size:** order sizes are compared with Kraken's minimums (public AssetPairs) and the share of infeasible orders is reported.

## Data

- **Source:** Coinbase Exchange public daily candles (free).
- **Untouched (confirmatory):** BTC-USD and ETH-USD, 2016-01-01 → 2021-05-31.
- **Seen (consistency only, never used for selection):** BTC, ETH and SOL, 2021-06-01 → 2026-11-15.
- **Secondary independent markets (finalist only):** LTC, BCH, ETC and XLM before 2021-06, if Coinbase history covers ≥ 2 years before 2021-06-01. Excluded markets are reported. Nothing is substituted.
- **Warm-up:** the 200 days of indicator warm-up come from data **before** each test window; for ETH that means its test starts once 200 days exist.

## Metrics (portfolio level, daily equity)

- net return and CAGR;
- **maximum drawdown**;
- Sharpe (daily, ×√365);
- profit factor (per round trip);
- number of round trips;
- exposure;
- calendar-year returns (worst year, positive years);
- fee drag;
- buy-and-hold and cash comparison.

## Gates (ALL required, on the untouched period, primary costs unless stated)

| # | Gate |
|---|---|
| G1 | Net > 0, **and** net > 0 at stress costs |
| G2 | Risk-adjusted improvement over buy-and-hold: Sharpe ≥ buy-and-hold Sharpe, **or** max drawdown ≤ 0.6 × buy-and-hold's with net > 0 |
| G3 | Positive in ≥ 3 of the 5 full calendar years 2016–2020 |
| G4 | No single calendar year provides > 70% of the total net profit |
| G5 | Every listed neighbour has net > 0 (primary costs) |
| G6 | Seen period 2021-06 → 2026-11 (BTC+ETH+SOL): net > 0 (consistency; not a selection input) |
| G7 | Weekly portfolio returns, moving-block bootstrap (block 4, 10,000 resamples, fixed seed): the lower bound of the **98.75%** two-sided interval of the mean weekly return is > 0 (Bonferroni over 4 candidates) |

## Selection

- Among the candidates passing **all** gates, choose the **highest Sharpe on the untouched period**; ties go to the lower drawdown.
- If none passes, **no strategy is selected**. The best risk-adjusted candidate is reported as an inconclusive lead only.

## The < 2% drawdown objective (reported honestly, never by changing rules)

For the selected candidate, or the best lead, the report shows:
- the exposure fraction **f = min(1, 2% / historical max drawdown)** that would have kept the drawdown under 2%;
- the resulting CAGR;
- whether orders of size f × sleeve still clear Kraken's minimums.

If they don't, the 2% objective is reported as **unrealistic at this account size after costs**.

## After selection (not part of this run)

The rules are frozen. Next comes a **forward PAPER trial** proposal (owner approval), with monitoring for deterioration and no automatic switching. Nothing is implemented in production without the owner's approval.

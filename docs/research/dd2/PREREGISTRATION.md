# Research round DD2: the most profitable realistic strategy with a maximum drawdown below 2 % on $100 (pre-registration)

Written and committed **before** any result of this round was computed. Nothing below may be changed after the runs
without being reported as a deviation.

## Question

Among long-only spot strategies on BTC, ETH and SOL, which one has the **highest net return with a maximum historical
drawdown below 2 %** on a $100 account, after realistic costs, exchange minimums and $100 sizing, and does it hold on
data not used to choose it?

## Data (free, authentic)

Coinbase Exchange public daily candles (already downloaded, SHA-256 recorded in the results file):
BTC 2015-07 → 2026-11-14, ETH 2016-05 → 2026-11-14, SOL 2021-06-17 → 2026-11-14.

**Prior exposure (honest disclosure):** every part of this history has been looked at in earlier rounds (2016–2021 in
the strategy-selection study, 2021–2026 in rounds 2–9). The test period below is untouched **by this round's
selection**, not by all earlier research.

## Periods (each starts a fresh $100; indicators warm up on earlier bars)

| Period | Dates | Use |
|---|---|---|
| Training | 2016-01-01 → 2020-12-31 | choose settings within each family |
| Validation | 2021-01-01 → 2023-06-30 | choose the five candidates and the winner |
| Test (evaluated once) | 2023-07-01 → 2026-11-14 | confirm only; never used to choose |

## Execution model (no look-ahead)

* Signals at the daily close use bars up to that close only; entries and exits are **market orders at the next open**.
* Protective / trailing stops are checked against each later bar's low (including the entry bar after the fill). A stop
  fills at the stop price, or at the open if the bar opened below it (gap, worse). If a bar could hit both a stop and a
  signal exit, the stop is assumed first.
* Long only, spot, no leverage, one position per asset, cash shared by the assets of the universe.
* **Costs (base):** Kraken Pro published starter-tier taker fee **0.40 %** per fill + **0.05 %** slippage on market
  orders and **0.10 %** on stop fills. **Stress:** 0.40 % + 0.15 % (stops 0.25 %). Also reported at the ALPHA PAPER fee
  model (0.20 % + 0.05 %) for comparison with S3.
* **Exchange rules:** Kraken minimum quantity (BTC 0.00006, ETH 0.002, SOL 0.05) at the historical price, minimum cost
  $0.50, quantity floored to 1e-8. An entry below the minimum is **skipped** (counted); a full exit always trades.
* **Drawdown (the criterion):** from the running peak of equity marked **at each bar's low** for open positions and at
  the close otherwise (stricter than close-only). Close-only drawdown is also reported.

## Strategy families and settings tested (the complete grid)

Common to T, M, R, B: initial stop `k` × ATR(14) at the signal close, `k` ∈ {1.5, 2, 3}; trailing stop (highest close −
k × ATR, never lowered) ∈ {off, on}; risk per trade `r` ∈ {0.10, 0.25, 0.50, 1.00} % of equity (quantity = r × equity /
(entry − stop)), capped at 1 / (number of assets in the universe) of equity and by cash; drawdown circuit breaker `cb` ∈
{off, 1.5 %} (a close at or below peak × (1 − cb) exits everything at the next open and blocks entries for 30 days; the
peak is never reset, so drawdown is still measured honestly).

| Family | Entry | Exit | Family settings |
|---|---|---|---|
| T trend | close crosses above SMA(n) | close below SMA(n) | n ∈ {20, 50, 100, 200} |
| M momentum | ROC(L) > θ | ROC(L) < 0 | L ∈ {14, 28, 56, 90}, θ ∈ {0, 5 %, 10 %} |
| R mean reversion | RSI(2) < x (and close > SMA(200) if filter on) | close > SMA(5), or after 5 bars | x ∈ {5, 10, 15, 25}, filter ∈ {on, off} |
| B breakout | close > highest high of the prior N bars | close < lowest low of the prior M bars | N ∈ {20, 55, 100}, M ∈ {10, 20} |
| V volatility-controlled (S3 family) | weight = 1{close > SMA(n)} × min(1, tv / σ₃₀) | same rule, band 0.10 × min(1, tv / 0.4) on the actual weight | n ∈ {100, 200}, tv ∈ {5, 10, 20, 40} %, cb ∈ {off, 1.5 %} |

Universes: **BTC only**; **BTC + ETH + SOL** (SOL from its first available day; before that BTC + ETH).

## Selection rules (fixed)

1. **Training:** eligible if drawdown < 2 %, net > $0 and ≥ 10 trades (V: ≥ 10 executed orders). Per family × universe
   keep the **3** with the highest training net profit.
2. **Validation:** eligible if drawdown < 2 %, net > $0 and ≥ 5 trades. The **five candidates** are the highest
   validation net profits, at most 2 per family. **The winner is the top validation candidate.**
3. **Test (once):** the winner is confirmed only if test drawdown < 2 % and test net > $0. If it fails, the result is
   "no strategy met the criteria out of sample"; any other candidate that passes is reported but labelled
   *test-informed*, not validated.
4. Activity: the winner must have ≥ 30 trades across the three periods, otherwise it is reported as too inactive to
   judge.

## Comparisons and stress

Every candidate is compared with S3 (frozen, 0.20 % + 0.05 % and base costs), buy-and-hold BTC + ETH, and cash, in
each period, and run separately (fresh $100) over: 2018 bear (2018-01-01 → 2018-12-31), March 2020 crash
(2020-02-15 → 2020-04-30), May 2021 crash (2021-05-01 → 2021-07-31), 2022 bear (2022-01-01 → 2022-12-31), FTX collapse
(2022-11-01 → 2022-12-31), sideways 2019-08-01 → 2020-01-31, sideways 2023-03-01 → 2023-09-30 and
sideways 2024-04-01 → 2024-09-30.

## Reproducibility

Code: `engine/src/research/dd2/`. Results: `docs/research/dd2/dd2-results.json`, regenerated byte-identically by a
second run. An independent re-implementation of the winner's rules must reproduce its figures.

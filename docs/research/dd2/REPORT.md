# DD2 report: the best realistic strategy with a maximum drawdown below 2 % on $100 (2026-11-21)

**Answer:** strategies that kept the historical drawdown below 2 % **do exist**, but only at very small position sizes,
and they make **about 1–2 % a year**. The winner, chosen by the pre-registered rules before the test, is
**BTC 56-day momentum with a trailing stop and 0.25 % risk per trade**:

* **2016–2026: $100 → $119.27** (1.6 % a year), max drawdown 1.72 %, 148 trades, $4.54 fees.
* **Untouched test, 2023-07 → 2026-11: $100 → $102.57**, max drawdown 1.52 %, 24 trades.

These are historical results, not a forecast. Resampling its own trades gives a **41 % chance** that a decade like this
breaches 2 % drawdown just by the order of the trades.

## Method (pre-registered in `PREREGISTRATION.md`, commit `371e97c`, before any run)

* **Data:** Coinbase public daily candles: BTC 2015→2026-11-14, ETH 2016→, SOL 2021-06→ (SHA-256 in `dd2-results.json`).
* **Periods** (fresh $100 each):
  * training 2016–2020;
  * validation 2021-01 → 2023-06;
  * test 2023-07 → 2026-11-14, evaluated **once**.
* **Execution:**
  * signal at the close, market order at the next open;
  * stops filled at the stop, or at the open after a gap;
  * long only, shared cash.
* **Costs:** Kraken starter taker fee 0.40 % + 0.05 % slippage (stops 0.10 %).
* **Exchange rules:** Kraken minimums at the historical price, 1e-8 lot rounding; entries below the minimum are skipped.
* **Drawdown:** strict, marked at each day's low.
* **Grid:** 1,456 settings × 2 universes = **2,912 configurations** across trend, momentum, mean-reversion, breakout and
  volatility-controlled (S3-type) families.
* **Selection:**
  * training: drawdown < 2 %, net > 0 and ≥ 10 trades; top 3 per family and universe (24 kept);
  * validation: drawdown < 2 %, net > 0 and ≥ 5 trades;
  * the five highest validation profits, at most 2 per family; **#1 is the winner**.

## The five strongest candidates (base costs; every period starts at $100)

| # | Exact rule | Training 2016–20 | Validation 2021–23H1 | **Test 2023H2–2026 (once)** | Trades (tr/val/test) | Fees (tr/val/test) |
|---|---|---|---|---|---|---|
| **1** | **BTC. Buy at next open when 56-day return > 5 %; sell at next open when it turns < 0. Stop 2 × ATR(14) below entry, trailing (highest close − 2 × ATR). Size = 0.25 % of equity ÷ stop distance** | $111.52 (+11.5 %), DD 1.72 % | $102.13 (+2.1 %), DD 1.24 % | **$102.57 (+2.6 %), DD 1.52 %** ✔ | 97 / 20 / 24 | $2.55 / $0.63 / $0.90 |
| 2 | BTC + ETH + SOL. Buy when close > highest high of prior 55 days; sell when close < lowest low of prior 10 days. Same 2 × ATR trailing stop, 0.25 % risk, ≤ ⅓ of equity per asset | $110.12, DD 1.79 % | $101.80, DD 1.25 % | $105.58, DD 1.39 % ✔ | 52 / 10 / 13 | $1.45 / $0.28 / $0.45 |
| 3 | Same as #2 with a 20-day exit low | $110.12, DD 1.79 % | $101.80, DD 1.25 % | $106.05, DD 1.39 % ✔ | 52 / 10 / 13 | $1.45 / $0.28 / $0.46 |
| 4 | BTC + ETH + SOL. 56-day momentum as #1, 1.5 × ATR trailing stop, **0.10 %** risk, ≤ ⅓ per asset | $110.30, DD 1.38 % | $101.64, DD 0.79 % | $101.93, DD 0.90 % ✔ | 210 / 27 / 14 | $2.63 / $0.45 / $0.25 |
| 5 | BTC. Buy when close crosses above SMA(20); sell when below. 2 × ATR trailing stop, 0.25 % risk | $108.98, DD 1.58 % | $101.62, DD 1.79 % | $102.66, DD 1.10 % ✔ | 88 / 28 / 27 | $2.62 / $0.81 / $1.04 |

**Notes on the table:**
* All five pass the test (drawdown < 2 %, net > 0). #2 and #3 are near-duplicates (they differ only in the exit window).
* **Run continuously over 2016–2026:**

  | # | Final balance | Max drawdown |
  |---|---|---|
  | 1 | $119.27 | 1.72 % |
  | 2 | $117.67 | 1.79 % |
  | 3 | $118.20 | 1.79 % |
  | 4 | $116.86 | 1.38 % |
  | 5 | $113.39 | **2.06 %** (just over the limit) |

## Why #1 won

* **Pre-registered ranking:** it had the highest validation profit among strategies that passed training and validation
  with drawdown < 2 %. The test was then run once and passed.
* **Most consistent:** positive in all three independent periods.
* **Most active:** 141 trades across the periods (the activity rule needs ≥ 30).
* **Costs:** it stays within the limit under stress costs (0.40 % + 0.15 %: worst drawdown 1.79 %, still profitable).
* **#2 and #3 made more in the test, but did not win:** the test is never used to choose.

## Comparison (same periods, fresh $100)

| | Training | Validation | Test |
|---|---|---|---|
| **#1 winner** | +$11.52 (DD 1.7 %) | +$2.13 (DD 1.2 %) | +$2.57 (DD 1.5 %) |
| S3 (frozen), PAPER costs 0.20 % | +$1,973 (DD 40.9 %) | +$75.06 (DD 26.2 %) | +$70.46 (DD 26.5 %) |
| S3, base costs 0.40 % | +$1,889 (DD 41.8 %) | +$71.24 (DD 27.4 %) | +$61.62 (DD 27.5 %) |
| Buy and hold BTC + ETH | +$6,162 (DD 96.8 %) | +$81.92 (DD 77.4 %) | +$49.60 (DD 58.1 %) |
| Cash (no interest) | $0 | $0 | $0 |

**What the comparison means:**
* S3 earns roughly **25–30 times more** than the winner in the test, with about **18 times** its drawdown.
* The 2 % limit costs almost all of crypto's return.
* Interest-bearing cash at typical rates of a few percent a year would likely have matched or beaten the winner, with no
  drawdown. I did not model interest.

## Stress windows (fresh $100 each; winner)

| Window | Net | Max DD | Trades |
|---|---|---|---|
| 2018 bear | −$0.89 | 1.01 % | 9 |
| March 2020 crash | −$0.50 | 0.58 % | 3 |
| May 2021 crash | +$0.12 | 0.25 % | 0 (a position held from before the window) |
| 2022 bear | −$0.60 | 1.15 % | 7 |
| FTX collapse | +$0.10 | 0.21 % | 1 |
| Sideways 2019-08 → 2020-01 | −$0.27 | 0.99 % | 5 |
| Sideways 2023-03 → 2023-09 | −$0.58 | 1.23 % | 10 |
| Sideways 2024-04 → 2024-09 | −$0.52 | 0.55 % | 2 |

**What the stress windows show:**
* Losses stay small in every bear market, crash and sideways period.
* Gains come only from sustained BTC up-trends, so expect long flat or slightly negative stretches.

## What the drawdown limit does to each family (post-hoc illustration, not selection)

Best configuration over 2016–2026 for each family:

| Family | With drawdown < 2 % | Without the limit |
|---|---|---|
| Momentum | +$19.27 | +$3,010 (DD 35 %) |
| Breakout | +$18.32 | +$1,348 (DD 84 %) |
| Trend | +$14.91 | +$1,718 (DD 83 %) |
| Mean reversion | +$0.63 | +$0.77 (DD 2.7 %); it barely works after 0.40 % fees |
| Volatility-controlled (S3 type) | **none qualifies** | — |

Why the S3 type fails the limit: at the exposure needed for < 2 % drawdown, orders fall below Kraken's minimums.

## Reliability and limits (read before deciding anything)

1. **The 2 % margin is thin and partly luck.**
   * Resampling the winner's 148 trades (20,000 reshuffles, trade-by-trade balances only) gives a median drawdown of
     1.81 %, and **2.83 % at the 90th percentile**.
   * **P(drawdown > 2 %) = 41 %, P(> 3 %) = 8.7 %.** Intraday drawdowns would be higher still.
   * The profit side is robust in the same resampling: only 0.2 % of reshuffles end below $100; the median is $119.53 and
     the 5th percentile $108.62.
2. **$100 is at the edge of what can trade.**
   * Risking 0.25 % ($0.25) with a stop 5–10 % away means positions of about $3–5, right at Kraken's BTC minimum
     (≈ $3.85 today).
   * Many signals could not be placed: 5 skipped entry attempts in training, 228 in validation and 275 in the test,
     counted once per day while the signal persisted.
   * Results are therefore sensitive to the minimum and to the account size.
3. **Data reuse.** Every year of this data was examined in earlier rounds. The test is untouched *by this round's
   selection* only.
4. **Model limits.**
   * Daily bars; long only.
   * The 0.40 % taker fee is Kraken's published starter tier: the public API returned no fee schedule, so it was not
     verified.
   * No interest on cash; no funding or withdrawal costs.

## Reproducible evidence

| Evidence | Where |
|---|---|
| Pre-registration | `371e97c` |
| Backtester + tests (7, written before the run) | `edd879b` |
| Driver | `engine/src/research/dd2/run.mjs` |
| Results | `docs/research/dd2/dd2-results.json`; a second run was **byte-identical** |
| Independent re-implementation of the winner | `engine/test/dd2-winner-independent.test.mjs`. It shares no code with the backtester and reproduces training, validation and test balances, drawdowns, fees and trade counts exactly. Run with `ALPHA_DATA=<engine/data> node --test test/dd2-winner-independent.test.mjs` |

## Bottom line

* **Historically,** the target was met: positive net profit, drawdown < 2 % in every period including the untouched test,
  141 trades.
* **The profit is about 1.6 % a year,** and a 2 % drawdown is a coin-flip-level risk going forward. Nothing here
  suggests a strategy that is both meaningfully profitable and reliably below 2 % drawdown on $100.
* **Nothing has been deployed or promoted.**

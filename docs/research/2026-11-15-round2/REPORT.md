# Profitability research, round 2: higher-timeframe strategies for a $100 account (2026-11-15)

**RESEARCH on historical candles. Nothing here is a PAPER result.** No production strategy, profile, allocation or execution rule was changed. The four original bots keep running unchanged as the PAPER baseline.

## Verdict

**No candidate meets every acceptance criterion. I recommend no production strategy change.**

1. **The protocol's own picks did not survive the untouched final test.**
   - Of the 13 settings that passed validation, 9 lost money in the final test and 1 broke even.
   - Only one reached about 30 test trades: BTC daily MA-50 LONG+SHORT.
     - **+$14.55 on 32 trades** (PF 2.02) with free simulated shorts.
     - **+$7.42** once realistic short borrowing is charged.
   - Its SHORT side lost money in both development and validation. The test profit came from a single bear market, and its 95% interval for the average trade still includes zero.
2. **The most consistent rule is BTC daily MA-50 trend, long only, with a 3×ATR stop and a 3×ATR trailing stop.**
   - It is positive in all three periods:
     - development +$21.10 (PF 2.55);
     - validation +$13.43 (PF 2.48);
     - final test +$4.12 (PF 1.57), while BTC fell 40%.
   - All four of its stop and trail variants are positive in all three periods, and the same rule is also positive in all three periods on SOL.
   - **It was not the protocol's choice:** the pre-registered robust-median pick was MA-100, which lost $3.08 in the test. I noticed MA-50's consistency only after seeing the test grid.
   - Its test sample is 19 trades, with a 95% interval for the average trade of −$0.42 to +$1.19.
   - **It is a hypothesis for a forward PAPER trial, not a validated edge.**
3. **A rule-based strategy cannot grow $100 quickly.**
   - Growth scales with the risk you accept: at 2% risk per trade the long-only rule made about 4% in 16.5 months of falling markets, and 13–21% in the earlier periods.
   - **Buy and hold beat it badly in bull markets:** BTC +152% versus +13% in validation. Its value is protection: maximum drawdown 6.5–11.5% versus 28–77% for buy and hold.

## Data (documented provenance)

| Series | Source | Coverage | Gaps / invalid |
|---|---|---|---|
| SOL-USD 1h | Coinbase Exchange public API `/products/SOL-USD/candles` | 2021-06-17 → 2026-11-14, 47,417 candles | 15 missing hours in 3 gaps (2023-03-04, 2025-10-25, 2026-05-08); 0 invalid |
| BTC-USD 1h | same | 2021-06-01 → 2026-11-14, 47,819 | 13 missing in 3 gaps (same dates); 0 invalid |
| SOL-USD / BTC-USD daily | same | 1,977 / 1,993 days | none |
| 4h | built from 1h, UTC-aligned | — | buckets with a missing hour are built from the hours present and counted; nothing fabricated |
| Kraken daily (check) | Kraken public OHLC | 720 days, 2024-11-25 → | Coinbase vs Kraken daily close: median diff 0.014% (SOL), 0.013% (BTC); p95 < 0.07% |

**Market conditions covered:**
- the 2021 bull top;
- the 2022 bear market (BTC −76%, SOL −96% drawdown);
- the 2023 recovery;
- the 2024 bull market;
- the 2025–26 decline (BTC −40%, SOL −55% in the final test);
- high- and low-volatility quarters.

**Data storage:** the data stays outside git (`engine/data/research2`). Downloader: `engine/src/research/download.mjs`.

## Method

**Periods (fixed before any result was seen):**

| Period | Dates | Use |
|---|---|---|
| Development | 2021-07 → 2023-12 | choosing settings |
| Validation | 2024-01 → 2025-06 | pass/fail gate, no re-tuning |
| **Final test** | **2025-07 → 2026-11** | **untouched; each chosen setting run exactly once** |

The round-1 out-of-sample weeks (Oct–Nov 2026) fall inside the final test period, but round 1 tested only the 1m/5m OTE strategies. None of round 2's strategy families or settings were tuned on that data.

**Selection.** A setting qualified only if it, and every one-step neighbour in its grid, was profitable in development with at least 10 trades. The **median** qualifying setting was chosen, never the best one.

**Walk-forward.** 12-month windows, every 6 months, from Jul 2021 to Jun 2025.

**Families tested:**
- **Donchian breakout** (N-bar channel, exit on the N/2 opposite channel).
- **Moving-average trend:** long while the close is above the SMA, with optional shorts.
- **EMA crossover:** 20/50 and 50/200.
- **Trend pullback:** EMA-50 above EMA-200, enter when RSI(14) recovers through 35/40/45, exit on the trend flip.
- **The original OTE strategy on 4h and daily candles.**
- **Exits for every family:** a protective stop at k×ATR (k = 2, 3), optionally with a 3×ATR trailing stop.

**Coverage:** SOL and BTC, 4h and daily, long-only and LONG+SHORT tested separately. Each grid has 8–12 settings, which is a reasonable range rather than a search.

**Execution (conservative; `engine/src/research/r2.mjs`, tested in `engine/test/research2.test.mjs`):**
- **Timing:** signals form on a completed bar's close and fill at the **next bar's open**. No lookahead.
- **Order types:** every fill is a market or stop order and pays the **taker** fee. No maker pricing is assumed.
- **Slippage:** applied to every fill.
- **Stops:** fill at the stop, or at the worse open after a gap. A stop is live from the entry bar.
- **Fees:** 0.20% and 0.40% per fill. Slippage 0.05% and 0.15%.
- **Sizing:**
  - risk 1% / 2% / 3% of the strategy's current equity divided by the stop distance (gains reinvested);
  - capped by cash, so **no leverage**;
  - Kraken minimum order sizes (SOL 0.05, BTC 0.00005, cost ≥ $0.50); an order below the minimum is skipped and counted.
- **SHORT positions:**
  - modelled as fully collateralised PAPER shorts;
  - a real short is charged a borrowing rollover of 0.01% or 0.02% per started 4 hours (Kraken-style margin).

**Drawdown:** measured on equity marked to market at every bar.

## Results of the protocol (all 32 combinations: `r2-results.json`)

**Stage-by-stage outcome:**
- Development found qualifying settings for 29 of 32 combinations (2021–2023 had powerful trends).
- **13 passed validation.**
- **In the final test, 3 of those 13 were positive with at least 10 trades.** Only 1 of the 3 had about 30 trades.

**The validation gate barely predicted the final test.**

| Validated setting | Final test net | Trades | PF |
|---|---|---|---|
| SOL 4h Donchian, long only | −20.66 | 54 | 0.68 |
| BTC 4h Donchian, long only | −7.97 | 20 | 0.63 |
| BTC 4h MA-200, long only | −9.23 | 82 | 0.85 |
| BTC 4h EMA 20/50, long only | −0.66 | 37 | 0.98 |
| BTC 4h pullback, long only | +0.02 | 8 | 1.00 |
| BTC 4h pullback, L+S | +6.87 (**−1.09** with borrowing) | 13 | 1.37 |
| SOL 1d pullback, L+S | +7.69 (+4.59 with borrowing) | 7 | 3.15 |
| BTC 1d Donchian, long only | −2.88 | 9 | 0.55 |
| BTC 1d MA-100, long only | −3.08 | 10 | 0.63 |
| **BTC 1d MA-50, L+S** | **+14.55 (+7.42 with borrowing)** | **32** | **2.02** |
| BTC 1d EMA 20/50, long only | −8.83 | 13 | 0.45 |
| BTC 1d EMA 50/200, L+S | −2.42 | 24 | 0.87 |
| BTC 1d pullback, L+S | −4.19 | 15 | 0.72 |

**Original OTE on 4h and daily** (the unchanged profiles, through the production fleet backtest): negative in development in 7 of 8 market, timeframe and mode combinations, and rejected.

## Candidate A: BTC daily MA-50 trend, LONG + SHORT (the protocol's best)

**Rules (daily candles):**
- **Entry:** at the next open, LONG after a close above the 50-day SMA, SHORT after a close below it.
- **Signal exit:** at the next open after the close crosses back.
- **Stops:** a protective stop at entry ∓ 3×ATR(14), and a trailing stop at 3×ATR from the best close.
- **Risk:** 2% of equity per trade.

| | Development | Validation | **Final test** |
|---|---|---|---|
| Net, free shorts | +23.63 (50 trades, PF 1.98) | +7.11 (39, PF 1.44) | **+14.55 (32, PF 2.02)** |
| Net, borrowing 0.02%/4h | +13.68 | +3.47 | **+7.42** |
| LONG part / SHORT part | +24.65 / **−1.03** | +12.92 / **−5.81** | +4.23 / +10.32 |

**Final test, with borrowing:**

| Measure | Value |
|---|---|
| Net | +$7.42 |
| Gross | +$16.69 |
| Fees + borrowing | $9.27 |
| Trades | 32 (17 long, 15 short) |
| Win rate | 25% |
| Profit factor | 1.48 |
| Average net per trade | +$0.23 (95% interval −$0.36 to +$1.03) |
| Maximum drawdown | 7.8% |
| Average hold | 14.7 days |
| Longest losing streak | 6 |

**Cost sensitivity** (net with borrowing, by fee / slippage per fill):

| 0.20 / 0.05% | 0.20 / 0.15% | 0.40 / 0.05% | 0.40 / 0.15% |
|---|---|---|---|
| +7.42 | +5.85 | +4.29 | +2.76 |

**Parameter sensitivity:** every neighbouring setting was positive, both in validation (+1.67, +8.70, +10.68) and in the final test (+8.38, +22.42, +14.36).

**Walk-forward:** 6 of 7 windows positive.

**Why it is not accepted:**
- The SHORT side lost money before the final test; its profit depends on one bear market.
- Real shorts require margin borrowing, which is unavailable or restricted in some jurisdictions; the alternative is derivatives with their own funding costs. The simulated collateralised PAPER short **does not prove** a real spot short is possible.
- The interval includes zero.

## Candidate B: BTC daily MA-50 trend, LONG only (most consistent; a hypothesis)

**Rules:** the same as A, with no shorts. When flat, the strategy holds cash.

| | Development | Validation | **Final test** |
|---|---|---|---|
| Net ($100, 2% risk) | +21.10 | +13.43 | **+4.12** |
| Gross / fees | 23.29 / 2.18 | 15.22 / 1.79 | 5.88 / 1.76 |
| Trades | 30 | 25 | 19 |
| Win rate | 33% | 20% | 21% |
| Profit factor | 2.55 | 2.48 | 1.57 |
| Avg net per trade (95% interval) | +0.70 (−0.29 / +2.04) | +0.54 (−0.40 / +1.67) | +0.22 (−0.42 / +1.19) |
| Max drawdown | 11.5% | 6.7% | 6.5% |
| Average hold | 14.1 days | 13.2 days | 12.6 days |
| Longest losing streak | 8 | 9 | 6 |
| Net at 0.40% fee + 0.15% slippage | +17.35 | +10.59 | +1.39 |
| Net at 1% / 3% risk | +10.45 / +31.92 | +6.73 / +20.07 | +2.13 / +5.98 |

**Parameter sensitivity** (the whole grid, all periods):
- **MA-50:** all four stop and trail variants are positive in every period. Final test: +4.92, +5.98, +2.74, +4.12.
- **MA-100 and MA-200:** positive in development and validation, slightly negative in the final test (−0.26 to −3.62).
- So the result depends on the faster average in this bear market. That is a real fragility.

**Same rule on SOL:**

| Development | Validation | Final test |
|---|---|---|
| +91.76 | +3.21 | +2.55 (22 trades, PF 1.21) |

**Regimes, all periods, by entry quarter:**

| Regime | BTC | SOL |
|---|---|---|
| Bull | +46.38 | +121.70 |
| Sideways | +2.46 | −15.20 |
| Bear | −4.85 | −14.85 |

It makes its money in trends and gives some back in chop.

**SHORT positions:** none, so no borrowing or derivatives are needed for a real implementation.

## Benchmarks (0.20% fee + 0.05% slippage on every fill)

| $100, final test 2025-07 → 2026-11 | Net | Max drawdown |
|---|---|---|
| Cash | 0.00 | 0% |
| Buy and hold BTC | −40.47 | 53.1% |
| Buy and hold SOL | −54.87 | 74.9% |
| 50/50 buy and hold | −47.67 | — |
| Simple trend: BTC above SMA-200, fully invested | −1.60 | 15.9% |
| Simple trend: SOL above SMA-200, fully invested | −2.02 | 21.0% |
| **B: BTC MA-50 long only, 2% risk** | **+4.12** | **6.5%** |
| A: BTC MA-50 L+S, with borrowing | +7.42 | 7.8% |
| Original four OTE bots, round 1 (Oct–Nov 2026 only, 4 × $20) | −40.80 in 6 weeks | — |

**Earlier periods** (buy and hold against B):

| Period | Buy and hold BTC | B |
|---|---|---|
| Development | +20% | +21 |
| Validation | +152% | +13 |

The simple fully invested SMA-200 trend made +71 and +32 in those periods.

**Risk-adjusted:** B beats buy and hold in falling markets and lags badly in rising ones. A simple fully invested trend filter captures more of a bull market, with larger drawdowns.

## $100 portfolio (final test, 2% risk unless stated)

| Allocation | Net | Max drawdown | Notes |
|---|---|---|---|
| $100 in B (BTC long only) | +4.12 | 6.5% | |
| $100 in B at 1% risk | +2.13 | 3.3% | |
| $50 BTC + $50 SOL, long only | +3.32 | 6.3% | SOL at $50 often falls below the 0.05 SOL minimum (many signals skipped) |
| $100 in A (L+S, borrowing) | +7.42 | 7.8% | needs real shorting |
| $20 per position | — | — | BTC at $20 trades less (12 vs 19 test trades); SOL at $20 almost never meets the minimum |

**Concentration and diversification:**
- Concentrating in BTC worked better than splitting, because the minimum order size penalises small SOL positions.
- Diversifying across SOL and BTC adds little: the two are highly correlated, and the losing quarters coincide.

## Fill-timing correction (prepared for review; NOT deployed)

**Branch:** `review/strict-fill-timing` (`bf395f0`). Both settings are **off by default**.

**Engine `ENGINE_STRICT_FILL=on`:**
- A new limit order is worked from the first candle that **starts after the ledger accepted it**.
- The candle that began a few seconds before acceptance can no longer establish a fill.

**Ledger `STRICT_FILL_TIMING=true`:**
- A fill's candle must open at or after **both** the order's issue time (`placed_at`) and its acceptance time (`received_at`).
- Existing records are never re-evaluated or changed.

**Safety:**
- With the settings off, behaviour and saved state are **byte-identical** to production (engine 277/277).
- Tests show the first candle can no longer fill, the one after it can, and a changed order restarts the count.

**Effect on the four original strategies** (Aug–Nov 2026, 0.20%):
- 2–4% fewer fills (1037→1008, 375→362, 891→873, 221→213).
- Net changes by −$0.01 to +$0.28; the removed fills were net losers.
- **The current rule has not been flattering the results.**

## Execution limitations

- **Data:** bar data only. Intrabar order within a bar is unknown, so stops are assumed to fill before targets.
- **Slippage on large moves:** gaps are modelled, but liquidation cascades are not.
- **Data source:** Coinbase rather than Kraken, though the two agree to 0.014% median.
- **Trade counts:** daily strategies trade rarely (about 15–25 trades per year per market), so even 5 years gives only about 100 trades per market. Statistical power is limited.
- **Real shorts:** spot shorting needs margin borrowing (rollover fees, eligibility, liquidation rules) or derivatives (funding rates). Neither is modelled beyond a fixed rollover rate.

## Recommendation and next steps (owner approval required for any of them)

1. **No production change.** The four original bots keep running unchanged as the baseline.
2. **Optionally, a forward PAPER trial of Candidate B** (BTC daily MA-50, long only, 2% risk, $20–$100 from MAIN):
   - It would be the first genuinely unseen test.
   - It needs a new bot type: daily candles, market entries at the next open, stop orders.
   - It is a hypothesis test, not a deployment of a proven strategy.
   - Expect roughly 1–2 trades a month.
3. **More data before any real-money decision:**
   - Kraken's own full trade history for exact venue prices;
   - more markets, to raise the trade count of daily rules (ETH, for example).
4. **The fill-timing correction** is ready for review and can be deployed separately.

**Files** (`docs/research/2026-11-15-round2/`): `r2-results.json`, `candidates.json`, `ma-grid.json`, `long-only.json`, `equity-curves.json`, `ote-htf.json`.

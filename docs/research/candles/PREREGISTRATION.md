# Pre-registration: historical candle pattern discovery (2026-11-26)

Committed **before any new candle data is downloaded or any result is computed**. Historical research only:
* no bot, wallet, signature or order;
* no Jupiter PAPER activation;
* the four bots, S3, P1 and the SOL OI forward collector are untouched.

## Disclosure

* **Reused data.** All 2020–2026 BTC/ETH/SOL price history has been used by earlier ALPHA TERMINAL research. Nothing here is an untouched holdout.
* **Previously tested families.** Several of these pattern families were tested before in other forms and failed: round 7 R1 4h mean reversion, round 9 F4 reversion after extreme bars, the breakout families, and the OTE wick patterns.
* **Purpose of the fixed grid.** This round asks, with one small grid fixed now, whether any of them shows a cost-surviving effect at 5m–4h. The grid is final: no other thresholds will be tried.

## Data

* **Source:** Binance USDT-M futures 5-minute klines for BTCUSDT, ETHUSDT and SOLUSDT, from 2020-01-01 (SOL: from its listing, 2020-09) to the latest available day.
* **Files:**
  * monthly files from `data.binance.vision`;
  * the 2021-12..2026-10 files already downloaded for the OI study are reused after checksum and consistency checks;
  * daily files for the current month.
* **Validation before use:**
  * 5-minute alignment;
  * no duplicate timestamps;
  * OHLC consistency (low ≤ open, close ≤ high);
  * gaps listed.
* **Longer bars:** 15m, 1h and 4h bars are built only from **complete** sets of 5-minute bars.
* Prices are Binance perpetual futures, a substitute for Jupiter's oracle prices.

## Definitions (all at the close of bar i, using only bars ≤ i)

* **Returns and volatility:** r_i = ln(c_i ÷ c_{i−1}); σ_n = the standard deviation of r over bars i−n..i−1. This excludes bar i itself, so a big bar doesn't dilute its own threshold.
* **Entry:** the open of bar i + 1.
* **Forward return over h bars:** c_{i+h} ÷ o_{i+1} − 1, **direction-normalized** by the event's trade direction.
* **Horizons:** h ∈ {1, 3, 12} bars.
* **Excursions:** the maximum adverse and favourable excursion over the h bars (from highs and lows).
* **Regime:** from completed daily bars up to day d − 1.
  * **bull:** close > SMA50 **and** SMA50 above its value 10 days earlier;
  * **bear:** close < SMA50 **and** SMA50 below its value 10 days earlier;
  * **sideways:** otherwise.

| ID | Event | Trade direction |
|---|---|---|
| E1 MR_DOWN | r_i ≤ −3 σ100 | long (reversal) |
| E2 MR_UP | r_i ≥ +3 σ100 | short (reversal) |
| E3 FB_HIGH (failed breakout) | high_i > the highest high of bars i−20..i−1, **and** c_i < that high | short |
| E4 FB_LOW | low_i < the lowest low of bars i−20..i−1, **and** c_i > that low | long |
| E5 VOL_HIGH (onset) | σ20 ÷ σ200 crosses to ≥ 2 | long; the effect is tested two-sided, and the trade direction is the sign of the effect |
| E6 VOL_LOW (onset) | σ20 ÷ σ200 crosses to ≤ 0.5 | long; two-sided as E5 |
| E7 HAMMER | range ≥ 1.5 × the median range of the previous 20 bars; lower wick ≥ 0.6 range; body ≤ 0.3 range | long |
| E8 SHOOTING_STAR | the mirror of E7 (upper wick) | short |
| E9 EXHAUST_UP | 8 consecutive closes above the previous close, with the last 3 bar ranges strictly decreasing | short |
| E10 EXHAUST_DOWN | the mirror of E9 | long |

* **Declustering:** an event of the same type is ignored within 12 bars of the previous one.
* **Controls:** 5 random bars per event, drawn from:
  * the same asset and timeframe;
  * the same regime;
  * the same σ100 decile;
  * the same UTC hour (for 4h: the same 4-hour slot);
  * not within 12 bars of an event of that type.

  Controls use the same direction normalization. **Effect** = event return − mean of its controls.
* **Inference:**
  * **Clusters:** UTC days (5m, 15m, 1h) or ISO weeks (4h).
  * **Statistics:** a cluster bootstrap 95 % CI (2,000 resamples) and a t-test on cluster means.
  * **Primary family:** 10 events × 4 timeframes × 3 assets × 3 horizons = **360 tests**, Holm, α = 0.05.
  * **Regime-conditional family:** each test within bull / bear / sideways, **1,080 tests**, with its own Holm correction.

## Initial screening: a candidate passes only if all hold

1. Holm-adjusted p < 0.05 for the effect vs controls (primary family; or the regime family for a regime-specific candidate).
2. Mean raw direction-normalized forward return > **30 bps** (baseline Jupiter round trip at $100; 15 / 60 bps reported as optimistic / conservative).
3. The same sign of the raw mean in all three periods: P1 2020-01..2021-12, P2 2022-01..2023-12, P3 2024-01..latest.
4. The same sign on at least 2 of 3 assets for the same event, timeframe and horizon.

## Backtest (only for candidates passing screening)

* **Strategy rule:**
  * entry at the next bar's open plus execution delay;
  * exit after h bars, or at a stop of k × ATR14.
* **Walk-forward stop selection:**
  * k ∈ {1.5, 2, 3}, chosen each calendar year by maximum net expectancy on **all earlier years only**;
  * the first year of each asset is used for selection only (not traded).
* **Simulation:**
  * the Jupiter cost model (`jupiter/costs.mjs`, `ledger.mjs`) with base and conservative costs;
  * one asset per experiment;
  * $100, $75 absolute shutdown (overshoot recorded), leverage 1.1× / 2× / 3× / 5×;
  * compounding of realized collateral;
  * no averaging down.
* **Extension needed for sub-hour candidates.** `ENGINE-AUDIT.md` notes that the engine is hourly, so a sub-hour candidate needs an isolated minute-clock extension, tested before use.

**If no candidate passes, no backtest is run.** The near misses are reported with the reason they failed. The ledger records every test.

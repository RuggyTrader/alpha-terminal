# S3 backtest: original vs realistic Ndax costs (Kraken official candles), 2026-11-22

**Verdict: FAIL** against the official 2 % spot drawdown limit. The maximum drawdown is **42.8–44.3 %** with every cost set.

**Scope:**
* Rules frozen (200-day SMA × 40 % volatility target, BTC + ETH halves, 0.10 rebalance band); not optimised.
* Historical data only. The S3 shadow, the bots and production were not touched.
* Runner: `engine/src/research/s3/s3-backtest.mjs`. Results: `s3-backtest-results.json`.

## Data and costs

* **Prices:** Kraken's official OHLCVT archive, daily candles (signals and next-open fills) and 5-minute candles (time-ordered drawdown). BTC from 2013, ETH from 2015-08. Archive end 2026-09-30.
* **Cost sets:**

| Cost set | Fee | Spread / slippage | Status |
|---|---|---|---|
| ORIGINAL | 0.20 % | 0.05 % | S3's configured assumption |
| NDAX MEASURED | **0.20 % (VERIFIED,** ndax.io, archived 2019–2026) | **MEASURED** C$50 cost per side: BTC 0.249 %, ETH 0.190 % (31 samples, 2026-11-22) | spread applied to all history = **ESTIMATE** |
| NDAX CONSERVATIVE | 0.20 % | max(measured Ndax, OBSERVED Kraken CAD cost at that date) | **ESTIMATE** |

* **Minimum orders:** Kraken (original) and Ndax (Ndax sets).

## Results, $100 start

| Period | Costs | Final | Net annual | Max DD (official: candle / 5-min) | Orders | Round trips | Win rate | Profit factor | Fees |
|---|---|---|---|---|---|---|---|---|---|
| 2016-07-01 → 2026-09-30 | ORIGINAL | $5,694.11 | 48.3 % | 42.95 % / 42.80 % | 381 | 67 | 26.9 % | 4.67 | $296.53 |
| | NDAX MEASURED | $5,142.74 | 46.9 % | 43.71 % / 43.55 % | 381 | 67 | 25.4 % | 4.20 | $276.08 |
| | NDAX CONSERVATIVE | $4,776.27 | 45.8 % | 44.30 % / 44.15 % | 381 | 67 | 25.4 % | 4.16 | $256.64 |
| 2018-04-01 → 2026-09-30 (Ndax era) | ORIGINAL | $975.57 | 30.7 % | 42.95 % / 42.80 % | 282 | 58 | 25.9 % | 4.37 | $49.91 |
| | NDAX MEASURED | $894.81 | 29.4 % | 43.71 % / 43.55 % | 282 | 58 | 24.1 % | 3.91 | $47.14 |
| | NDAX CONSERVATIVE | $873.00 | 29.0 % | 44.30 % / 44.15 % | 282 | 58 | 24.1 % | 3.88 | $46.00 |

**Notes on the table:**
* **Drawdown** is from the equity high-water mark, including unrealized losses and intraday highs and lows. The 5-minute column replays the same fills in time order; final equity matches exactly.
* **Round trips** count only completed position cycles (entry to full exit). Partial rebalances are counted as orders.
* **Realistic Ndax costs** reduce net return by **0.9–2.5 pp/yr** versus the original assumption, and slightly increase drawdown.

## By market condition (Ndax measured costs; return / drawdown within the period)

| Period | Market | Return | Drawdown |
|---|---|---|---|
| 2016-07 → 2017-12 | bull | +615.9 % | 20.2 % |
| 2017-12 → 2018-12 | bear | −21.7 % | 26.9 % |
| 2018-12 → 2019-08 | bull (recovery) | +49.9 % | 16.6 % |
| 2019-08 → 2020-02 | sideways | −4.8 % | 22.1 % |
| 2020-02 → 2020-05 | crash | −24.1 % | 26.7 % |
| 2020-05 → 2021-11 | bull | +310.4 % | 24.8 % |
| 2021-11 → 2022-12 | bear | −21.7 % | 21.7 % |
| 2023-03 → 2023-10 | sideways | +0.9 % | 18.3 % |
| 2023-10 → 2024-04 | bull | +106.1 % | 13.8 % |
| 2024-04 → 2024-10 | sideways | −15.1 % | 20.8 % |
| 2024-10 → 2025-10 | bull | +45.2 % | 21.2 % |
| 2025-10 → 2026-09 | decline | −9.6 % | 23.2 % |

**What this shows:** S3 makes its money in bull markets. It loses 5–24 % in bear, crash and sideways periods, and **every period's internal drawdown (13.8–26.9 %) alone exceeds the 2 % limit.**

## Limitations

* **Reused data:** S3 was selected on 2016–2021 data; all periods have been examined before. These are historical figures, not forecasts.
* **Ndax costs:** the measured spread comes from one stressed week (2026-11-22) and is applied to all history. Ndax's thin 2018–2020 market was probably costlier; the conservative set covers this only partly.
* **Prices:** Kraken USD prices are used as the price path for CAD trading. CAD/USD moves are not modelled.

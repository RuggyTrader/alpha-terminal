# Pre-registration: independent-information signal screen (round S), 2026-11-22

Written and committed after the data was downloaded and **before any statistic was computed**. Research only.

## Question

**Can information from outside the spot price itself predict BTC and ETH spot returns strongly enough to trade?** The candidate sources are:
* positioning (perpetual-futures funding);
* flows;
* stablecoin liquidity;
* regional demand;
* sentiment.

This round does **not** use price-pattern signals: no momentum, breakout, mean-reversion or volatility sizing.

## Candidate signals (each computed for decision day d, from data through the END of day d−1 only)

| # | Signal | Definition | Data (free, public) | Economic prior and evidence | Expected sign |
|---|---|---|---|---|---|
| S1 | **Funding (positioning)** | mean of the asset's Binance USDT-perpetual 8-hourly funding rates with fundingTime < d, over the last 7 days | Binance USD-M public API, from 2019-09 | Persistent positive funding = crowded leveraged longs paying carry. Such positioning is liquidation-prone, and high funding has been associated with weaker subsequent returns, as in the carry/basis literature on crypto futures. | − |
| S2 | **Exchange net inflow** | Σ (FlowInEx − FlowOutEx) over days d−7..d−1 ÷ supply on d−1 | CoinMetrics community, from 2016 | Coins sent to exchanges are more likely to be sold. **Look-ahead risk:** exchange attribution is model-based and revised after the fact ("flash" status), so it is **not point-in-time.** It is screened for information only and can **never** pass to a strategy test on this data. | − |
| S3 | **Stablecoin liquidity** | (USDT + USDC supply on d−1) ÷ (supply on d−31) − 1 | CoinMetrics community (on-chain supply, a recorded fact) | New stablecoin issuance = new dollars entering crypto ("dry powder"). | + |
| S4 | **Coinbase premium** (US demand) | mean over d−7..d−1 of Coinbase close ÷ (Binance USDT close × Kraken USDT/USD close) − 1 | Coinbase daily (in repo), Binance daily klines, Kraken official archive | Persistent US-venue buying pressure (institutional and retail USD demand). | + |
| S5 | **Fear & Greed** (sentiment) | mean of the daily index for d−7..d−1 | alternative.me, from 2018-02 | Contrarian: extreme fear precedes better returns. **Caveat:** the index is partly built from price momentum and volatility, so it is not fully independent of price. | − |

**Target:** the forward 7-day log return of the asset from the open of day d to the open of day d+7 (Kraken official daily bars). Assets: BTC and ETH.

**Samples:** non-overlapping. Decision days are every 7th day from 2016-01-04, so the forward windows never overlap.

## Periods

* **Development (screen):** each signal's first valid day → 2021-12-31.
* **Evaluation:** 2022-01-01 → 2026-09-30. It is reserved; it is not looked at for screening.
* **Reuse note:** price data for both periods was used by earlier, price-based hypotheses. These **signals** have never been used.

## Statistics

* Spearman rank correlation (IC) between the signal and the forward return.
* 99 % CI from a block bootstrap: blocks of 4 consecutive samples, 5,000 resamples, fixed seed.
* Quintile spread = mean forward return of the top signal quintile − the bottom quintile (signed by the expected direction).

## Screen pass criteria (development period only; all must hold)

1. **BTC:** the 99 % CI of the IC excludes 0, with the expected sign. 99 % rather than 95 % because 5 signals are screened.
2. **ETH:** the point estimate of the IC has the expected sign.
3. **Economic size:** the signed quintile spread on BTC is ≥ 2 % per week. A trade must clear a ~0.9 % round trip with margin.
4. **S2:** never passes (not point-in-time).

**After the screen:**
* **No signal passes:** the round reports *why* and stops before strategy backtests.
* **One or more pass:** only the strongest (largest |IC| ÷ bootstrap SE on BTC) proceeds. Its trading rule and pass/fail criteria will be pre-registered in a separate document before the evaluation period is touched. Criteria include the official 2 % drawdown, both as the conservative candle bound and as reconstructed from time-ordered 5-minute data, and comparison with Strategy B, S3 and cash.

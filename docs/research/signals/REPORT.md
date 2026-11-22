# Round S report: can independent market information predict spot returns? (2026-11-22)

**Answer: no reliable advantage was found.**
* No funding, positioning, flow, liquidity, regional-demand or sentiment signal passed the pre-registered screen.
* The three near misses were **not confirmed** on held-out 2022–2026 data.
* As pre-registered, **no trading strategy was built** on them.

Research only; nothing traded or deployed.

## 1. Candidates, rationale and data

| Signal | Economic rationale | Free history used | Point-in-time? |
|---|---|---|---|
| S1 perpetual funding (7-day mean) | crowded leveraged longs pay carry and are liquidation-prone | Binance USD-M, from 2019-09 | yes |
| S2 exchange net inflow | coins moved to exchanges are more likely to be sold | CoinMetrics community, from 2016 | **no** (attribution revised after the fact): screened only, barred from passing |
| S3 stablecoin supply growth (30 d) | new dollars entering crypto | CoinMetrics (on-chain supply), from 2016 | yes |
| S4 Coinbase premium (7-day mean) | US-venue demand | Coinbase, Binance and Kraken USDT/USD daily prices | yes |
| S5 Fear & Greed (7-day mean) | contrarian sentiment | alternative.me, from 2018-02 | yes (but partly price-derived) |

**Rejected before testing as infeasible:**
* order-book positioning and long/short ratios (no free multi-cycle history);
* point-in-time on-chain flows (paid only);
* futures-basis trading (derivatives unavailable to Canadian clients on Kraken, and previously excluded).

## 2. Stage 1: development screen, data start → 2021-12-31 (pre-registration `cdbc8fa`)

Forward 7-day BTC/ETH returns; weekly non-overlapping samples; block bootstrap.

| Signal | BTC IC (t) | BTC 99 % CI | Signed Q5−Q1 / week | ETH IC | Pass |
|---|---|---|---|---|---|
| S1 funding | −0.169 (−1.7) | [−0.41, 0.09] | +5.2 % | −0.020 | ✘ |
| S2 netflow | −0.067 (−1.2) | [−0.22, 0.08] | +1.0 % | −0.065 | ✘ (and not point-in-time) |
| S3 stablecoin growth | +0.090 (1.5) | [−0.06, 0.25] | +2.6 % | +0.172 (2.9) | ✘ |
| S4 Coinbase premium | +0.157 (2.2) | [−0.02, 0.35] | +7.0 % | +0.117 | ✘ |
| S5 Fear & Greed | +0.030 (0.4) | [−0.16, 0.22] | +0.1 % | +0.076 (wrong sign) | ✘ |

## 3. Stage 2: held-out confirmation, 2022-01 → 2026-09 (separately pre-registered before reading these data)

Bonferroni-corrected 99.67 % CI; 247 weekly samples.

| Signal | BTC IC (t) | 99.67 % CI | 95 % CI | Signed Q5−Q1 / week | ETH IC | Verdict |
|---|---|---|---|---|---|---|
| S1 funding | −0.039 (−0.6) | [−0.23, 0.14] | [−0.17, 0.08] | +0.8 % | +0.027 (wrong sign) | not confirmed |
| S3 stablecoin growth | +0.044 (0.7) | [−0.12, 0.25] | [−0.06, 0.17] | +2.1 % | +0.018 | not confirmed |
| S4 Coinbase premium | +0.055 (0.9) | [−0.13, 0.23] | [−0.07, 0.17] | +0.9 % | +0.100 (1.85) | not confirmed |

**The effects shrank by two-thirds or more out of sample.** This is consistent with relationships specific to the 2020–21 bull market, or with chance. Even if the 2022–26 point estimates were real (IC ≈ 0.05), the drawdown-efficiency bound shows they could not support meaningful profit under the official 2 % limit.

## 4. Official 2 % drawdown: conservative candle bound vs time-ordered 5-minute reconstruction

**New tool:** `lab/reconstruct.mjs`. It replays the backtester's fills through Kraken's official **5-minute** bars in time order:
* stop exits are placed in the 5-minute bar that reached the stop;
* equity is marked at every 5-minute high and low.

It is verified by 2 hand-computed tests. Final equity matches the daily backtester exactly, and every stop was located.

| Frozen strategy, 2018-04 → 2026-09 | Net/yr | Official DD, **candle bound** | Official DD, **5-min reconstructed** | Meets 2 % |
|---|---|---|---|---|
| **B**, Kraken USD market, today's fees | 0.80 % | 1.82 % | 1.82 % | ✔ (both) |
| B, Ndax-like market (0.20 % + 0.25 %, $1 minimum) | 1.53 % | 3.48 % | 3.26 % | ✘ |
| A, Kraken USD market | 1.30 % | 2.21 % | 2.21 % | ✘ |
| **S3**, Ndax-like | 29.2 % | 43.8 % | 43.7 % | ✘ |
| **Cash** | 0 % | 0 % | 0 % | ✔ |

**Kraken CAD post-only** (from the cost study, candle bound): B 0.95 %/yr, DD 1.55 % ✔.

**Notes on the reconstruction:**
* **It matters little here** (≤ 0.2 pp). The worst drawdowns of these strategies build over days, not within a single bar.
* **The candle bound remains the official screening number** because it is never lower. The 5-minute figure is reported beside it, labelled separately.

## 5. Comparison with Strategy B, S3 and cash

| | Net/yr (2018-04 → 2026-09) | Official max DD | Meets 2 % |
|---|---|---|---|
| Round-S signals | — (no strategy justified) | — | — |
| **Strategy B** (Kraken post-only) | 0.95 % | 1.55 % | ✔ |
| S3 (Ndax) | 29 % | 44 % | ✘ |
| Cash | 0 % | 0 % | ✔ |

## 6. Why no new hypothesis offers a meaningful advantage

1. **The predictive power of the independent signals is weak (|IC| ≈ 0.05) and unstable.** It did not survive held-out testing.
2. **Even a stable IC of that size would not help.** For a long-only spot strategy under a hard 2 % trailing drawdown, achievable return is bounded by roughly 2 % × (return ÷ worst single-period loss). Weak signals raise that ratio only marginally.
3. **The data that might carry real information is unavailable here:**
   * point-in-time on-chain flows and long/short positioning are paid;
   * the hedged instruments that remove the drawdown constraint (perpetuals, margin) are unavailable to Canadian clients on Kraken.

## Reused data

* All BTC/ETH/SOL prices (2016–2026) were used by earlier price-based rounds.
* The signal data (funding, flows, supply, premium, sentiment) had never been used.
* The 2022–2026 period was held out from the stage-1 screen.

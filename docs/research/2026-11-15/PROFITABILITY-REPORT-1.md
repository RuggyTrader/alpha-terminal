# Profitability research, report 1 (2026-11-15)

**RESEARCH on recorded Kraken candles.** These are not PAPER results. No production strategy was changed.

## Method

**Execution model:** identical to production (`engine/src/cli/exec-eval.mjs`).
- The OTE limit order is placed at the candle close.
- A later candle fills it by TradingView's intrabar rules: limit at its price or a better gap open; stops at the stop or a worse gap open.
- $20 wallet per bot, dollar risk reduced to fit, Kraken minimums.
- SHORTs fully collateralised.
- Fee on every fill.
- Orders expire with the setup.
- No lookahead.

**Optimism of the model:** a limit touched by a candle counts as filled, so the model is, if anything, optimistic.

**Data:** Kraken SOLUSD and BTCUSD 1m, 1 Aug – 12 Nov 2026 (about 103 days). The 5m, 15m, 30m and 60m candles are built from the 1m data.

**Split:**
- Settings are chosen on the first 60% ("development").
- The last 40% (2 Oct – 12 Nov) is untouched out-of-sample (OOS).

**Fees per fill:**
- 0.20%: the realistic floor for a small account (Ndax flat 0.20%).
- 0.40%: Kraken Pro's lowest tier for makers.
- 0%: only to measure the edge before costs.
- No maker rebate and no perfect fills are assumed.

**Slippage:** 0, with a 0.05% sensitivity run (`base_slip05`, `netrr10slip`).

**Regimes:** every week is classified trending or sideways (weekly return against its median) and high or low volatility (weekly range against its median). Results are reported at 0.20%.

**Candidates** (research-only inputs, never in a production profile):
- **Fee-aware entry filter `minNetRR` 0.5 / 1.0 / 1.5 / 2.0:** take a setup only if `target reward − entry and exit fees` ≥ `minNetRR × (stop risk + entry and exit fees + stop slippage)`.
- **Wider targets:** `tp2Ext` −1.0 and −1.618 (100% and 161.8% extensions).
- **Fewer, higher-quality setups:** `minScore 2` (at least two confluences).
- **Trend filter:** `trendEma 200`, with the trade direction required to match the EMA side.
- **Volatility filter:** `minAtrPct 0.25` (5m bots).
- **Higher timeframes:** the 5m profiles run on 15m, 30m and 60m candles.
- **Combinations** of the above.

Every number below is in dollars for a $20 bot wallet. The full per-bot data, including regimes, development, OOS, profit factor, win rate, drawdown, fees and break-even fee, is in `summary.json`.

## Results: out-of-sample (2 Oct – 12 Nov), all bots in the candidate combined

| Candidate | Bots | OOS trades | OOS net @0.20% | OOS net @0.40% | OOS fees @0.20% | Dev net @0.20% |
|---|---|---|---|---|---|---|
| **Original strategies (baseline)** | 4 | 987 | **−40.80** | −52.66 | 43.02 | −48.04 |
| Baseline + 0.05% slippage | 4 | 987 | −45.12 | −54.58 | 37.75 | −51.94 |
| minNetRR 0.5 | 4 | 406 | −20.37 | −32.43 | 22.25 | −26.34 |
| minNetRR 1.0 | 4 | 185 | −10.43 | −19.11 | 11.60 | −15.82 |
| minNetRR 1.0 + slippage | 4 | 158 | −9.36 | −17.29 | 10.18 | −14.21 |
| minNetRR 1.5 | 4 | 65 | −4.28 | −8.32 | 4.60 | −6.73 |
| minNetRR 2.0 | 4 | 22 | −1.77 | −3.39 | 1.69 | −2.60 |
| minScore 2 | 4 | 543 | −28.29 | −43.23 | 30.20 | −38.11 |
| minScore 2 + minNetRR 1.0 | 4 | 102 | −6.19 | −12.31 | 7.15 | −12.35 |
| Target 100% extension | 4 | 910 | −38.96 | −51.42 | 40.55 | −46.69 |
| Target 161.8% extension | 4 | 865 | −37.82 | −50.96 | 39.69 | −45.52 |
| 161.8% + minNetRR 1.0 | 4 | 656 | −31.73 | −47.62 | 33.93 | −39.87 |
| EMA-200 trend filter | 4 | 473 | −26.28 | −42.89 | 28.12 | −36.25 |
| EMA-200 + minNetRR 1.0 | 4 | 82 | −6.07 | −11.04 | 5.84 | −9.82 |
| ATR ≥ 0.25% (5m bots) | 2 | 34 | −1.72 | −4.08 | 2.55 | −3.03 |
| 15m (5m profiles) | 2 | 76 | −6.97 | −11.53 | 5.39 | −8.56 |
| 15m + minNetRR 1.0 | 2 | 14 | −1.53 | −2.53 | 1.07 | −1.75 |
| 30m | 2 | 41 | −3.42 | −6.21 | 3.04 | −4.10 |
| 30m + minNetRR 1.0 | 2 | 11 | −0.66 | −1.50 | 0.87 | −1.32 |
| 60m | 2 | 20 | −2.06 | −3.53 | 1.54 | −1.86 |
| 60m + minNetRR 1.0 | 2 | 14 | −1.51 | −2.55 | 1.09 | −1.26 |
| 60m + EMA-200 + minNetRR 1.0 | 2 | 8 | +0.03 | −0.60 | 0.63 | −0.76 |

## Original strategies: per bot (OOS, 0.20% per fill)

| Bot | Trades | Gross before fees | Net | Profit factor | Win rate | Avg net per trade | Max drawdown | Fees | Break-even fee per fill | Regimes positive |
|---|---|---|---|---|---|---|---|---|---|---|
| ALPHA-01 SOL 1m | 418 | −0.52 | −15.10 | 0.05 | 10% | −0.043 | 15.10 | 14.02 | none (negative even at 0%) | 0 of 3 |
| ALPHA-02 SOL 5m | 145 | +1.66 | −7.46 | 0.12 | 18% | −0.051 | 7.46 | 8.69 | 0.031% | 0 of 4 |
| ALPHA-03 BTC 1m | 339 | +0.92 | −14.23 | 0.04 | 6% | −0.042 | 14.23 | 14.51 | 0.008% | 0 of 3 |
| ALPHA-04 BTC 5m | 85 | +2.07 | −4.01 | 0.20 | 21% | −0.047 | 4.01 | 5.81 | 0.063% | 0 of 4 |

**ALPHA-01, longer evaluation** (now complete, 1 Aug – 12 Nov):
- 1,037 trades over the full period; net −$14.55 at 0.20%.
- It loses **even before fees** in the untouched period (gross −$0.52), so it has no measurable edge at all.

## Findings

1. **No candidate shows a credible profit after realistic fees.**
   - Of 70 bot and candidate combinations, three were slightly positive at 0.20% in development, each on 4–8 trades:
     - ALPHA-03 with minNetRR 2.0;
     - ALPHA-02 at 30m with minNetRR 1.0;
     - ALPHA-04 at 60m with minNetRR 1.0.
   - All three lost money out of sample.
   - Only two combinations are positive out of sample, and both are unreliable:
     - ALPHA-03 with minNetRR 1.5: 13 trades, +$0.08.
     - ALPHA-02 at 60m with EMA-200 and minNetRR 1.0: 3 trades, +$0.30.
   - Both were negative in development, both have too few trades to mean anything, and both are negative over the full period.
   - **No improvement passes the acceptance criteria. I recommend no production change.**
2. **The cause is structural, not a tuning problem.**
   - The original OTE setups risk a very small move: stops are often 0.1–0.6% of price.
   - A round trip costs 0.40% at 0.20% per fill, so fees are larger than most trades' risk and reward.
   - The gross edge before fees is only 0.01–0.06% of turnover; the break-even fee is far below anything a $100 account can get.
3. **Filters reduce losses only by trading less.**
   - The fee-aware filter cuts the out-of-sample loss from −$40.80 to −$1.77 (minNetRR 2.0), but mostly by removing trades: 987 down to 22.
   - Net expectancy per trade stays negative at every threshold.
   - The trades it keeps still have win rates around 20–45% and profit factors below 1.
4. **Wider targets do not help:** −$38 to −$39 against −$41. The extra reward is rarely reached before the stop.
5. **Higher timeframes cut the fee burden per trade but leave too few setups** (8–41 trades in six weeks) to show a positive edge. 60m is closest to break-even, but on 8 trades that is inconclusive.
6. **Trend and volatility filters lose less, but they are negative in every regime.**
   - No market regime has positive expectancy for any original bot.
   - There is no "good condition" to restrict trading to.
7. **Concentrating capital does not help.** Losses scale with position size because fees do: $100 in the least-bad bot (ALPHA-04) loses about 5 times its $20 result. Concentration only helps once a bot has positive net expectancy, and none does.
8. **Slippage makes it worse:** 0.05% on stop exits adds about $4 of loss in the out-of-sample period.

## Limitations

- **Data:** about 103 days for 1m, so the higher-timeframe samples are small. One market cycle (Aug–Nov 2026) is not every market condition.
- **Optimistic fills:** limit fills are assumed whenever a candle touches the price (no queue position or partial fills), so real results would be the same or worse.
- **Filters tested:** only filters on top of the existing OTE entry. A structurally different strategy was not tested yet.
- **Fees:** 0.20% assumes Ndax-like pricing; at Kraken's 0.40%, every candidate is worse.

## Recommended next research (no production change)

The evidence says the original OTE family cannot overcome 0.40% round-trip costs at small size. The next round should test strategies built for small accounts:
1. **Higher timeframe, wide-stop trend following** (4h / daily, stops of several percent). A 0.40% round trip becomes a small fraction of the risk. This needs longer history (1–2 years of 4h and daily Kraken candles), which can be downloaded.
2. **Holding periods of days, not minutes:** far fewer fee events per dollar of expected move.
3. **The OTE entry used as a timing tool inside a higher-timeframe trend,** with targets of 3R or more and stops at least 4× the round-trip fee, tested with the same development / out-of-sample discipline.
4. **Every candidate judged on the untouched later period** with at least 30 out-of-sample trades before it is called credible.

The four original strategies keep running unchanged in PAPER as the baseline. Their live results will appear on Results and per bot.

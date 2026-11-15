# Stage D: profitability under the exact production execution model (RESEARCH, 2026-11-15)

**These are research results on recorded Kraken candles. They are not PAPER results, and no figure here is a profit or loss in the app.**

## Execution model (identical to production; `engine/src/cli/exec-eval.mjs`)

**Order flow**
- The strategy places its OTE limit order at the candle close.
- A later completed candle fills it by TradingView's intrabar rules:
  - a limit fills at its price or a better gap open;
  - stops fill at the stop or a worse gap open;
  - targets fill at the limit.
- Pending orders expire with the setup (`maxAge`).
- No lookahead: every decision uses completed candles only.

**Ledger**
- $20 bot wallet.
- Dollar risk reduced to fit the wallet, with Kraken minimums (SOL 0.05, BTC 0.00005).
- SHORT positions fully collateralised.
- Fee charged on every fill.
- Positive profit swept to MAIN.

**Profiles:** each bot's **original** profile. No setting was changed.

**Periods:** development is the first 60% after a 2-day warm-up; out-of-sample (OOS) is the last 40%, untouched.

**Break-even fee per fill** = gross profit at 0% fee ÷ turnover, counting both fills.

**Not provable from candles:** whether an exchange limit at that price would actually have filled (queue, liquidity, partial fills). A limit touched by a candle is treated as filled, which is optimistic for the strategy.

## Results, $20 wallet: net $ after fees at each fee level per fill

| Bot | Data | Period | Trades (L/S) | 0% | 0.02% | 0.05% | 0.10% | **0.20%** | Break-even fee |
|---|---|---|---|---|---|---|---|---|---|
| ALPHA-02 SOL 5m | 12 Jun–8 Nov (150 d) | full | 575 (308/267) | +1.49 | −1.66 | −5.64 | −10.45 | **−13.56** | 0.009% |
| | | dev | 364 | +0.86 | −1.38 | −4.37 | −8.45 | −13.08 | 0.008% |
| | | OOS | 211 | +1.00 | −0.48 | −2.55 | −5.63 | −10.46 | 0.014% |
| ALPHA-03 BTC 1m | 1 Aug–11 Nov (103 d) | full | 891 (440/451) | +1.84 | −3.20 | −8.92 | −13.30 | **−15.06** | 0.007% |
| | | dev | 552 | +1.21 | −2.33 | −6.76 | −12.01 | −14.92 | 0.007% |
| | | OOS | 339 | +0.92 | −1.46 | −4.64 | −8.88 | −14.23 | 0.008% |
| ALPHA-04 BTC 5m | 1 Aug–11 Nov (103 d) | full | 221 (108/113) | +2.45 | +0.79 | −1.54 | −4.96 | **−10.16** | 0.031% |
| | | dev | 136 | +0.62 | −0.41 | −1.87 | −4.11 | −7.86 | 0.012% |
| | | OOS | 85 | +2.07 | +1.40 | +0.41 | −1.16 | −4.01 | 0.063% |
| ALPHA-01 SOL 1m | 1–11 Nov only | full | 114 | +1.27 | | | | −6.05 | 0.033% |

**ALPHA-01 note:** on the short sample only, the candle-close model was used (`small-capital-evaluation-2026-11-15.json`). Longer SOL 1m history is being downloaded; this row will be replaced when it finishes.

**Closer to 0% than to 0.20%:** the earlier candle-close fill model gives almost the same result at 0.20% (within $0.70 on every bot), so the conclusion does not depend on the fill model.

**Regimes:** weekly regime split (trend × volatility) at 0.20%. **Every bot is negative in every regime.** Before fees, the trending + high-volatility weeks are the best for ALPHA-02 and ALPHA-03.

## Achievable fees for a small account (checked 2026-11-15)

| Venue | Fee |
|---|---|
| Ndax | flat 0.20% |
| Kraken Pro, lowest tier | 0.40% maker / 0.80% taker, per Kraken's own blog (fee tiers changed in July 2026) |
| Bitbuy | about 0.10% maker is reported, but sources conflict |

**0.02–0.05% per fill is a high-volume or market-maker tier that a $100 account cannot reach.** **0.20% is the realistic floor.**

## Variants tested (RESEARCH ONLY; nothing applied)

**Method:** grid on ALPHA-02 and ALPHA-04, choosing on development, checking on OOS. Full JSON in the scratch outputs.

| Variant | ALPHA-02 dev / OOS trades | net@0.20% dev / OOS | ALPHA-04 dev / OOS trades | net@0.20% dev / OOS |
|---|---|---|---|---|
| Original | 364 / 211 | −13.08 / −10.46 | 136 / 85 | −7.86 / −4.01 |
| minScore 2 (fewer setups) | 162 / 93 | −8.59 / −5.61 | 62 / 38 | −3.62 / −2.51 |
| tp2Ext −1.0 (larger target) | 328 / 189 | −12.33 / −9.33 | 132 / 82 | −7.31 / −3.90 |
| minLegATR 10 (larger swings only) | 8 / 2 | +0.01 / −0.07 | 28 / 9 | −1.76 / −0.60 |
| minLegATR 10 + tp2Ext −1.0 | 8 / 2 | −0.32 / +0.01 | 28 / 9 | −1.56 / −0.25 |
| minLegATR 15–20 combinations | 0 | 0 | 0 | 0 |

**Findings:**
- Fewer, larger setups lose less, mainly because there are fewer fee-paying trades.
- **No variant is positive after 0.20% in both development and OOS with a meaningful number of trades.**
- The minLegATR 10 rows (2–9 OOS trades) are too few to support any conclusion.
- **No OOS-supported improvement exists**, so none is proposed.

## Small-capital growth questions

| Question | Answer |
|---|---|
| 1m frequency | The 1-minute bots trade the most and have the lowest break-even (0.007% for ALPHA-03). Their stops are a fraction of 0.4% round-trip fees. They are the least suited to 0.20% fees. |
| Larger targets | `tp2Ext −1.0` barely changes the result: about 10% fewer trades and a slightly better net. Not enough. |
| Fee-aware reward | Requiring target distance ≥ several times the round-trip fee is the direct fix. A real test would need a strategy change (a new rule, not a threshold), which needs your approval. |
| Fewer setups | `minScore 2` halves the trades and roughly halves the losses, but stays negative in OOS. |
| 5m suitability | 5m is closer to viable than 1m: ALPHA-04 OOS break-even is 0.063%, versus 0.007–0.014% for the others. It is still about 3× below 0.20%. |
| Concentration | Concentrating capital does not help: the loss scales with position size because fees do. |

## Conclusion

1. **None of the four original strategies is profitable after 0.20% per fill on 3–5 months of data, in any period or regime.**
2. The live PAPER run will measure the same thing honestly.
3. With no OOS-supported improvement, the original strategies stay unchanged.

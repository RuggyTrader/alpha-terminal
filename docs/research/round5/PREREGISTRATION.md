# Research round 5: OTE / Fibonacci on higher timeframes (PRE-REGISTRATION, 2026-11-16)

This document was written and committed **before any round-5 configuration was run**. Every setting below is frozen. Results are reported whether they help or hurt. Nothing here is a PAPER result, and nothing is deployed.

## What is already known (so nothing is called "untouched")

- **BTC, SOL and ETH (Coinbase, 2021-06 → 2026-11)** were examined in rounds 2–4, so they cannot provide independent evidence.
- **The round-4 lead** (4h OTE + daily trend + −1.618 target, SOL LONG: +15.49 on 8 development trades and +14.46 on 15 validation trades) was **found on SOL**. Re-running it on SOL is not a test of it.
- **New markets in this round:** LTC, LINK, AVAX, ADA, BCH, DOGE and XRP (Coinbase USD candles). They have not been evaluated by any strategy in this project. The **confirmatory test of every hypothesis is on these seven markets.** BTC, SOL and ETH are reported for continuity only.
- **Data rule:** a market is excluded if its candles have a gap longer than 30 days inside a period. The exclusion is reported, not hidden. XRP is expected to fail for 2021–2023 because Coinbase suspended it.

## Data and execution (same as round 4)

**Data:** Coinbase 1h candles, aggregated to 4h; Coinbase daily candles; weekly candles aggregated from daily (UTC Monday start). Filters use only candles that had **completed** by the close of the signal bar.

**Strategy code:** the production OTE / Fibonacci / PD-Array code (`ote.mjs`) with the original 5m profile inputs, unless a variation below changes one input. Moving averages and volatility are **filters only**, attached through the research gate.

**Execution model:** the production fleet backtest with strict acceptance timing:
- entries are fillable only from the bar after acceptance;
- order identity is side + limit;
- stops fill at the stop or a worse gap open.

**Costs:** 0.20% fee per fill + 0.05% slippage, selected; 0.40% per fill also reported.

**Capital:** $100 per run, 2% dollar risk, no leverage. SHORT positions are fully collateralised PAPER shorts, with an estimated borrowing cost reported.

**Minimums:** Kraken public AssetPairs, fetched 2026-11-16T03:20Z (ordermin / costmin):

| Market | ordermin | costmin |
|---|---|---|
| LTC | 0.08 | 0.5 |
| LINK | 0.35 | 0.5 |
| AVAX | 0.5 | 0.5 |
| ADA | 20 | 0.5 |
| BCH | 0.018 | 0.5 |
| DOGE | 50 | 0.5 |
| XRP | 4 | 0.5 |

**Periods:** development 2021-07-01 → 2024-07-01 and validation 2024-07-01 → 2026-11-15. Each period starts with a fresh $100.

## Hypotheses (frozen settings; LONG and SHORT run separately unless stated)

| ID | Hypothesis | Timeframe | Filter (gate) | Strategy change |
|---|---|---|---|---|
| F0 | Original OTE, no filter (reference) | 4h | none | none |
| F1 | 4h OTE with daily trend | 4h | own daily close vs own daily EMA50 | none |
| **F2** | **F1 with Fibonacci extension target** (the round-4 lead) | 4h | as F1 | `tp2Ext −1.618` |
| F2n | F2 neighbours (robustness, not separate hypotheses) | 4h | as F1 | `tp2Ext −1.0` and `−2.0` |
| F3 | Daily OTE with weekly structure | 1d | own weekly close vs own weekly EMA20 | none, and `tp2Ext −1.618` |
| F4 | OTE pullback inside the BTC MA-50 trend | 4h | BTC daily close vs BTC daily SMA50 (Candidate B's rule); LONG when above, SHORT when below | `tp2Ext −1.618` |
| F5 | Confirmed structure with PD Array confluence | 4h | as F1 | F2 + `minScore 2` |
| F6 | Volatility-adjusted stop with fee-aware minimum reward | 4h | as F1 | F2 + `slBuf 1.0` (ATR) + `minNetRR 1.5` at 0.20% cost |

**Structure caveat (F5):** the supplied Pine has no BOS/CHoCH rules. "Confirmed structure" here means the swing confirmation already built into the OTE code. PD confluence is the `minScore` count of FVG / order block / rejection block. A true BOS/CHoCH test awaits that source.

## Benchmarks (same markets and periods)

- **Cash:** $0.
- **Buy and hold:** buy at the period's first open, with costs.
- **Simple trend without OTE:** the market's own daily close vs its SMA50, long only, 3×ATR stop and trail, 2% risk. This is Candidate B's rule (H6 with both gates off, round-3 library).
- **BTC daily MA-50:** the simple trend rule on BTC (Candidate B), in the same periods.
- **Original OTE:** F0 here, and the round-4 5m results on BTC / SOL / ETH.

**Does OTE timing add value?**
- F4 LONG is compared with the simple trend rule on the same market, which shares F4's trend condition but enters without OTE timing.
- OTE adds value only if F4 beats it on validation net **and** on net / max drawdown.

## Acceptance (a hypothesis passes only if ALL hold, on the seven new markets, at 0.20%)

1. The sum of net results is positive in **both** development and validation.
2. At least 5 of the 7 new markets (or of those not excluded) are positive in validation.
3. At least 30 validation trades pooled across the new markets.
4. The pooled validation per-trade bootstrap 95% interval lies above 0.
5. Validation is still positive at 0.40% per fill.
6. **F2 only:** both neighbours (−1.0, −2.0) have a positive validation sum.
7. It beats the simple trend rule and cash on validation net / max drawdown, pooled over the new markets.

**If something passes:** propose a frozen forward PAPER trial, isolated like the BTC trend trial, for the owner to approve. Nothing is deployed.

**If nothing passes:** record every hypothesis in `FAILED-CANDIDATES.md`. The SOL 4h −1.618 result stays an unconfirmed hypothesis.

## Not allowed in this round

- Tuning any setting after seeing round-5 results.
- Adding markets after seeing results.
- Dropping a market except by the data rule above.
- Changing production strategy settings, wallets, the BTC trend trial or historical executions.

# Research round 3: pre-registration (written 2026-11-15, BEFORE any round-3 result)

**Purpose.** Find a low-turnover, long-only, automated strategy that can grow a ~$100 account after realistic costs, and that beats simple benchmarks on a risk-adjusted basis.

**Rule for every round:** a candidate that fails is recorded in `docs/research/FAILED-CANDIDATES.md` with its numbers. Results are never selectively reported.

## Data (documented provenance)

| Market | Source | Coverage | Quality |
|---|---|---|---|
| BTC-USD, ETH-USD, SOL-USD | Coinbase Exchange public candles, 1h and daily | 2021-06 → 2026-11-14 | BTC/ETH: 13 missing hours in 3 gaps; SOL: 15 in 3 gaps; daily complete; 0 invalid |
| Cross-check | Kraken public daily OHLC, last 720 days | — | median close difference 0.013–0.014%, p95 below 0.07% |
| Venue minimums | Kraken AssetPairs, 2026-11-15 | — | BTC 0.00006, ETH 0.002, SOL 0.05; cost ≥ $0.50 |

## Periods, and what is no longer "unseen"

**Already examined (cannot serve as an untouched test for BTC or SOL):**
- BTC and SOL, 2021-07 → 2026-11 (round 2 looked at every period, including its final test);
- BTC and SOL 1m/5m, Aug–Nov 2026 (round 1).

**Round-3 protocol:**

| Role | What | Use |
|---|---|---|
| Development | BTC + SOL, 2021-07 → 2024-06 | choose the rule and its plateau |
| Validation | BTC + SOL, 2024-07 → 2026-11 | gate only. It was seen in round 2, so passing it is weak evidence; failing it is disqualifying |
| **Untouched test 1** | **ETH, 2021-07 → 2026-11, run ONCE** with settings fixed on BTC + SOL | ETH data has not been used to choose any setting in any round |
| **Untouched test 2** | **forward PAPER, from activation onward** | the only genuinely future data |

## Common execution and accounting (`engine/src/research/r2.mjs`)

**Execution:**
- Decisions are made on completed daily (or weekly-sampled) closes.
- Fills happen at the **next open**: taker fee plus slippage on every fill, no maker pricing.
- Stops fill at the stop or at a worse gap open.

**Costs:** 0.20% / 0.40% per fill; slippage 0.05% / 0.15%.

**Account:**
- $100 total.
- Risk-based sizing (1% and 2%, sized against the stop), or volatility-target sizing, always capped by cash.
- No leverage, borrowing or shorts.
- Kraken minimums enforced; orders too small are skipped and counted.

**Metrics:**
- net before and after costs, trades, win rate, profit factor;
- average net per trade with a bootstrap 95% interval;
- maximum drawdown (marked to market), longest losing streak, average hold, time in cash;
- turnover, and regime results (bull / bear / sideways, high / low volatility by quarter).

## Hypotheses (each with its economic reason and a SMALL fixed grid)

### H1: Long-only time-series momentum
- **Reason:** crypto trends persist over weeks to months, and stepping aside in downtrends avoids the largest drawdowns.
- **Rule:** at each weekly close, hold the asset if its trailing L-day return is > 0, else cash. A 3×ATR protective stop.
- **Grid:** L ∈ {60, 90, 120, 180}.

### H2: Volatility-adjusted trend following
- **Reason:** sizing by realised volatility keeps risk steady across calm and turbulent periods.
- **Rule:** in a position only while close > SMA(N). Position = cash × min(1, target vol / 30-day realised vol), rebalanced weekly only if the change exceeds 20% (limits turnover).
- **Grid:** N ∈ {100, 200}; target vol ∈ {30%, 50%} annualised.

### H3: Breakout systems that hold trends
- **Reason:** a new multi-week high marks the start of a trend; a wide exit lets winners run.
- **Rule:** buy on a close above the previous N-day high. Exit on a close below the M-day low, or on a K×ATR chandelier stop from the highest close.
- **Grid:** (N, M) ∈ {(55, 20), (100, 50)}; K ∈ {3, 4, 5}.

### H4: Relative-strength selection
- **Reason:** across liquid crypto assets, the strongest trend tends to persist.
- **Rule:** at each weekly close, hold the single asset among BTC and SOL (ETH added only in test 1) with the highest L-day return, if that return is > 0, else cash.
- **Grid:** L ∈ {60, 90, 120}.

### H5: Cash versus risk-asset rotation (the simple baseline to beat)
- **Rule:** hold BTC while close > SMA(200) and SMA(200) is higher than 20 days ago, else cash. No stop, fully invested.
- **Grid:** none (a fixed classic rule).

### H6: Regime-based allocation
- **Reason:** trend strategies earn in trending, calmer markets and lose in choppy ones.
- **Rule:** run Candidate B (MA-50, long only) only while BTC is above its SMA(200) **and** 30-day realised volatility is below its trailing 1-year median; otherwise stay in cash.
- **Grid:** none beyond those two conditions.

## Acceptance criteria (unchanged from round 2, plus the benchmark rule)

A candidate needs all of the following:
- positive net P&L after 0.20% fees + 0.05% slippage, and still positive at 0.40% + 0.15%;
- profit factor above 1;
- positive in development, validation and **untouched test 1**;
- every one-step neighbour in its grid positive in development;
- at least 30 trades across the untouched tests before any approval; 30 is a first milestone, not proof;
- **it must beat both buy and hold and H5 on return ÷ maximum drawdown after costs**, in validation and in test 1. A complicated rule that does not beat H5 is rejected.

**Reporting:** uncertainty (bootstrap intervals), losing streaks, cost and slippage sensitivity, and parameter sensitivity for every promising candidate.

**Approval:** nothing is promoted to production without the owner's approval. A candidate that passes would start as an isolated forward PAPER trial, like Candidate B.

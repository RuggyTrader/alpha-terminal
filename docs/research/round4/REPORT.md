# Research round 4: hybrid OTE (report, 2026-11-16)

**RESEARCH, not PAPER results.** The data is Coinbase 5m, 15m and 1h candles for BTC, SOL and ETH, 2021-06 → 2026-11 (4h and daily candles are built from them).

**Protocol:** `PREREGISTRATION.md`, written before any run.

**Code:** branch `research/round4`, `engine/src/research/r4.mjs`. The production OTE code is unchanged; filters are attached as a research-only gate.

**Results:** `r4-results.json` (108 configurations, each run in three periods).

## How it was run

**Strategy:**
- The original OTE / Fibonacci / PD-Array strategy (`ote.mjs`), using the original 5m profiles on every timeframe.
- Moving-average and volatility rules act **only as filters**, using completed candles only.

**Execution:**
- The production fleet backtest: strategy limit fills by TradingView's intrabar rules; stops at the stop or a worse gap open.
- **Strict acceptance timing:** fillable only from the bar after acceptance. An order is identified by side + limit.
- 0.20% fee per fill (0.40% reported as `all@0.40`) and 0.05% slippage.
- $100 per run with 2% dollar risk, Kraken minimums, and no leverage.

**SHORT positions:** fully collateralised PAPER shorts. An estimated real-short borrowing cost is in the results file.

**Periods:** development 2021-07 → 2024-06 and validation 2024-07 → 2026-11, each starting with a **fresh $100**. The full period is reported for completeness.

**Harness corrections made during the round:**
1. Under strict timing, a size-only change restarted an order's acceptance every candle, so orders whose dollar-risk size changed every candle could never fill. Order identity is now side + limit. The same fix was made in the strict-fill candidate for production.
2. One wallet run straight through development and validation was starved by development losses (zero validation trades). Each period now starts with fresh capital.

## Results (net $ per $100, 0.20% fee; trades in brackets)

| Candidate | Typical development | Typical validation | Notes |
|---|---|---|---|
| **C0 original OTE, 5m** | −55 to −89 (550–785) | −78 to −89 (567–621), profit factor 0.07–0.19 | fee-dominated; loses on every market and side |
| C0 original OTE, 15m | −43 to −62 | −53 to −62, profit factor 0.19–0.37 | |
| C0 original OTE, 1h | −23 to −47 | −17 to −41 (ETH SHORT +0.91, profit factor 1.03) | |
| C0 original OTE, 4h | −16 to +0.9 | −17 to +9.8 (9–25 trades) | close to break-even; SOL LONG development +0.88 only |
| **C1 OTE 5m + H6 regime** | −46 to −76 | −44 to −79 | the regime filter does not rescue 5m OTE |
| C2 OTE 5m + 1h trend | −63 to −87 | −74 to −83 | |
| C3 OTE 15m + 4h trend | −39 to −51 | −38 to −54 | |
| C3 OTE 1h + 4h trend | −17 to −36 | −17 to −28 (ETH SHORT +3.03 on 29 trades) | |
| C4 OTE 4h + daily trend | −10 to +0.2 | −9 to +14 (5–17 trades) | best base in development, so used for C5–C7 |
| **C5 4h + wider target, −1.618** | SOL LONG **+15.49** (8) | SOL LONG **+14.46** (15, profit factor 1.89) | BTC LONG −9.3 / −6.2, ETH LONG −4.1 / −8.5; the −1.0 neighbour fails validation (−5.17) |
| C5, SHORT | BTC −8.3 (7) | BTC +18 to +23 (5 trades) | development negative; samples tiny |
| C6 volatility-adjusted stop + fee-aware reward | −10 to +2 | −12 to +11 (≤ 13 trades) | mixed; tiny samples |
| C7 stricter confluence, minScore 2 / 3 | −5 to +2 (≤ 6) | −5 to +6 (≤ 10) | far too few trades |

## Conclusions

1. **No hybrid OTE candidate meets the acceptance criteria.** Each fails at least one of:
   - positive development and validation;
   - all neighbours positive;
   - at least 30 validation trades per market;
   - beating buy and hold, the 200-day trend rule and H6.
2. **The original OTE entry on 5m–1h loses heavily after realistic fees in every market and both directions, with or without trend or regime filters.**
   - Its stops are small relative to a 0.40% round trip; this is the round-1 finding, now confirmed on 5.4 years and three markets.
   - Filters reduce the number of trades but not the cost per trade.
3. **Higher timeframes are where OTE comes close to break-even.** The 4h entry with a daily trend filter and **wider Fibonacci targets** (C5, −1.618 extension) shows the only positive development *and* validation result: SOL LONG, +15.5 and +14.5.
   - It rests on only 8 and 15 trades, on one market, and the neighbouring targets fail.
   - It is a hypothesis for the next round, not evidence of an edge.
4. **Compared with the benchmarks** (same periods, from round 3):
   - Candidate B (BTC MA-50 long only, now in forward trial) is positive on all three markets in every period.
   - H6 is positive with low exposure.
   - Buy and hold is much larger but carries 77–96% drawdowns.
   - Cash is $0.
   - Every hybrid OTE candidate is below Candidate B and H6.

## What the next OTE round should test (proposal; needs the owner's direction)

1. **4h–daily OTE with wide Fibonacci targets (−1.618 and beyond), long only, on more liquid markets** (BTC, SOL, ETH plus others with reliable data), to reach 30+ trades per test. The settings would be frozen before the run.
2. **OTE entries used only inside Candidate B's trend** (enter on OTE pullbacks while Candidate B is long, exit with Candidate B's rules), so that OTE times entries within a trend that already has positive expectancy.
3. **A forward PAPER trial only if one of these passes** on data not yet examined.

**Production impact:** none. The four original OTE bots keep running unchanged as the baseline, and the BTC trend trial is unaffected.

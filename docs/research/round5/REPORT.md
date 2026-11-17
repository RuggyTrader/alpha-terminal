# Research round 5: OTE / Fibonacci on 4h and daily (report, 2026-11-16)

**RESEARCH, not PAPER results. Nothing is deployed.**

- **Protocol:** `PREREGISTRATION.md`, committed as `bac1a9d` before any run.
- **Driver:** `engine/src/research/r5.mjs` (`8876b05`; `8c380bf` adds research-only symbol properties for the new markets).
- **Results:** `r5-results.json` (20 hypothesis × side combinations, 10 markets, 2 periods, plus benchmarks).

## Corrections disclosed

1. **Gap-check code.** The driver's first version measured gaps including a 60-day warm-up before each period, which the pre-registration does not say. It was corrected to "gaps inside the period" before any result was produced; only DOGE's inclusion changed.
2. **First run stopped early.** It stopped at the first new market (LTC: no symbol properties) after three BTC/SOL/ETH F0 lines. Research-only symbol properties (Kraken tick sizes) were added, and the whole run was repeated unchanged.
3. **Benchmark mismatch.** The pre-registration says the simple trend rule "shares F4's trend condition". It does not exactly:
   - F4 uses **BTC's** daily SMA50;
   - the simple trend benchmark uses **each market's own** SMA50 (Candidate B's rule applied per market).
   
   Both are reported. The comparison is therefore "OTE in BTC's trend" against "trend following on the market itself".
4. **Drawdown measures differ.**
   - The OTE figures use the closed-trade drawdown in dollars.
   - The benchmarks use the equity drawdown in percent of a $100 start, which includes open positions.
   - Closed-trade drawdown understates risk, so criterion 7 is generous to the OTE hypotheses.

## Data

**Markets:**
- **Seven new markets:** LTC, LINK, AVAX, ADA, BCH, DOGE, XRP (Coinbase 1h and daily candles, 2021-06 → 2026-11). These were the confirmatory test.
- **BTC, SOL, ETH:** reported for continuity only.

**Pre-registered data rule (more than 30 days missing inside a period):**
- AVAX is excluded from development (Coinbase data starts 2021-09-30).
- XRP is excluded from development (Coinbase relisted it on 2023-07-13).
- Both are included in validation.

**Kraken minimums:** public AssetPairs, fetched 2026-11-16T03:20Z.

## Results on the seven new markets (net $ per $100 per market, summed; 0.20% fee + 0.05% slippage)

| Hypothesis | Side | Development | Validation | Validation trades | Markets positive (validation) | Validation @0.40% | Validation 95% CI per trade | Pass |
|---|---|---|---|---|---|---|---|---|
| F0 original OTE 4h | LONG | +3.24 | −9.21 | 106 | 3/7 | −27.72 | [−0.49, 0.35] | no |
| F0 | SHORT | −33.91 | +6.66 | 83 | 2/7 | −7.60 | [−0.38, 0.56] | no |
| F1 4h + daily EMA50 | LONG | +5.96 | +0.56 | 52 | 3/7 | −7.60 | [−0.49, 0.61] | no |
| F1 | SHORT | −27.47 | +12.66 | 58 | 4/7 | +2.36 | [−0.42, 0.95] | no |
| **F2 F1 + −1.618 target** (round-4 lead) | LONG | **+13.17** | **+8.03** | 51 | **3/7** | +0.01 | [−0.63, 1.28] | **no** |
| F2 | SHORT | −22.03 | +10.17 | 58 | 4/7 | −0.11 | [−0.52, 1.05] | no |
| F2 neighbour −1.0 | LONG / SHORT | +10.66 / −21.36 | +3.20 / +13.10 | 51 / 58 | 3/7 / 4/7 | −4.81 / +2.80 | — | robustness only |
| F2 neighbour −2.0 | LONG / SHORT | +6.07 / −19.46 | +5.47 / +11.54 | 50 / 58 | 3/7 / 4/7 | −2.50 / +1.27 | — | robustness only |
| F3 daily OTE + weekly EMA20 | LONG | −1.93 | −5.45 | 11 | 2/7 | −6.06 | [−1.16, 0.11] | no |
| F3 | SHORT | +5.49 | −11.53 | 11 | 0/7 | −12.57 | [−1.87, −0.11] | no |
| F3 + −1.618 target | LONG / SHORT | −1.93 / +7.47 | −7.59 / −11.53 | 10 / 11 | 1/7 / 0/7 | — | — | no |
| **F4 OTE pullback in BTC MA-50 trend** | LONG | **+10.07** | **+28.08** | 64 | **3/7** | +16.18 | [−0.38, 1.39] | **no** |
| F4 | SHORT | −13.10 | +32.90 | 45 | 4/7 | +25.74 | [−0.20, 1.70] | no |
| F5 F2 + PD confluence (minScore 2) | LONG | −4.29 | −2.79 | 18 | 2/7 | −5.45 | [−0.82, 0.50] | no |
| F5 | SHORT | +8.22 | +25.21 | 21 | 2/7 | +21.39 | [−0.34, 3.31] | no |
| F6 F2 + volatility stop + fee-aware reward | LONG | +3.45 | −0.75 | 47 | 2/7 | −5.96 | [−0.65, 0.82] | no |
| F6 | SHORT | +13.85 | −0.91 | 58 | 3/7 | −8.03 | [−0.54, 0.61] | no |

**No hypothesis passes.** No hypothesis has at least 5 of 7 markets positive in validation, and every per-trade confidence interval includes zero, except F3 SHORT, whose interval is entirely negative.

### The two closest: F2 LONG and F4 LONG, per market (validation net, trades)

| Market | F2 LONG | F4 LONG | Simple trend (own SMA50) | Buy and hold |
|---|---|---|---|---|
| LTC | +13.39 (6) | +17.32 (10) | −1.93 (39) | −41.14 |
| LINK | +0.85 (7) | −0.32 (7) | +9.58 (31) | −38.03 |
| AVAX | −0.48 (8) | +2.89 (10) | −1.70 (17) | −75.89 |
| ADA | −5.95 (7) | −6.50 (9) | +11.13 (27) | −62.48 |
| BCH | −2.72 (8) | −1.77 (11) | −6.20 (42) | −49.08 |
| DOGE | +9.73 (8) | +24.48 (10) | +14.58 (22) | −54.10 |
| XRP | −6.79 (7) | −8.02 (7) | +44.67 (34) | +91.34 |
| **Sum** | **+8.03** | **+28.08** | **+70.13** | −229.38 |

- **Both pooled results come from two markets.** LTC and DOGE contribute +23.1 of F2's +8.0, and +41.8 of F4's +28.1. The other five markets are net negative.
- **The round-4 SOL lead is not confirmed.**
  - F2 LONG is still positive on SOL (+14.46, the same data as round 4).
  - On the new markets it is weak: positive in only 3 of 7, with a 95% CI of [−0.63, +1.28] per trade.
  - At 0.40% per fill it is exactly break-even (+0.01).
  - Its return / drawdown (0.27) is far below the simple trend rule's (0.86).

## Does OTE timing add value? (pre-registered comparison)

- **On validation net, no.**
  - OTE pullbacks inside BTC's trend (F4 LONG) made +28.08 on the new markets.
  - Simple trend following on each market made +70.13.
  - In development, F4 LONG made +10.07 against the trend rule's +32.23 (five markets).
- **On return / drawdown, a tie at best.** F4 LONG scored 0.87 against 0.86, and F4's drawdown measure is the more generous one.
- **F4 wins on 4 of 7 markets; trend following wins in aggregate.**

## Compared with the benchmarks

| Benchmark | Development (new markets) | Validation (new markets) | Notes |
|---|---|---|---|
| Cash | 0 | 0 | |
| Buy and hold | −224.47 (5 markets) | −229.38 | 70–89% drawdowns |
| Simple trend, own SMA50 (Candidate B's rule) | +32.23 (5 markets) | +70.13 | equity drawdown 7.9–17% |
| BTC daily MA-50 (Candidate B, BTC only) | +28.23 | +12.30 | the forward trial's rule |
| Original OTE (F0, 4h) | +3.24 / −33.91 (LONG / SHORT) | −9.21 / +6.66 | 5m results: round 4, −55 to −89 per market |

## Conclusions

1. **No OTE / Fibonacci hypothesis on 4h or daily meets the pre-registered criteria on new markets.** The failures and the SOL result are recorded in `FAILED-CANDIDATES.md`.
2. **Higher-timeframe OTE is roughly break-even after costs, not clearly profitable.**
   - 4h with a trend filter and wide targets turns the heavily losing 5m–1h picture into small pooled gains.
   - Those gains are concentrated in one or two markets per run, and none is statistically distinguishable from zero.
3. **Daily OTE with weekly structure (F3) produces too few trades (10–11 over 2.4 years on seven markets) and loses.**
4. **Simple trend following (Candidate B's rule) beats every OTE variant on the new markets.** The BTC trend forward trial remains the most credible candidate. OTE adds no demonstrated value as an entry timer within a trend.
5. **SHORT results are unstable.** Development is negative for most SHORT hypotheses while validation is positive. Validation (2024–2026) was mostly a falling market for these coins (buy and hold −229), so these are period effects, not evidence.

## Forward PAPER trial?

**Not proposed.** No candidate passed, and the pre-registration allows a trial proposal only for a candidate that passes.

**Possible next round (owner's decision):**
- a portfolio of **trend following across liquid markets** (Candidate B's rule on BTC, ETH, SOL, LINK, ADA, DOGE, XRP), with a risk budget per market. A trial of that would need its own pre-registration on data not yet examined, and owner approval.
- the BOS/CHoCH source, if supplied, would allow a true "confirmed structure" test.

**Production impact:** none. The four original OTE bots keep running unchanged as the baseline, and the BTC trend trial is unaffected.

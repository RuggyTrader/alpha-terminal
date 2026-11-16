# Research round 3: final report (2026-11-16)

**RESEARCH on Coinbase daily candles (BTC, SOL, ETH, 2021-07 → 2026-11). Nothing here is a PAPER result.**

**Protocol:** `PREREGISTRATION.md`, written before any result. The H6 study grid was committed before its first run (`r3-h6.mjs`, commit `746a777`).

## Pre-registered hypotheses (selection on BTC + SOL development only; validation gate; ETH run once)

| Hypothesis | Chosen setting (development plateau median) | Validation BTC / SOL | ETH (run once) | Verdict |
|---|---|---|---|---|
| H1 long-only momentum | 180-day | +9.93 / −5.67 | −7.36 (18 trades, PF 0.67, max drawdown 26%) | **failed** validation |
| H2 volatility-adjusted trend | SMA 100, 50% volatility target | +23.81 / −5.52 | +9.16 (52 trades, PF 1.07, max drawdown 54%); negative at 0.40% fees | **failed** |
| H3 breakout hold | 100/50-day, 5×ATR | +1.59 / −0.85 | +7.69 (6 trades) | **failed** |
| H4 relative strength | 90-day | −59.07 (BTC/SOL rotation) | +2.17 (3-asset, 47 trades, max drawdown 79%) | **failed** |
| H5 cash vs BTC (baseline) | 200-day rising | −16.37 / −57.18 | −18.82 | **failed** (a benchmark, not a candidate) |
| **H6 regime-filtered MA-50** | as registered | **+7.42 / +4.88** | **+13.70 (36 trades, PF 1.95, max drawdown 6.4%)** | passed, but see the study below |

## H6 study: sensitivity and weaknesses (`h6-study.json`)

**ETH status:** ETH was examined once in round 3, so it is **no longer untouched**. Nothing below was used to select a setting.

### 1. The predefined sensitivity grid (net $, $100, 2% risk, 0.20% + 0.05%)

All variants stay positive on BTC and ETH over the full period.
- **Moving average 30–100:** positive throughout, with a plateau at 40–60.
- **Regime average 150 / 250:** positive, but lower.
- **Volatility percentile 0.4 / 0.6, lookback 20 / 45, median window 180 / 730:** positive.
- **Stop 2–4 ATR and trailing stop 2 / 4 / off:** positive.

Weak or negative cells:

| Cell | Net |
|---|---|
| SOL, average 100 | −2.01 |
| SOL, average 150 | −4.80 |
| BTC, calendar 2025 | −0.03 to −4.04 in most variants; positive only for average 80 (+1.10) and volatility window 20 (+0.67) |
| ETH, average 80–100 | +3 to +6 only |

### 2. Filter ablation: the regime filter does not add edge

| All periods | H6 (both filters) | Volatility filter only | **No filter = Candidate B unfiltered** |
|---|---|---|---|
| BTC net / max drawdown / exposure | +17.58 / 4.5% / 18% | +23.86 / — / — | **+44.00 / 11.5% / 51%** |
| SOL | +7.44 / 5.8% / 16% | — | **+91.66 / 16.1% / 45%** |
| ETH | +13.70 / 6.4% / 17% | +15.43 | **+25.39 / 9.3% / 48%** |
| Expectancy per trade (BTC / SOL / ETH) | 0.52 / 0.23 / 0.38 | — | 0.60 / 1.33 / 0.40 |
| Return ÷ drawdown (BTC / SOL / ETH) | 3.91 / 1.28 / 2.14 | — | 3.83 / 5.69 / 2.73 |

**What the filter actually does:**
- It cuts exposure from about 48% to about 17% of the time and lowers drawdown.
- **It does not raise expectancy per trade.** It lowers it on SOL, and it lowers return ÷ drawdown on SOL and ETH.
- It works as a risk dial (as halving the risk would), not as a source of edge.

### 3. Why H6 is in cash 75–87% of the time

**Conditions:** H6 trades only while three conditions hold together:
- BTC is above its 200-day average;
- BTC volatility is below its 1-year median (about half of days by construction);
- the asset is above its 50-day average.

**Exposure:**
- **H6:** 13–25% in market.
- **Candidate B unfiltered:** 43–53%.

### 4. Missed upside in strong bull markets

Example quarters for H6:

| Quarter | Market move | H6 net | H6 exposure |
|---|---|---|---|
| SOL 2023 Q4 | +376% | +$3.46 | 11% |
| BTC 2024 Q1 | +69% | +$6.33 | 19% |
| ETH 2021 Q3 / Q4 | +32% / +23% | $0 | 0% |

**Over the full period:**
- buy and hold made +82 (BTC) and +97 (SOL), with 77–96% drawdowns;
- H6 made +17.6 and +7.4.

**Low drawdown compensates only partly:**
- **Against buy and hold:** on return ÷ drawdown, H6 beats buy and hold on BTC (3.91 vs 1.07) and ETH (2.14 vs −0.29), but loses on SOL development (0.42 vs 3.22).
- **Against an exposure-matched buy and hold** (the same average exposure, rest in cash): **unfiltered Candidate B beats it on every market** (BTC +44 vs +14.8; SOL +91.7 vs +15.5; ETH +25.4 vs −3.9). H6 beats it on BTC and ETH, not SOL.

### 5. Risk per trade and costs (H6, all periods)

| Variation | BTC net (max drawdown) | SOL | ETH |
|---|---|---|---|
| Risk 1% | +8.62 (2.3%) | +2.02 (2.9%) | +5.46 (3.2%) |
| Risk 2% | +17.58 (4.5%) | +7.44 (5.8%) | +13.70 (6.4%) |
| Risk 3% | +26.88 (6.7%) | +8.23 (8.5%) | +20.73 (9.4%) |
| No costs | +22.18 | +9.62 | +17.25 |
| 0.40% fee + 0.15% slippage | +12.29 | +4.89 | +9.58 |

**The advantage survives realistic costs:** it is low-turnover, about 7 trades a year per market.

### 6. Selection bias of the 50-day average

**The whole average grid (Candidate B unfiltered, all periods):**

| Market | MA 20 | 30 | 40 | 50 | 60 | 80 | 100 | 150 | 200 |
|---|---|---|---|---|---|---|---|---|---|
| BTC | +16.7 | +31.7 | +52.3 | +44.0 | +37.7 | +23.3 | +23.8 | +18.0 | +23.2 |
| SOL | +54.6 | +90.1 | +106.8 | +91.7 | +72.5 | +30.3 | +23.2 | +37.3 | +43.3 |
| ETH | +12.2 | +16.1 | +22.0 | +25.4 | +23.4 | +7.3 | +5.8 | +10.2 | +10.8 |

**Reading:**
- The family is positive at **every** average length on every market.
- 40–60 is a broad plateau, and 50 is inside it, not an isolated peak.
- MA-50 was chosen after round 2's grid, so some selection bias exists. The size of the plateau suggests it is moderate.

### 7. Uncertainty

**Every 95% bootstrap interval for the average trade still includes zero:**
- H6: BTC −0.09 to +1.29, ETH −0.21 to +1.05.
- Unfiltered B: similar widths.

**What this sample can and can't support:**
- Thirty-six ETH trades (and about 35 per market over 5.4 years) are **not proof** of a reliable edge.
- The low trade frequency means even 5 years gives only about 35 trades per market.

## Conclusions

1. **H6 is not recommended for a separate forward trial.** Its regime filter mainly reduces exposure; it does not improve expectancy, and the unfiltered rule does as well or better on a risk-adjusted basis on most markets.
2. **The evidence supports Candidate B itself** (the BTC daily MA-50 trend rule now in the forward trial): positive across BTC, SOL and ETH, across average lengths, across costs, and against exposure-matched buy and hold. The trial stays exactly as frozen.
3. **Growth is slow and exposure-limited.**
   - At 2% risk it made about 3–13% a year historically, with drawdowns of 10–16%.
   - Raising risk scales both return and drawdown.
   - It cannot match buy and hold in strong bull markets.
4. **Next:** the owner's direction, round 4, a hybrid OTE study (`docs/research/round4/PREREGISTRATION.md`). It uses these trend and volatility rules only as filters for OTE / Fibonacci / PD-Array entries.

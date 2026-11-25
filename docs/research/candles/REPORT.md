# Historical candle strategy discovery: report (2026-11-26)

## Bottom line

**No candle pattern passed the pre-registered screening, so no strategy was built or backtested.**
* 10 pattern types × 4 timeframes × 3 assets × 3 horizons = 360 primary tests (348 with enough events), plus 1,005 regime-conditional tests.
* **No cell** was simultaneously Holm-significant, above the 30 bps Jupiter cost bar, consistent in all three periods, and present on at least 2 of 3 assets.

**Procedure:**
* pre-registration `PREREGISTRATION.md` (28cfce0), before the data were assembled;
* engine committed before the single run (c36eacd);
* every cell is in `screen-results.json`, with the tables generated in `TABLES.md`.

Research only: no bot, wallet or order. The four bots, S3, P1 and the SOL OI collector are untouched.

## Data

* **Source:** Binance USDT-M futures 5-minute OHLCV for BTCUSDT, ETHUSDT and SOLUSDT, 2020-01-01 (SOL 2020-09-14) .. 2026-11-24.
  * 2021-12..2026-10 was reused from the OI study;
  * the rest was downloaded from `data.binance.vision`;
  * two SOL gaps in the monthly files (2022-02-26..28 and 2022-04-01..02) were filled from Binance's own daily files.
* **Validation (`VALIDATION.json`):**
  * **BTC and ETH:** 725,760 bars each (complete);
  * **SOL:** 651,660 bars;
  * **All three:** 0 misaligned, 0 duplicates, 0 bad OHLC, **0 missing bars** after the fill.
* **Longer bars:** 15m, 1h and 4h were built only from complete 5-minute groups.
* **Reused history.** All of this price history was used by earlier ALPHA TERMINAL research; **none of it is an untouched holdout.**

## What was tested

Exact definitions are in the pre-registration. All features use only bars up to the signal bar; entry is at the next bar's open.

| Family | Events |
|---|---|
| Mean reversion | E1: −3σ bar → long; E2: +3σ bar → short |
| Failed breakouts | E3: above the 20-bar high, close back inside → short; E4: the mirror → long |
| Volatility | E5: σ20 ÷ σ200 ≥ 2 onset; E6: ≤ 0.5 onset (direction tested two-sided) |
| Candle formations | E7: hammer → long; E8: shooting star → short |
| Trend exhaustion | E9: 8 rising closes with shrinking ranges → short; E10: the mirror → long |
| Conditional behaviour | every test repeated in bull / bear / sideways regimes (daily SMA50 and slope, from earlier days only) |

* **Controls:** 5 random bars per event, matched on regime, volatility decile and hour.
* **Inference:**
  * day / week clusters;
  * bootstrap CIs;
  * t-test on cluster means;
  * Holm correction within each family.

## Results

**Primary family (348 tests).** 70 Holm-significant; 37 with a mean above 30 bps in the trade direction; **0 meeting all four conditions.**

**Why the 30 bps-plus cells fail:**
* Most rest on tiny samples. The exhaustion events (E9 / E10) number 1–21 at 1h / 4h; the 4h volatility onsets 11–19.
* Or they are driven by one period, usually SOL in the 2021 bull market. For example, SOL 4h E1: +1,223 bps in P1, −149 in P2.
* None is Holm-significant.

**The Holm-significant cells mostly go AGAINST the pre-registered direction:**

| Pattern | Hypothesis | What happened |
|---|---|---|
| E2 (+3σ up bar → short) | reversal | **continuation**; for example ETH 1h, 12 bars: −50 bps for the short (Holm 2e-4); BTC 1h, 12 bars: −32 bps (Holm 0.027) |
| E3 / E4 failed breakouts | reversal | strongly negative vs controls (−22 to −116 bps), with raw returns near 0 |
| Small effects at 5m / 15m | — | 4–20 bps, far below the costs |

**Regime family (1,005 tests).** 109 Holm-significant; **0** both significant and above cost.

**Excursions.** The 10th-percentile adverse excursion over 12 bars is −110 to −2,500 bps depending on timeframe. Any stop tight enough to protect a $25 loss budget at 3–5× leverage would sit inside normal noise.

## A post-hoc observation (not a candidate)

**Large up bars continue rather than reverse.** After a +3σ 1h bar, the next 12 hours rose on average:

| Asset | Events | Mean 12 h continuation | P1 / P2 / P3 | Holm p | Worst 10 % adverse move |
|---|---|---|---|---|---|
| BTC | 513 | **+32 bps** | +46 / +31 / +24 | 0.027 | −4.9 % |
| ETH | 466 | **+50 bps** | +79 / +21 / +54 | 0.0002 | −6.0 % |
| SOL | 395 | **+63 bps** | +184 / +30 / +38 | 0.77 | −10.3 % |

The figures are consistent across every asset and period, and they are larger than matched random bars. **However:**
1. **The direction was flipped after seeing the data.** The registered hypothesis was reversal, so this is a data-driven finding, and it competes against all 360 cells for "best-looking".
2. **It is short-term momentum**, a family whose daily versions were rejected before.
3. **Net of costs it is marginal:**
   * baseline (30 bps): +2 / +20 / +33 bps;
   * conservative (60 bps): −28 / −10 / +3 bps.
4. **Adverse excursions of −5 % to −10 %** would stop or liquidate leveraged positions long before the 12-hour exit.

It qualifies only as a **new hypothesis** that needs its own pre-registration and data it was not found on.

## Jupiter cost and risk sensitivity

| Cost scenario | Round trip |
|---|---|
| Optimistic | 15 bps |
| Baseline | 30 bps |
| Conservative | 60 bps |

* **Cost components:** fees (12 bps), keeper delay, the long-collateral swap fee, and network fees at a $100 size.
* **Most effects (5m / 15m) are 4–20 bps,** so they are negative even under optimistic costs.
* **No account simulation (1.1–5×, $75 shutdown) was run.** No candidate passed, and simulating leverage on the failed cells would itself be parameter searching.
* **From the excursion data,** at 3× a −5 % adverse move costs 15 % of collateral, and at 5× it costs 25 %, which is the whole loss budget.

## Comparison with earlier ALPHA TERMINAL research

| Line | Result |
|---|---|
| **S3-25** (spot, BTC + ETH trend / volatility target) | 7.4 %/yr, drawdown 13.1 % (2018–26); +5.8 %/yr on never-used 2014–16 data. **Still the strongest validated candidate.** |
| OTE / Fibonacci (rounds 1–6) | negative out of sample, even before fees |
| Trend / momentum / breakout / rotation (rounds 2–9, futures H1 / H2, Jupiter A / B) | failed replication or drawdown limits; Jupiter A / B: 0 / 16 qualified |
| P1 Ndax gap reversion | rejected; forward PAPER study running |
| Liquidation cascades | rejected (0 / 30) |
| Volatility / OI events | not tradeable; SOL OI reversal under forward observation |
| **This round** | 0 / 348 primary and 0 / 1,005 regime cells passed |

## Remaining untested directions

1. **Out-of-sample replication of the post-hoc 1h continuation.** Pre-register it, then test on other Binance perpetuals not used at 1h (for example XRP, DOGE, ADA, LINK, AVAX) and on forward data.
2. **Cross-asset lead–lag at minute scale** (BTC → SOL/ETH). Not tested here; earlier screens suggested its edges are smaller than the costs.
3. **Implied volatility** (Deribit DVOL, public) as a regime or direction predictor. Never tested.
4. **Jupiter-native signals:**
   * the JLP pool's long/short imbalance;
   * borrow-rate jumps;
   * the gap between Jupiter's oracle and centralized-exchange prices.

   These need on-chain history collection.
5. **Order-book imbalance.** It needs continuous historical depth data, which is not free.

## Recommendation

**Do not build a candle strategy.** None of the pre-registered patterns has credible, cost-surviving evidence. The only lead worth more work is the **post-hoc 1h large-up-bar continuation**, and only as a new pre-registered replication on assets and data it was not discovered on. Even if it replicates, its net edge after conservative Jupiter costs is about zero, and its adverse excursions are large.

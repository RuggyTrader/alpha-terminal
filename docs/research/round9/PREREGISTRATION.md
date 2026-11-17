# Research round 9: strategy discovery tournament (PRE-REGISTRATION, 2026-11-17)

Part of the owner's **Strategy Discovery Mission**. This file is written and committed **before** any round-9 data is downloaded and **before any round-9 run**. Every setting below is frozen.

**Scope:**
- Research only. Nothing here trades.
- A pass makes a candidate **ELIGIBLE FOR FURTHER VALIDATION**, which means an owner-approved forward PAPER trial proposal. It is never "proven".

## 1. Baseline and evidence so far

| Source | What it showed |
|---|---|
| Rounds 1–6 | OTE / Fibonacci on 1m–1d, 21+ variants: **negative after fees everywhere**. On independent 5m markets it was negative even **before** fees. For example, round 6 baseline: gross −11.39, net −54.46, 1,206 trades. The average OTE move (≈ 0.07%) is far below the 0.50% round-trip cost. |
| Round 7 | 38 single-market configurations. Long-only Donchian trend (T1) and 30-day time-series momentum (M1) were **positive out of sample but concentrated** (INCONCLUSIVE). Mean reversion, volatility squeeze and every short rule FAILED. |
| Round 8 | Cross-sectional momentum rotation without a market-regime filter: **FAILED**, −96.5 on 10 untouched markets, with a 97% drawdown. 2022 reversals were ruinous. |

**Lesson carried into the design:**
- Only rules that hold for days or weeks have a chance against costs.
- Their weakness is bear-market whipsaw and concentration.
- Round 9 therefore tests **simple regime-filtered and volatility-normalised versions** of the only promising families, **on new data only**. It also gives mean reversion and regime switching one fair, pre-registered test each.

**Literature basis (hypotheses, not evidence):**
- Time-series momentum: Moskowitz, Ooi & Pedersen 2012.
- Cross-sectional and time-series momentum in crypto: Liu & Tsyvinski 2021; Liu, Tsyvinski & Wu 2022.
- Trend following with Donchian / turtle-style breakouts and ATR exits (Faith 2007).
- Volatility scaling: Moreira & Muir 2017.
- Short-horizon reversal after extreme moves.

Published results are **not** used as evidence. Only this round's untouched-data results count.

## 2. Account and execution constraints (verified 2026-11-17, read-only)

**Capital:**
- Authoritative book total: **$99.35**, in five wallets of about $19.8–$20.0 each.
- A new strategy would realistically run in **one ~$20 wallet**.
- **Primary capital per run: $20.** A $100 run is reported, not gated.

**Fees:**
- The production PAPER fee model (`worker/src/bot_ledger.ts` `FEE_MODEL.ratePct`) is **0.20% per fill**.
- Primary cost: 0.20% per fill + 0.05% adverse slippage on market and stop fills.
- **Stress gate:** 0.40% + 0.10%. This is approximately Kraken Pro's taker fee at the lowest volume tier, plus a wider spread.
- Also reported: 0.80% per fill (instant-buy style).

**Execution model** (`engine/src/research/r7/bt.mjs`, tested):
- Market orders at the next bar's open (taker).
- Stops are resting orders, filled at the stop or at a worse gap open; a stop and a target inside the same bar resolve **stop first**.
- No limit orders, so there are no non-fills or partial fills to model.
- Latency is below one bar (≥ 1h), so it is covered by the next-open fill.

**Sizing and limits:**
- Risk 2% of current equity to the initial stop, capped by equity. No leverage.
- **Kraken minimums** (order minimum and cost minimum) come from Kraken's public AssetPairs, fetched once after this commit. A trade below the minimum is **skipped and counted**.

**Long only.**
- Kraken spot cannot short without margin permissions, which the account does not have.
- Round 7 showed every short rule failing. Shorts are not tested.

**Timeframes: 1h, 4h, 1d.**
- 15m is excluded on the evidence of rounds 1–6: short-horizon rules could not pay a 0.50% round trip.
- Lower timeframes would multiply the cost burden. This is a justified restriction, not an omission.

## 3. Data (Coinbase Exchange public candles; Kraken's public API returns only the last 720 candles, so it cannot supply history)

| Set | Markets | Period | Use |
|---|---|---|---|
| **Development** | BTC, ETH, SOL, LTC, LINK, XRP, ADA, AVAX (the owner's liquid set) | 2021-07-01 → 2024-07-01 | choose ONE configuration per family |
| **Validation (time)** | the same 8 | 2024-07-01 → 2026-11-15 | out of sample in time. These markets were examined in earlier rounds; disclosed. |
| **Independent (untouched)** | AXS, ENJ, CHZ, SUSHI, 1INCH, STORJ, SKL, ANKR, KNC, UMA, BAL, ZRX, LRC, QNT, FET, NMR | 2022-01-01 → 2026-11-15 | **never used by any round**. The confirmatory test |

**Data rules (fixed now):**
1. An independent market is included only if:
   - its Coinbase **1h and 1d** history starts on or before 2022-01-01; and
   - it is listed on Kraken (public AssetPairs).
2. Otherwise it is **excluded and reported**. The list is never extended or substituted.
3. If **fewer than 10** independent markets remain, the round is INCONCLUSIVE by construction.
4. A market whose data ends early: a held position is closed at its last close with costs (round 8 rule A1).
5. 4h bars are built from 1h bars.
6. **Survivorship (a known limitation):** only markets still listed on Coinbase can be downloaded. Delisted coins are absent, which biases buy-and-hold upward. The independent list nevertheless contains many markets that fell more than 80%.

## 4. Families and the complete grid (16 configurations; `engine/src/research/r9/families.mjs`)

**BTC regime filter (shared, causal):**
- ON when BTC's last **completed** daily close is above its 200-day SMA.
- For intraday bars, the most recent completed UTC day is used, never the current day.

| Family | Rule (long only) | Grid | TF |
|---|---|---|---|
| **F1 Regime-filtered Donchian** | Enter on a close above the prior N-bar high, only while the BTC regime is ON. Exit on a close below the prior M-bar low. 2×ATR(14) initial stop. | (N, M) ∈ {(20,10), (55,20)} | 4h, 1d (4 configs) |
| **F2 Volatility-normalised momentum** | Every 7th daily bar: enter if z = (L-day log return) / (σ_daily(60) · √L) > θ and the BTC regime is ON. Exit at a weekly check when z ≤ 0 or the regime is OFF. 3×ATR trailing stop. | L ∈ {30, 90} × θ ∈ {0.5, 1.0} | 1d (4) |
| **F3 Regime-adaptive** | Kaufman efficiency ratio ER(20). **If ER > e:** trend mode, entering on a close above the prior 20-bar high, exiting below the prior 10-bar low, with a 2×ATR stop. **Otherwise:** range mode, entering on a close below SMA20 − 2σ20 while above SMA200, exiting at SMA20 or after 12 bars, with a 2.5×ATR stop. The mode is fixed at entry. | e ∈ {0.3, 0.4} | 4h (2) |
| **F4 Reversion after extreme moves** | Enter after a bar whose return is below −k·σ(returns, 100), while close > SMA200. Exit at SMA20 or after 24 bars, with a 2.5×ATR stop. | k ∈ {3, 4} | 1h, 4h (4) |
| **F5 Regime-filtered relative strength** | Portfolio, weekly. Hold the top 3 by L-day return among markets with positive L-day return and close above their own SMA100, **only while the BTC regime is ON**; otherwise cash. Execution as round 8 (`r8/xsmom.mjs`), plus the filters. Point-in-time universe: a market is eligible only once it has L + 100 days of data. | L ∈ {30, 90} | 1d (2) |

**Disclosure:**
- F1 and F2 are regime and volatility versions of round 7's inconclusive T1 and M1.
- F5 adds a regime filter to round 8's failed rule.
- All three are tested here **only on new data**. That is the point of the round.

## 5. Selection (frozen)

- For each family, the configuration with the **highest pooled development net** among those with ≥ 30 development trades (F5: entries) is the candidate.
- That gives **5 candidates at most**. Every configuration's development result is reported.

## 6. Acceptance (ALL required)

Primary costs and $20 capital per market unless stated. Multiple testing: 5 candidates, so Bonferroni at α = 0.05 / 5, i.e. a **99% two-sided** interval.

1. Development net > 0 (pooled).
2. Validation net > 0 (pooled).
3. Independent net > 0 (pooled), with **≥ 60%** of independent markets positive. (F5 is one portfolio, so this does not apply.)
4. **Sample size:** at least **100** independent trades (F5: 30 entries).
5. **Uncertainty:** the independent bootstrap lower bound of the 99% interval is > 0.
   - Per-trade bootstrap (10,000 resamples).
   - F5: weekly returns, block of 4.
6. Independent net > 0 at **0.40% + 0.10%**.
7. **Drawdown:** median per-market independent max drawdown ≤ 25% and worst ≤ 40%. (F5: portfolio max drawdown ≤ 40%.)
8. **Regime:** independent pooled net positive in **≥ 3 of the 5** calendar years 2022–2026.
9. **Concentration:**
   - no single market contributes more than **50%** of independent net profit;
   - no single trade contributes more than **25%**.
10. **Robustness:** every **other** configuration of the same family (its parameter neighbours) also has independent net > 0.
11. **Feasibility at $20:**
    - at least 80% of entry signals are executable above Kraken minimums;
    - the $20 result is positive (gates 3 and 6 are evaluated at $20 anyway).

**Also reported:**
- buy-and-hold and cash;
- gross vs net and fee drag;
- win rate, profit factor, expectancy;
- Sharpe (daily equity);
- average holding period and exposure;
- the $100 run;
- the 0.80% scenario.

**Interpretation:**
- All gates pass: ELIGIBLE FOR FURTHER VALIDATION.
- Validation and independent nets positive but a gate fails: INCONCLUSIVE.
- Otherwise: FAILED.

**Not allowed:**
- changing any threshold, market, period or grid after results;
- substituting markets;
- re-running variants to rescue a family.

**Reproduction:** the whole round is re-run from a fresh process, and the results file must match byte for byte (excluding timestamps). Every trade's net must equal gross − fees.

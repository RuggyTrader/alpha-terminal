# Research round 7: different strategy families (report, 2026-11-16)

**RESEARCH, not PAPER results. Nothing is deployed or proposed for a trial.**

- **Protocol:** `PREREGISTRATION.md`, committed `255a351` before any run.
- **Code:** `engine/src/research/r7/` (backtester tested in `engine/test/r7-backtester.test.mjs`).
- **Results:** `r7-results.json`, which includes data hashes and code version.

**Setup:**
- **Costs:** 0.20% per fill + 0.05% slippage. Stress: 0.40% + 0.10%, and 0.80%.
- **Capital:** $100 per market, 2% risk, no leverage; SHORTs fully collateralised.
- **Data:** Coinbase public candles.
  - Development: BTC/ETH/SOL 2021-07 → 2024-07.
  - Validation: 10 markets, 2024-07 → 2026-11.
  - **Independent: 8 never-used markets** (DOT, ATOM, UNI, AAVE, XLM, ETC, FIL, ALGO), 2021-07 → 2026-11.

## Results (one configuration per family and side, chosen on development only)

| Candidate (selected) | Dev net (trades) | Val net (10 mkts, + count) | **Independent net (trades, + of 8)** | Indep 99.5% CI per trade | Stress 0.40% + 0.10% | Status | Failed criteria |
|---|---|---|---|---|---|---|---|
| T1 LONG Donchian 55/20, 4h | +369.4 (139) | +194.7 (5/10) | **+275.8 (601, 5/8)** | [−0.55, +1.48] | +96.3 | **INCONCLUSIVE** | breadth, CI, drawdown |
| M1 LONG 30-day momentum, 1d | +84.7 (75) | +67.4 (8/10) | **+83.9 (169, 4/8)** | [−0.38, +1.77] | +71.9 | **INCONCLUSIVE** | breadth, CI |
| T2 LONG SMA200 rising, 4h | +112.5 (420) | −24.5 (3/10) | −18.1 (1293, 2/8) | [−0.20, +0.41] | −180.1 | FAILED | validation, independent, CI, costs, drawdown, years |
| B1 LONG squeeze breakout, 4h | +0.3 (178) | +3.3 (5/10) | −33.0 (651, 2/8) | [−0.29, +0.33] | −138.5 | FAILED | independent, CI, costs |
| R1 LONG mean reversion 2.5σ, 4h | −13.5 (88) | −56.7 (2/10) | −42.9 (156, 0/8) | [−0.55, −0.04] | −63.7 | FAILED | all but 4, 7 |
| T1 SHORT Donchian 20/10, 1d | −10.3 (48) | −7.7 | −9.6 (162, 5/8) | [−0.41, +0.44] | −21.4 | FAILED | |
| T2 SHORT SMA200 falling, 1d | +4.8 (47) | +9.7 | −34.8 (246, 1/8) | [−0.38, +0.08] | −48.7 | FAILED | |
| M1 SHORT 120-day momentum, 1d | +16.9 (47) | +13.6 | −7.8 (209, 3/8) | [−0.33, +0.29] | −19.1 | FAILED | |
| B1 SHORT squeeze breakout, 4h | −37.5 (185) | −50.7 | −63.0 (715, 2/8) | [−0.29, +0.05] | −161.4 | FAILED | |
| R1 SHORT mean reversion 2.5σ, 4h | −3.7 (81) | −0.1 | −90.8 (405, 0/8) | [−0.49, −0.06] | −158.8 | FAILED | |

## The two inconclusive candidates, in detail

### T1 LONG (4h Donchian breakout 55/20)

**Independent result:** gross +400.1, fees 124.4 (31% of gross), net +275.8.

**Per market:**

| Market | Net | Market | Net |
|---|---|---|---|
| XLM | **+233.1** | AAVE | +7.7 |
| ALGO | +95.4 | ETC | +2.2 |
| UNI | +12.1 | ATOM | −0.4 |
| DOT | −32.4 | FIL | −42.0 |

**Concentrated:** XLM alone is 85% of the net, and 2024 alone is +294.4. The other years are −14.1 (2021), −18.8 (2022), +32.2 (2023), −30.4 (2025) and +12.4 (2026).

**Drawdown:** 29–54% per market, above the pre-registered risk profile.

**At 0.80% per fill:** −105.5.

**Every T1 LONG configuration was positive in development** (+134 to +369). That points to a family-level effect.

### M1 LONG (30-day time-series momentum, weekly decision)

**Independent result:** gross +92.3, fees 8.4 (9% of gross), net +83.9.

**Exposure and drawdown:** low exposure (5–35% of the time); drawdowns 5–26%.

**Positive at 0.80% per fill:** +56.7.

**Concentrated, again:** XLM +52.3 and UNI +20.5. Four of the eight markets are slightly negative, and several have very few trades (5–16).

**By year:** 2024 +108.7; 2022 −12.5; 2026 −24.4.

**Every M1 LONG configuration was positive in development.**

### Benchmarks (independent markets, 2021-07 → 2026-11)

Buy and hold lost 52–99% on every one of the eight markets. Both candidates beat buy and hold and cash by being in the market only during strong uptrends.

## Conclusions

1. **No candidate meets the pre-registered acceptance criteria. Nothing is ELIGIBLE FOR FURTHER VALIDATION, and no forward trial is proposed.**
2. **The first positive out-of-sample evidence in seven rounds:** long-only trend and momentum (T1, M1) are net positive in development, validation **and** on eight untouched markets, and they survive 0.40% + 0.10% costs.
   - The gain comes from **a few large trends** (XLM in 2024, the 2024 alt rally).
   - It is not broad enough or statistically significant (99.5% intervals include zero).
   - T1's drawdowns are too large.
   - This matches the economics in the audit: these strategies capture moves of many percent, so fees are 9–31% of gross instead of more than 200%.
3. **Mean reversion (R1), volatility squeeze (B1) and every SHORT variant fail.**
4. **Status:**
   - T1 LONG and M1 LONG are **INCONCLUSIVE** (positive, unproven).
   - Every other family and side is **FAILED**.

## What would resolve it (not run: needs new data or new pre-registration)

- **Broader independent evidence.** All 18 markets with history are now examined, so the remaining untouched evidence is **future data**.
  - For example, a pre-registered, frozen **research-only forward observation** of M1 LONG across a basket.
  - That needs the owner's approval and must not be presented as a PAPER result.
- **A portfolio-level hypothesis**, pre-registered: equal risk across many markets. It would address the concentration (one or two large winners per period) through diversification.
  - It must be evaluated on data not used here.
- **Not allowed:** tuning T1 or M1 on these results to pass.

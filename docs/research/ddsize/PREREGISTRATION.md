# Pre-registration: H-G1 "optimal drawdown-budget sizing" of the frozen S3 signal, 2026-11-22

Committed **before any run on real data**. Research only.

## Hypothesis

**Every strategy tested so far used a fixed, tiny position size to stay under 2 %.**

**Theory: Grossman & Zhou (1993).** Under a maximum-drawdown constraint α, the growth-optimal policy invests a multiple *m* of the **cushion** C = V − (1 − α)·P:
* V = current equity;
* P = the running peak of equity.

This uses the drawdown budget dynamically:
* exposure falls as the account approaches the floor;
* exposure recovers as new peaks are made.

**Question:** applied to our strongest signal (S3, frozen), how much can be earned *at most* while respecting 2 %?

## Rules (fixed)

**Signal:** S3 exactly as frozen (`dd2/bt.mjs` family V, n = 200, tv = 0.40). Per-asset target weight w_i ∈ [0, ½] for BTC and ETH.

**Overlay**, decided at each daily close:
* k = clamp(m · (V − 0.98 · P) / V, 0, 1), with V and P on closing equity;
* the desired weight per asset is k · w_i.

**Orders** at the next daily open (market), only when:
* the desired weight crosses to or from 0, or
* |actual − desired| > 25 % of desired.

**Venue: Ndax** (the cheapest total-cost route, HISTORICAL-REPORT):
* 0.20 % fee + 0.25 % spread/impact per side (today's observed level, ASSUMED for history);
* $1 minimum order.

**Prices:** Kraken's official daily USD bars.

**Multipliers (all reported, none selected):**

| m | Meaning |
|---|---|
| 1 | very safe |
| 2 | survives a 40 % one-day fall with exposure at its cap |
| 3 | does not survive that |

## Data

**Period:** 2018-04-01 → 2026-09-30. Kraken daily BTC and ETH; Ndax existed from 2018-03.

**Honesty:** S3 was selected on 2016–2021 data, and every period here was seen by earlier hypotheses. The *sizing rule* comes from theory and has not been tested before, but this is **not** out-of-sample evidence for S3.

## Pass criteria

1. Strict max drawdown (daily lows) **< 2 %** for m = 1 and m = 2.
2. **Net profit > 0** for m = 1 and m = 2.
3. **"Meaningful":** net ≥ 3 %/yr for m = 2. Otherwise label it "compliant but too small".
4. **Comparison:** must beat the best earlier 2 %-compliant result over the same window (A: 1.39 %/yr on Kraken post-only) to be preferred.

Whatever the outcome, the m-family is reported in full. No other multiplier or floor is tried afterwards.

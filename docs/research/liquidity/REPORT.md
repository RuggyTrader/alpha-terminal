# H-L1 report: liquidity provision to forced sellers (wick capture), 2026-11-22

**Verdict: REJECTED** under the pre-registered criteria (`PREREGISTRATION.md`, commit `90c25d7`; runner `a6602aa`, run once).
* Research only. Nothing traded or deployed.
* The rules were not changed after the run.

## Results (primary cost model: Kraken USD at today's fees, $100, strict hourly drawdown)

| Setting | C1: BTC+ETH+SOL 2021-01 → 2026-09 | C2: 10 other coins (median $, profitable coins) | D: BTC+ETH 2016–2020 |
|---|---|---|---|
| a z1.5 / 24 h | $84.58 (−2.9 %/yr), DD 14.8 %, 139 trades | $91.36, 0/10 | $86.85, DD 12.6 % |
| b z1.5 / 72 h | $84.82, DD 14.6 % | $91.41, 0/10 | $86.97 |
| c z2 / 24 h | $95.03 (−0.9 %/yr), DD 4.2 %, 34 trades | $97.08, 0/10 | $92.99 |
| d z2 / 72 h | $95.05, DD 4.2 % | $97.10, 0/10 | $93.03 |
| e z3 / 24 h | $97.72, DD 1.4 %, 4 trades (all stopped) | $99.07, 0/10 | $98.26 |
| f z3 / 72 h | $97.72, DD 1.4 % | $99.07, 0/10 | $98.33 |

**Against the pass criteria:**

| Criterion | Result |
|---|---|
| 1. C1 profitable with DD < 2 % | 0/6 ✘ |
| 2. Median C2 coin profitable | 0/6 ✘ |
| 3. Expectancy CI > 0 | ✘ (mean R −0.4 to −1.2, CI entirely below 0) |
| 4. Stress | 0/6 ✘ |

Ndax fees (hypothetical) and Kraken's older, lower fees are also negative everywhere.

## Why it fails: diagnostics (labelled, run after the verdict, cannot change it)

Zero fees, zero slippage, eps 0 (`diag-hl1.mjs`):

| | Conservative same-hour stop (pre-registered) | Optimistic: ignore stops in the fill hour |
|---|---|---|
| C1 z2 | mean R −0.07, CI [−0.18, 0.03] | mean R +0.19, CI [0.08, 0.28] |
| C1 z3 | −0.03 [−0.20, 0.14] | +0.34 [0.20, 0.44] |
| D z1.5 | +0.01 [−0.07, 0.07] | +0.13 [0.06, 0.20] |

**What the diagnostics show:**
1. **There is no edge before costs** under the realistic fill rule. A reversal edge appears only if, inside the hour of the crash, the price is assumed to bounce before it reaches the stop. Hourly data cannot show that ordering. **Five-minute bars** from the same official archive (`XBTUSD_5.csv`, 68 MB) could resolve it, and are listed as an infrastructure item.
2. **Even the optimistic case is not meaningful.** C1 z2 makes $100 → $106 in 5.75 years *before any cost* (≈ 1 %/yr): about 22 trades a year × 0.19 R × 0.25 % risk.
3. **Costs then take 0.1–0.2 R per trade:** maker 0.40 % + taker 0.80 % against a stop distance of ~6–10 %.

## What this teaches (carried into the next hypotheses)

Under a 2 % trailing drawdown, a strategy earns roughly:

> annual return ≈ trades per year × net expectancy (R) × risk per trade

and risk per trade must stay ≈ 0.25 %.

So a meaningful 3 %+/yr needs, for example, ~60 trades a year at +0.2 R **net**, or a return stream with a much higher return-to-worst-loss ratio. Sparse crash events cannot provide this, even if the effect is real.

# Pre-registration: one-contract Micro Ether feasibility probe ($100 PAPER), 2026-11-22

Committed before the first run. This is **not a strategy search**: no rule is tuned or selected. Frozen signal rules from earlier rounds are applied, unchanged, at the only size a $100 account can hold (1 MET ≈ 1.7× equity). The probe measures whether *any* known type of rule can stay inside the owner's futures targets: drawdown preferably < 10 %, ceiling 15 %.

## Rules (ETH daily signals from Kraken's official daily bars, decided at 00:00 UTC, executed at the first open futures hour)

| Probe | Position |
|---|---|
| P1 trend | long 1 MET while ETH close > 200-day SMA; else flat |
| P2 trend long/short | long while > SMA200; short while below |
| P3 momentum (DD2 rule A's signal) | long after the 56-day return > 5 %; flat when it turns < 0 |
| P4 breakout (rule D's signal) | long after a close above the prior 20-day high; flat after a close below the prior 10-day low |

**Stops:**
* Each probe runs with **no stop**, and with a **3 % server-side stop**, re-entering the next day if the signal is still on.
* **Why 3 %, derived before running:** one stopped loss ≈ 1.72 × 3 % + ~1.4 % fees ≈ 6.5 % of equity, so two consecutive stops stay under the 15 % ceiling.

## Costs and venue rules

* **VERIFIED:** $0.69 per side all-in; contract 0.1 ETH.
* **Hours:** historical CME sessions before 2026-05-29 (weekend and daily closures, approximate UTC times), then 24/7.
* **ASSUMED:** spread + slippage 0.05 % per side; stop slippage 0.2 %; monthly roll costs 2 fees + 2 spreads; futures basis carry 8 %/yr (longs pay, shorts earn), with sensitivity at 0 % and 15 %. The price path is Kraken ETH spot (hourly).
* **Liquidation**, two readings of NinjaTrader's policy:
  * **(A)** equity must stay ≥ the $50 margin;
  * **(B)** ≥ 2 × margin = $100, per the FAQ example.
  * Liquidation fee $25 first, $50 after.

## Measures

* **Drawdown:** from the equity high-water mark, including unrealized P&L and intrabar extremes (hourly bars, worst-case order).
* **Also reported:** final equity, net annual return, trades, liquidations, ruin, fees.
* **Windows:** 2017-01 → 2026-09, 2018-04 → 2026-09, 2022-01 → 2026-09.

## Verdict rule

* **"Feasible in principle":** at least one probe has drawdown < 15 % **and** net profit > 0 in all three windows under reading (A) with basis 8 %.
* **Otherwise:** one-contract MET at $100 is judged not workable for these rule types, and the next step is a decision for the owner.
* **Reuse note:** the probe reuses ETH prices and frozen rules examined in earlier rounds. Nothing here is out-of-sample evidence.

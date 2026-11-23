# One-contract Micro Ether probe ($100 PAPER): result (2026-11-22)

**Verdict: not feasible in principle.**
* No frozen rule type (trend, trend long/short, momentum, breakout; with or without a 3 % stop) stays under the 15 % drawdown ceiling with a profit in any window.
* Pre-registered in `PROBE-PREREGISTRATION.md` (commit `4d0c73e`); run once; nothing tuned.
* Research only.

## Results (basis carry 8 %/yr; historical CME hours; hourly strict drawdown from the equity high-water mark)

| Window | Liquidation reading | Best final | Drawdown range (all 8 probes) | Liquidations |
|---|---|---|---|---|
| 2017-01 → 2026-09 | A: equity ≥ $50 | $576 (P2 trend long/short, no stop; DD 74 %) | **55.8 – 75.7 %** | 0 |
| 2018-04 → 2026-09 | A | $390 (P1 trend, no stop; DD 60 %) | **50.2 – 70.1 %** | 1 in 6 of 8 probes |
| 2022-01 → 2026-09 | A | $23 (all lose) | **52.1 – 73.3 %** | 1 in every probe |
| any | B: equity ≥ $100 (2× margin) | $73.6 | — | the first trade is liquidated within hours; the account can never reopen |

Basis-carry sensitivity (0 % and 15 %): verdict unchanged (`probe-results.json`).

## Why

* **One contract is a fixed ~1.7× exposure.** ETH's drawdowns inside trends (30–40 %) become 50–70 % of equity.
* **A 3 % stop doesn't solve it:**
  * each stopped trade costs ~6.5 % of equity including ~1.4 % in fees;
  * ordinary chop produces runs of stops that walk the account down to the liquidation threshold.
* **Liquidation is an absorbing state.** Once equity is below the $50 margin, no new position can be opened, so the account cannot recover.
* **Under the 2× reading** of NinjaTrader's FAQ, a $100 account cannot hold even one Micro Ether.

## Simulator (`engine/src/research/futures/met.mjs`, 6 tests)

* **Contract and fees:** 0.1 ETH contract, $0.69/side fees; margin must be met at all times, else liquidation (fees $25 / $50).
* **Hours:** historical CME closures before 24/7 trading began on 2026-05-29. Weekend gaps are modelled, and a stop fills at the reopen price.
* **Futures pricing:** monthly rolls; basis carry (longs pay, shorts earn).
* **Drawdown:** the strict high-water-mark drawdown includes intrabar extremes.
* **ASSUMED:** spot price path (Kraken ETH/USD) as the futures price, UTC session approximations (±1 h), spread 0.05 %, stop slippage 0.2 %, basis 8 %/yr.

## What this means

At $100, MET futures cannot meet the 10–15 % drawdown targets with any rule type we have examined. The obstacle is structural: exposure cannot be sized below one contract, and costs and liquidation rules are large relative to equity. Better signals would not remove it.

**Only three things change the result:**
1. **More simulated capital.** At $850–1,700, one MET risks about 10–20 % of what it risks at $100, and position counts can be scaled.
2. **A smaller contract.** Bitnomial small-size perpetuals are listed with margins of $0.12–$2.94, but their availability to an Ontario NinjaTrader account is UNVERIFIED.
3. **An owner decision to accept much larger drawdowns**, which is not recommended and not proposed.

**Reuse note:** ETH prices and the rules were examined in earlier rounds; this is not out-of-sample evidence.

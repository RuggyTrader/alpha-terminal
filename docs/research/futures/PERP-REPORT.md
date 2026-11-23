# Fractional long/short perpetual-style research: results (2026-11-22). ALL RESULTS THEORETICAL PAPER ONLY

**Verdict: no candidate.**
* No hypothesis or sizing meets the pre-registered criteria: drawdown ≤ 15 % in all windows, ≥ 15 %/yr, and profit in 2022–26, under conservative costs.
* Pre-registration: `PERP-PREREGISTRATION.md` (commit `ae82626`). Amendment 1 (`fa1c350`) fixed two simulator defects found by the first run.
* The defective v1 results are kept (`perp-results-v1-DEFECTIVE.json`). Final results: `perp-results.json`.
* **Proxies and reuse:** Kraken spot prices and Binance funding proxies; reused price data. Nothing is out-of-sample.

## Simulator verification

`perp.mjs`: 10 accounting tests with hand-computed values:
* long and short P&L;
* funding direction;
* percentage fees vs per-order minimum fees (never scaled down);
* spread and slippage;
* liquidation at the hour's worst price, with fee;
* the initial-margin cap;
* compounding vs fixed sizing;
* the rebalance band;
* missed orders;
* period and recovery statistics.

## Net annual return (max drawdown), compounded

| Strategy | Costs | 2017-01 → 2026-09 | 2018-04 → 2026-09 | 2022-01 → 2026-09 |
|---|---|---|---|---|
| H1 trend long-only, 1× | ideal | 68.5 % (77 %) | 28.5 % (70 %) | 20.7 % (33 %) |
| H1, 1× | conservative | 68.9 % (75 %) | 24.1 % (75 %) | 16.7 % (36 %) |
| H1, 2× | ideal | 83.5 % (98 %) | 25.9 % (95 %) | 29.2 % (55 %) |
| H1, 3× | ideal | **liquidated, ruin** | ruin | 19.5 % (81 %) |
| **H1, volatility target 15 %** | **ideal** | **20.8 % (27 %)** | 12.9 % (27 %) | 9.0 % (24 %) |
| H1, volatility target 15 % | conservative | 12.1 % (34 %) | −0.4 % (40 %) | −3.5 % (38 %) |
| H2 trend long/short, 1× | ideal | 44.5 % (90 %) | 10.1 % (87 %) | 21.8 % (51 %) |
| H2, 2× / 3× | ideal | 25.4 % (99.8 %) / ruin | −19.2 % / ruin | 9.7 % / −28 % |
| **H2, volatility target 15 %** | **ideal** | **18.7 % (37 %)** | 10.8 % (37 %) | 10.8 % (24 %) |
| H2, volatility target 15 % | conservative | 0.0 % (56 %) | ruin | −13.1 % (61 %) |
| H3 relative momentum, volatility target 15 % | ideal | 0.5 % (28 %) | 1.6 % (28 %) | −1.6 % (28 %) |
| H3, 1×–3× | any | −0.9 % to ruin | negative | negative |
| *Exploratory 5× (all hypotheses)* | any | **ruin in every window** | ruin | ruin |

**Fixed-size (non-compounded) conservative runs:**
* H1 1× earned 21.5 %/yr, DD 25 % (2017–26).
* H2 1× earned 19.7 %/yr, DD 36 %.
* Several fixed runs had a smaller drawdown than their compounded twins because they stop growing the position after early wins. All are still above the 15 % ceiling.

**Higher drawdown buys nothing.** Moving from 1× to 2× raised drawdown to 95–99 % while returns fell in two of three windows. 3× and 5× ended in liquidation.

## Period returns and cycles (H1 and H2 at volatility target 15 %, ideal, compounded, 2017–26)

| | 2 weeks (median / worst / best) | Month | Quarter | Year | Longest recovery | Worst day |
|---|---|---|---|---|---|---|
| H1 | 0 / −10.7 / +17.7 % | 0 / −12.1 / +24.5 % | 0 / −13.9 / +43.0 % | +11.9 / −9.6 / +143 % | 706 days | −8.4 % |
| H2 | +0.1 / −14.6 / +17.7 % | +0.5 / −14.6 / +24.5 % | +0.6 / −13.2 / +43.0 % | +14.4 / −8.2 / +132 % | 814 days | −13.1 % |

| Cycle | H1 return (drawdown in cycle) | H2 return (drawdown in cycle) |
|---|---|---|
| 2017–18 bull + bear | +120 % (15 %) | +183 % (21 %) |
| 2019 recovery | +19 % (17 %) | −13 % (24 %) |
| Mar 2020 crash | −13 % (15 %) | −17 % (18 %) |
| 2020–21 bull | +102 % (13 %) | +79 % (22 %) |
| 2022 bear | −11 % (11 %) | **+12 % (13 %)** |
| 2023–26 | +54 % (16 %) | +30 % (22 %) |

## Minimum realistically executable capital

This uses NinjaTrader's perp-style nano contracts (ETH 0.1 ETH ≈ $172, BTC 0.01 BTC ≈ $612), overnight margins of $170 and $260, and a 15 % loss buffer.

| Strategy | 1 contract per leg | ≥ 5 contracts per leg (reasonable granularity) | Note |
|---|---|---|---|
| H1 / H2 at 1× | $345 (ETH) / $1,224 (BTC) | $1,723 / $6,118 | ETH overnight margin allows only ≈ 1.0× on ETH |
| H1 / H2 at volatility target 15 % | $1,150 (ETH) / $3,070 (BTC) | $5,750 / $15,300 | — |

**Every result above is THEORETICAL PAPER ONLY at $100.**

## What deserves further investigation

1. **Trend with tighter risk scaling (H1 and H2, volatility-targeted).**
   * This was the only family with a positive edge in every window under ideal costs.
   * Its drawdown was about 2× its volatility target, so meeting 10–15 % would need a target of roughly 5–7 %, with expected returns of perhaps ~6–10 %/yr. That estimate is an inference and has not been tested.
   * **Next step:** a new pre-registration with the target fixed a priori from the ratio observed here. A test on data not yet used (forward PAPER) should follow; all history has now been examined.
2. **Shorting as a bear-market complement.** H2 beat H1 in the 2022 bear. Its value is regime-specific, and it lost in 2019 and the March 2020 crash.

**Rejected:**
* **H3 BTC/ETH relative momentum:** no edge in any window.
* **Fixed leverage of 2× or more:** drawdowns of 95 % or more, or ruin.
* **Any execution at $100:** fixed per-order costs alone consume the account.

**Not tested (excluded by an earlier owner instruction):** cash-and-carry funding capture (spot long + perp short).

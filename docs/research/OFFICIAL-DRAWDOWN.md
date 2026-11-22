# Official 2 % maximum-drawdown requirement (owner's definition, 2026-11-22)

**Definition:** the maximum decline of TOTAL account equity from its high-water mark must stay below 2 %.
* **Total equity:** cash + positions marked to market, including unrealized gains and losses, after fees and slippage.
* **High-water mark:** the highest equity ever recorded, *including intraday highs*. It is **not** the starting $100.
* **Intraday movements count**, both highs and lows.

**Rules:**
* This requirement is never loosened or redefined to make a strategy pass.
* Other risk measures may be reported for research, but only under a different label. They never replace this one.

## How the research code measures it (`dd_official_pct`)

At every bar, in every research backtester (`dd2/bt.mjs`, `lab/wick.mjs`, `lab/gz.mjs`):

* equity at the bar's **high** (holdings carried into the bar) and at its **low** (all assets together);
* the high-water mark includes the bar's high, and the bar's high is assumed to come **before** its low (the worst case: hourly or daily bars cannot show the order);
* official DD = max over bars of 1 − equity_low ÷ max(previous high-water mark, equity_high).

Tests are in `engine/test/official-drawdown.test.mjs`:
* an exact hand-computed case: a 120 intraday high, then a low of 100, gives 16.67 %;
* the official figure is never below the older measure, in all three backtesters.

**Labels used for the other measures in earlier reports, which are NOT the official requirement:**
* "strict DD" / `dd_pct`: closing-equity peak, marked at lows;
* "close DD": closing equity only.

## Correction of earlier "meets 2 %" claims (re-run 2026-11-22, `hist-backtest-results-official.json`)

| Strategy (today's fees and minimums) | Earlier "strict" DD | **Official DD** | Verdict under the official requirement |
|---|---|---|---|
| A BTC momentum, Kraken CAD post-only, 2018-04 → 2026-09 | 1.81 % | **1.93 %** | passes, barely (1.39 %/yr) |
| A, same, 2016-07 → 2026-09 | 1.98 % | **2.20 %** | **fails** |
| A, Kraken USD market | 1.95 % | 2.19 % | **fails** |
| B 3-asset momentum, Kraken CAD post-only, 2018-04 → 2026-09 | 1.46 % | **1.55 %** | passes (0.95 %/yr) |
| B, same, 2016-07 → 2026-09 | 1.37 % | **1.57 %** | passes (1.25 %/yr) |
| B, Kraken CAD market | 1.79 % | **2.01 %** | **fails** |
| C 55/10 breakout (every route, both windows) | 1.68–1.94 % | **2.24–2.39 %** | **fails everywhere** (earlier reports said it met 2 % at historical fees) |
| D 20/10 breakout | 2.3–5.0 % | higher | fails |
| S3 | ~40 % | ~40 % | fails |

**Result:** under the official definition, **only B passes with margin**, at ~1 %/yr. A passes only over the shorter window with post-only orders.

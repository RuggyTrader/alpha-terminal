# Round 10 pre-registration: drawdown-budget strategies under the owner's 15 % limit (2026-11-23)

Committed **before any run** of these rules. Research only: historical data, no orders, nothing deployed. P1's forward PAPER study, S3, the four bots and production are unchanged.

## Why these hypotheses (and what is excluded)

**Price-signal families are exhausted here.** Rounds 1–9, the futures work and the discovery phase already rejected:
* trend, momentum and breakouts;
* cross-sectional rotation and mean reversion;
* wick capture;
* funding, flow, stablecoin and sentiment signals;
* seasonality;
* P1 and P2.

Reviving any of them with new parameters is not allowed.

**Checked and rejected before testing:**
* **The cross-sectional crypto trend factor (CTREND; JFQA 2025):** it needs a long–short portfolio over a broad coin universe. Ndax spot is long-only, with about six liquid coins. A 2026 replication reports negative net returns after corrections.
* **Intraday momentum:** its edge is a few basis points, far below Ndax's ~0.9 % round trip.
* **Options volatility premium:** not available at $100.

**The new idea.** The owner's **15 % maximum drawdown** (preferably < 10 %), measured from the high-water mark including unrealized and intraday losses, is a *budget*. The question is whether a published drawdown-control rule converts more of a long-run positive drift into return within that budget than S3 at a fixed 25 %.

The 2 %-limit version (H-G1) was rejected because a 2 % budget forces cash lock. The owner's change to 15 % makes the question new. **No signal is new or optimized.**

| ID | Hypothesis | Source of the mechanism |
|---|---|---|
| **N1** | **Constant mix:** a fixed 7 % in BTC/ETH (3.5 % each), rebalanced on a band. Captures the diversification ("volatility-harvesting") return with no signal. | Fernholz & Shay (1982); Bouchey et al. (2012) |
| **N2** | **Drawdown-floor (Grossman–Zhou / CPPI) buy-and-hold:** BTC/ETH halves, gross exposure = min(1, m × cushion) | Grossman & Zhou (1993); Black & Perold (1992) |
| **N3** | **Drawdown-floor S3:** S3's frozen target weights × min(1, m × cushion) | the same, applied to the existing S3 signal |

## Frozen rules

* **cushion** = (E − F) / E, where:
  * E = equity at the daily close;
  * F = (1 − D) × HWM;
  * HWM = the official high-water mark (including intraday highs).
* **D:** 0.15 (primary). 0.10 is the registered "< 10 %" variant.
* **m = 2.** Set by a gap rule, **not** by backtest: exposure × G ≤ cushion with G = a 50 % single-day crash.
  * Disclosure: G comes from known crypto history (the 2020-03-12 low).
  * At the high-water mark, N3 therefore holds S3 × 0.30 (D 15 %) or S3 × 0.20 (D 10 %).
* **N1 weight:** 7 % from a stress rule. A constant mix loses about 1 − (1 − c)^w in a crash of c; with c = 90 %, w = ln(0.85) ÷ ln(0.10) ≈ 0.07. **This uses known crash depths (disclosed).**
* **Execution:**
  * decisions at the daily close, fills at the next open (`dd2/bt.mjs`);
  * the band is 0.10 of the per-asset cap × size × the overlay multiplier, as for S3;
  * Ndax minimum orders.
* **Costs:**
  * **main:** Ndax 0.20 % fee + the measured Ndax C$50 spread per side;
  * **sensitivity:** NDAX CONSERVATIVE, as in `s3-backtest.mjs`.
  * Other coins use the measured Ndax spreads (XRP 0.24 %, LTC 0.35 % per side).
  * Pre-Ndax years use BTC's measured cost. This is an **estimate**: 2014–15 Kraken books were thinner.

## Data and windows

| Window | Assets | Status |
|---|---|---|
| **DEV-A:** 2016-07-01..2026-09-30 | BTC + ETH | **Reused.** These data selected S3 and its sizes (disclosed). |
| **DEV-B:** 2018-04-01..2026-09-30 (Ndax era) | BTC + ETH | **Reused** (disclosed) |
| **HOLDOUT-1:** 2014-05-01..2016-06-30 | BTC only (ETH has no 200-day history) | **Never used** by any S3-type or drawdown-overlay test. It includes the 2014–15 bear (BTC about −80 %) and a long sideways market. Kraken was thin then. |
| **HOLDOUT-2:** 2018-04-01..2026-09-30 | LTC + XRP (Ndax-listed) | **Not independent:** these coins appeared in other rounds' trend tests. They were never used for S3 or these overlays. Reported as a cross-asset check. |

* **Drawdown:**
  * the official drawdown (candle bound: each day's high assumed before its low);
  * plus the 5-minute time-ordered reconstruction where 5-minute data exist (BTC/ETH).
* **Short-horizon reporting:** rolling 7-, 14-, 30- and 90-day net returns: median, 5th percentile and worst.

## Benchmarks

* **S3-25:** S3 × 0.25, fixed (the owner's benchmark).
* **S3-30:** S3 × 0.30, the same exposure as N3 at the high-water mark. This separates the effect of the overlay from simply holding more.
* **Buy-and-hold BTC/ETH.**
* The rejected P1 (f = 50 %: 20.0 %/yr, DD 9.6 %, decayed) is quoted for context only.

## Decision rule (fixed now)

A candidate **ADVANCES to forward PAPER** only if **all** of these hold:
1. **Drawdown:** official maximum drawdown < 15 % in **every** window, under both cost sets.
2. **Development:** net CAGR > S3-25's in DEV-A and DEV-B (main costs).
3. **HOLDOUT-1:** net return > 0 **and** > S3-25 in the same window.
4. **HOLDOUT-2:** drawdown < 15 % and net ≥ 0 (a consistency check; not independent).

**Otherwise:**
* A candidate meeting 1–3 but not 4 is **INCONCLUSIVE**.
* Anything else is **REJECTED**.

**Labelling the variants:**
* The D = 10 % variants are reported separately. "Preferred < 10 %" means drawdown < 10 % in every window.
* N3 must also beat **S3-30** to show that the overlay, not extra exposure, helps. Without that it can advance only as "equivalent to a larger fixed S3".

**No re-runs with changed m, D or weights.** These results are historical; observed costs are estimates; none of it predicts future returns.

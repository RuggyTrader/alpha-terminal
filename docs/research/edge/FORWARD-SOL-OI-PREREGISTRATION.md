# Pre-registration: forward observation of the SOL open-interest reversal (approved 2026-11-25)

**Committed before the collector's first run.** These rules are frozen. Forward events are only those whose hour boundary T is **after the collector's start time**. No trades of any kind (PAPER or real), no wallet, no signing.

## Event (identical to H-OI in `PREREGISTRATION.md`, d750dda, group "down_OIdown_longClosing")

* **Data** (public, read-only; checked identical to the research series on 2026-11-25: 500 / 500 OI rows and 500 / 500 klines, zero difference):
  * Binance USDT-M `GET /futures/data/openInterestHist?symbol=SOLUSDT&period=5m` (`sumOpenInterest`);
  * `GET /fapi/v1/klines?symbol=SOLUSDT&interval=5m`.
* **1-hour return:** at each UTC hour boundary T, R = close of the 5-minute bar starting at T − 5 min ÷ open of the bar starting at T − 1 h − 1.
* **Volatility:** σ = the sample standard deviation of the previous **720** available hourly returns (computed the same way).
* **Strong move:** |R| > 2σ.
* **OI change:** ΔOI = OI(T) ÷ OI(T − 1 h) − 1.
* **Qualifying event:** R < −2σ **and** ΔOI < −0.5 %.
* **Other strong-move groups** are recorded for completeness and are not evaluated.

## Detection, entry and outcome (what was actually knowable)

* **Run schedule:** about every 5 minutes, at roughly 4 minutes past each 5-minute mark. Binance publishes an OI row about 2.7 minutes after its timestamp.
* **At detection the collector records:**
  * the fetch time;
  * the exact klines and OI rows used, R, σ and ΔOI;
  * Jupiter's mark price (read-only `market-stats`);
  * the latest on-chain Jupiter borrow rate.
* **Entry (hypothetical, long):** the open of the first 5-minute bar starting at or after max(T + 5 min, the detection time). `entryDelayMin` = entry − T.
* **Primary sample:** events with entry ≤ T + 15 min (detected in real time).
* **Late events:** a later detection (PC off, API failure) is recorded as **LATE**. It is never in the primary sample and is never re-labelled.
* **Outcome:** gross rebound r = close of the 5-minute bar ending at entry + 4 h ÷ entry open − 1, from klines fetched after the fact. The fetch time is recorded. A missing bar → **UNRESOLVED** (never interpolated).

## Costs (hypothetical, Jupiter Perps, a long with USDC collateral)

| Scenario | Round trip | Borrow (4 h) |
|---|---|---|
| Optimistic | 15 bps | today's rate |
| Baseline | 30 bps | today's rate |
| **Conservative (reported as primary)** | **60 bps** (6 + 6 bps fees, keeper delay, swap fee, imbalance fee) | 2 × the live on-chain SOL long rate, recorded at detection |

## Evaluation (once, when the sample is large enough; no early looks at returns)

* **Sample-size gate:** ≥ **60** primary events **and** ≥ **40** independent clusters (events with T within 4 h of each other form one cluster). If the events are clustered, collection continues until both hold.
* **Interim reports** show counts, data quality and gaps only, **never returns**, to avoid optional stopping.
* **PASS** requires all of:
  * the mean gross rebound > **60 bps**;
  * the **90 % confidence interval** lower bound > **30 bps**, using the **more conservative** of:
    * a cluster bootstrap (10,000 resamples of clusters, percentile interval);
    * a t-interval on cluster means;
  * the mean net rebound under conservative costs reported alongside.
* **Otherwise FAIL.** A FAIL ends the hypothesis.

**A PASS does not promote anything:** the evidence is reported and the owner decides.

## Data integrity

* Every run, API failure, missing observation, restart and data gap goes into append-only logs.
* Nothing missed is ever reconstructed as if it had been observed live.
* Historical klines from before the start are used **only** to initialise σ (the 720 previous hours), never to create events.

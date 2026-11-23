# Pre-registration: read-only Ndax/Kraken order-book study for P1 (2026-11-22)

Committed **before any data is collected**. Research only.
* **Data:** read-only public market data only. No orders, no credentials, no paid services. Production, bots and S3 are untouched.
* **Not a strategy optimisation.** P1's rule, costs and thresholds are frozen (PREREGISTRATION.md). Observed quotes are not proof that execution would have happened.

## Data collected (public endpoints, every 2 minutes, up to 30 days)

* **Ndax** (`GetL2Snapshot` depth 25, `GetLevel1`) for BTC, ETH, XRP, LTC, DOGE, SOL in CAD:
  * best bid and ask with sizes, top 10 levels;
  * executable average **buy price (walking the asks)** and **sell price (walking the bids)** for C$33 (P1's position size at f = 100 % with 3 slots on $100) and C$100;
  * last-trade time; 24-hour and current-day traded value.
* **Kraken** (`Depth` count 25) for the same coins in USD, plus USD/CAD: best bid and ask, mid.
* **Global CAD price:** Kraken mid (USD) × Kraken USD/CAD mid.
* **Request timestamps:** before and after each sample.
* **Pace:** ≈ 19 requests per 2 minutes, well inside the published limits.
* **Coverage:** the collector runs only while this PC is on. Gaps are reported, never filled.

## Definitions (fixed now)

* **Reference premium m(d):** P1's own definition. The median, over the 30 days before day d, of the daily-close premium (Ndax daily close ÷ (Kraken daily close × Kraken USD/CAD daily close) − 1), from Ndax's public daily candles and Kraken's public daily OHLC.
* **Executable entry premium:** Ndax buy-walk(C$33) ÷ global − 1 − m(d). **Executable exit premium:** Ndax sell-walk(C$33) ÷ global − 1 − m(d).
* **Opportunity (P1 threshold):** entry premium < −cost_coin.
  * Uses P1's frozen round-trip costs: BTC 0.90, ETH 0.78, XRP 0.88, LTC 1.10, DOGE 1.00, SOL 0.90 %.
  * Fees and spread are therefore counted conservatively: the spread is paid through ask and bid, *and* the threshold also includes it.
  * **It must persist in two consecutive samples ≥ 60 s apart** (latency). Entry is at the **second** sample's buy-walk price.
  * Opportunities that do not persist are counted as **"disappeared before execution"**.
* **Close:** the first later sample whose exit premium ≥ 0 (the gap has closed at the executable bid). Exit is at that sample's sell-walk. **Time stop:** 7 days, exiting at the sell-walk then.
* **Net return per event:** sell-walk ÷ buy-walk × (1 − 0.002)² − 1.
  * This includes the market move while holding: the account is long-only.
  * The **gap component** (exit premium − entry premium) is reported separately.
* **Independent events:** one open event per coin at a time (no overlapping events per coin).
* **Exclusions, counted and reported:**
  * **Stale:** Ndax best bid and ask unchanged for ≥ 10 minutes while the Kraken mid moved ≥ 0.3 %.
  * **Thin:** Ndax ask depth within 2 % of the best ask < C$33.
  * **Gap in collection:** more than 6 minutes between the two samples.
* **Also reported:**
  * the C$100 size;
  * **P1's original daily rule** with executable prices (signal at the 00:00 UTC daily close, execution at the first sample after 00:00 at buy-walk, exit next day after a close with deviation ≥ 0, ≤ 7 days). Few trades are expected; this is descriptive only.

## Criteria (applied once, at the end)

**P1 DESERVES A SEPARATE PROSPECTIVE PAPER TEST only if all of these hold:**
1. ≥ 15 independent events (all coins together).
2. Mean net return per event > 0, with the 90 % bootstrap CI lower bound > 0, at C$33.
3. Mean gap component > 0.40 % (the two fees). The gap itself, not the market move, must pay for the trade.
4. ≥ 50 % of events close before the time stop, with a median time to close ≤ 3 days.
5. Positive mean net return in ≥ 3 different coins.
6. Fewer than 50 % of the threshold crossings disappeared before execution.

**REJECT if any of these holds:**
* mean net return ≤ 0;
* fewer than 15 events;
* ≥ 50 % of crossings disappeared before execution;
* mean gap component ≤ 0.40 %.

**INCONCLUSIVE:** anything else.

**Either way:** no prospective PAPER test is launched automatically. A recommendation is made to the owner.

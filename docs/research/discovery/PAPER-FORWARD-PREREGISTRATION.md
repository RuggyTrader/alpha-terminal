# Pre-registration: forward PAPER test of P1 vs S3 at 25 % (2026-11-23)

Committed **before the first PAPER decision**. Research only.
* **No real orders.** Public market data only; PAPER accounts are local files. Production, the four bots and the running S3 shadow are untouched.
* **No guarantee.** Observed quotes do not guarantee real execution, and a few weeks of results do not predict future returns.

## Accounts (each starts at C$100; first decision 2026-11-24 00:00 UTC)

| Account | Rules |
|---|---|
| **P1-100** (primary) | P1 exactly as `PREREGISTRATION.md` (0d86edb), f = 100 % (the original test case) |
| P1-50 | the same, f = 50 % (the registered sensitivity) |
| **S3-25** (benchmark) | S3 frozen (200-day SMA × 40 % volatility target, BTC + ETH halves), weights × 0.25, band × 0.25 |

## Translation of the rules to live data (no changes to signals or thresholds)

* **P1 daily signal:**
  * the daily-close premium of day d−1, from public daily candles: Ndax `GetTickerHistory` close ÷ (Kraken `OHLC` close × Kraken USD/CAD close) − 1;
  * minus the median of the previous 30 daily premiums;
  * a signal if the deviation < −cost_coin (BTC 0.90, ETH 0.78, XRP 0.88, LTC 1.10, DOGE 1.00, SOL 0.90 %) **and** Ndax traded ≥ C$10,000 that day.
* **Execution ("next open"):** at the **first collected sample between 00:00 and 01:00 UTC**.
  * **Entry:** only if the *executable* deviation (Ndax buy price walking the asks for the order's notional ÷ global price − 1 − median) is still < −cost ÷ 2.
  * **Missed:** otherwise, or if no sample exists in that hour.
* **Exits:** flagged at the daily close when the deviation ≥ 0 or after 7 days. Sold at the first sample ≥ 00:00 UTC at the Ndax price walking the bids for the held quantity. If the PC was off, the exit happens at the first available sample.
* **Sizing:**
  * P1: notional = f × equity ÷ 3, at most 3 positions, one per coin, compounding; minimum C$1.
  * S3-25: target weights from Kraken daily candles, executed at Ndax walk prices.
* **Costs:** Ndax fee 0.20 % per side on notional. Spread and depth are paid through the book walk (measured live, not estimated). An order is **missed** if the book is too thin.
* **Marking:** at every 2-minute sample, holdings are valued at the Ndax liquidation price (walking the bids). Drawdown is from each account's equity high-water mark.

## Reports

Every review reports, for each account:
* equity and net return;
* returns over 1 day, 1 week and 2 weeks;
* trades, win rate, profit factor, fees;
* maximum drawdown;
* missed orders;
* collection coverage.

P1 is compared with S3-25.

## Decision criteria (fixed now)

* **Halt (any time):** an account whose drawdown reaches 15 % stops trading and closes its positions at the next sample.
* **Day-7 review (2026-11-30):** descriptive only. **P1 is stopped early** only if P1-100's drawdown ≥ 15 %, or if ≥ 5 trades have closed and every one lost money after costs.
* **Day-14 initial assessment (2026-12-07):** **STOP P1** if any of these holds:
  * (a) P1-100's net return ≤ max(0, S3-25's net return over the same days);
  * (b) P1-100's drawdown ≥ 15 %;
  * (c) the order-book study's executable events (pre-registered rules, C$33) number ≥ 10 with mean net ≤ 0;
  * (d) ≥ 50 % of threshold crossings disappeared before execution.

  **Otherwise:** CONTINUE observing to day 30, when the order-book study's own pre-registered criteria decide.
* **No "pass" is possible at day 14.** P1 historically traded about once a week, so 14 days cannot establish an edge.
* **Disclosure:** the interim (day 7 / 14) looks at the order-book study were requested by the owner. They are a deviation from that study's "applied once at the end" plan. Its day-30 criteria are unchanged.

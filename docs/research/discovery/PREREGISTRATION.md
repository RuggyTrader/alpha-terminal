# Discovery phase: pre-registration (2026-11-22)

Committed before any backtest. Research only.

## 1. Evidence review and feasibility

**Venue constraints (Ndax):** spot, long-only, no leverage. Round-trip cost ≈ 0.8–1.1 %: 2 × 0.20 % fee plus 2 × the measured C$50 book cost.

| Candidate inefficiency | Independent evidence | Feasibility | Decision |
|---|---|---|---|
| **Cross-exchange / cross-currency price gaps** (Ndax CAD price vs global USD price × USD/CAD) | Makarov & Schoar (2020, *JFE*): persistent, mean-reverting cross-exchange deviations, largest across countries, driven by local order flow and slow fiat arbitrage. The "kimchi premium" literature. | Development slice 2020–22: Ndax premium half-life 0.2–0.9 days; reversions after "cheap" days 1.1–1.7 % vs 0.8–1.1 % cost | **SHORTLISTED (P1)** |
| **Stablecoin CAD peg** (USDC/CAD vs USD/CAD) | Peg arbitrage; deviations driven by local flow | Reversion 0.85–0.97 % vs 0.83 % cost: break-even. USDT/CAD spread 4.2 %: impossible. | **SHORTLISTED (P2)**, low expectations |
| Hour-of-day / weekday seasonality | Mixed and unstable in the crypto literature | Expected edge per trade ≪ 0.9 % cost | rejected before testing |
| Macro-announcement drift (FOMC/CPI) | Equity evidence; weak and inconsistent for crypto | few events; edge ≪ cost | rejected before testing |
| Options-expiry / "max pain" | no credible independent evidence | — | rejected before testing |
| Funding, flows, stablecoin supply, sentiment | — | already rejected (round S) | not recycled |
| Trend, momentum, breakout, OTE, liquidation reversal | — | already rejected | not recycled |

**Main risk to P1/P2: measurement artefact.**
* Daily closes are last *trades*. A stale Ndax print near midnight looks like a "cheap" price that "reverts" with no executable opportunity.
* **Mitigation, built into the rules:** trade only at the **next** day's open. The gap must still exist at that price, measured against Kraken's open at the same timestamp. An hourly check with a 1-hour lag on the last year of Ndax hourly data (from 2025-11) tests execution realism.

## 2. Rules

**P1, Ndax cross-currency gap reversion (BTC, ETH, XRP, LTC, DOGE, SOL):**
* **Premium:** p(d) = Ndax CAD close / (Kraken USD close × Kraken USD/CAD close) − 1. **Deviation:** x(d) = p(d) − median of p over the previous 30 days.
* **Signal (at the close of day d):** x(d) < −cost_coin, **and** Ndax traded ≥ C$10,000 that day.
* **Execution:** at the Ndax **open of d+1**, *only if* the open-based deviation (Ndax open ÷ (Kraken open × USD/CAD open) − 1 − the same median) is still < −cost_coin ÷ 2. Otherwise the order is **missed**.
* **Fill and fee:** buy price = open × (1 + c_side); fee 0.20 %.
* **Exit:** at the Ndax open after the first close with x ≥ 0, or after 7 days (time stop). Sell price = open × (1 − c_side); fee 0.20 %.
* **Sizing:** up to 3 concurrent positions, each = f ÷ 3 of current equity (compounding), with f ∈ {50 %, 100 %} pre-registered. One position per coin. Ndax minimum orders apply.

**Measured costs** (Ndax books, 2026-11-22; applied to history = ESTIMATE):

| Coin | c_side | Round trip |
|---|---|---|
| BTC | 0.25 % (7-day study) | 0.90 % |
| ETH | 0.19 % | 0.78 % |
| XRP | 0.24 % | 0.88 % |
| LTC | 0.35 % | 1.10 % |
| DOGE | 0.30 % | 1.00 % |
| SOL | 0.25 % | 0.90 % |

**P2, USDC/CAD peg reversion:**
* The same rule on USDC/CAD alone, with the reference Kraken USDC/USD × USD/CAD.
* c_side 0.213 %, round trip 0.83 %; one position, f = 100 %.

**Drawdown:** daily equity, positions marked at the Ndax daily **low** for the worst point and the **high** for the high-water mark (worst-case intrabar order). This is the conservative candle bound; the hourly check reconstructs it.

## 3. Data and periods

* **Ndax:** public daily history (BTC/ETH from 2018-03, XRP/LTC from 2018-05, DOGE from 2019-01, SOL from 2021-12, USDC from 2021-10).
* **Kraken:** official archive (USD prices, USD/CAD from 2020-03-12).
* **Development:** 2020-03-12 → 2022-12-31. Used only for the descriptive feasibility screen; no backtest was run.
* **Confirmation (held out for these hypotheses):** **2023-01-01 → 2026-09-30**, when the Kraken archive ends. The prices were used by earlier, unrelated hypotheses, so this is not independent validation, but these signals have never been evaluated on it.
* **Hourly execution check:** 2025-11 → 2026-09.

## 4. Rejection criteria (confirmation period, f = 100 %; P1 and P2 separately)

**REJECT if any of these holds:**
1. Net annual return ≤ **7.4 %** (the S3 benchmark at 25 % size).
2. Maximum drawdown ≥ **15 %**.
3. Profit factor < 1.2.
4. Fewer than 30 trades.
5. The 90 % bootstrap CI of the mean net trade return includes 0.
6. **P1 only:** profitable in fewer than 4 of the 6 coins (each traded alone, same rules).
7. **Hourly check:** with a 1-hour execution lag, the mean net trade return is ≤ 0. This would indicate that the daily result is a stale-print artefact.

**A pass** makes the candidate eligible for **prospective PAPER testing** only. It is not proof of profitability.

**Reported:**
* net returns over 1 week, 2 weeks, 1 month, 3 months and 1 year (median, worst, best, share positive);
* win rate, profit factor, trade count, maximum drawdown, final balance;
* per coin and per market condition;
* f = 50 % as a sensitivity.

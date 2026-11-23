# Strategy-discovery phase: results (2026-11-22)

**Result: no candidate passed its pre-registered criteria. No strategy convincingly beats S3 after costs while meeting the requirements.**
* Pre-registration: `PREREGISTRATION.md` (commit `0d86edb`, before any backtest); runner `6b2a837`; run once.
* Results: `discovery-results.json`. Post-hoc diagnostics (cannot change verdicts): `diagnostics.json`.
* Research only; PAPER.

## Evidence and feasibility (before building)

| Idea | Why it might work (evidence) | Feasibility on Ndax ($100, spot, long-only) | Outcome |
|---|---|---|---|
| **P1 Ndax cross-currency gap reversion** | Makarov & Schoar (2020, *JFE*): cross-exchange, cross-currency price gaps persist and revert because fiat arbitrage is slow and local order flow pushes prices | Development 2020–22: gaps revert by 1.1–1.7 % vs 0.8–1.1 % round-trip cost | built and tested |
| **P2 USDC/CAD peg reversion** | Peg arbitrage | Development: reversion ≈ cost (break-even); USDT/CAD spread 4.2 % | built and tested (low expectations) |
| Seasonality, macro announcements, options expiry | weak or inconsistent evidence | edge ≪ 0.9 % cost | rejected before testing |
| Funding, flows, sentiment, trend, momentum, breakout, OTE, liquidation reversal | — | already rejected | not recycled |

**Data:**
* Ndax public daily history; Ndax hourly only from 2025-10.
* Kraken official archive.
* Costs: Ndax fee **0.20 % (VERIFIED)**; book cost per side **MEASURED 2026-11-22** (BTC 0.25, ETH 0.19, XRP 0.24, LTC 0.35, DOGE 0.30, SOL 0.25, USDC 0.21 %), applied to history = **ESTIMATE**.

## Results: confirmation period 2023-01-01 → 2026-09-30 (held out for these signals; prices reused), $100

| | Final | Net/yr | Max DD (peak equity, intraday) | Trades | Missed | Win rate | Profit factor | Mean trade (90 % CI) | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **P1, f = 100 % (the pre-registered test case)** | $367.18 | 41.5 % | **17.4 %** | 219 | 17 | 54.8 % | 2.09 | +1.97 % (+1.03 to +2.98) | **REJECT**: drawdown ≥ 15 % |
| P1, f = 50 % (registered sensitivity) | $198.12 | 20.0 % | 9.6 % | 219 | 17 | 54.8 % | 2.20 | +1.97 % | not the test case; see diagnostics |
| **P2 USDC/CAD** | $104.05 | 1.1 % | 8.9 % | 16 | 0 | 56 % | 2.14 | +0.25 % (−0.11 to +0.64) | **REJECT**: below S3, < 30 trades, CI includes 0 |
| *S3 benchmark, 25 % size (same window)* | *$130.88* | *7.4 %* | *6.7 %* | — | — | — | — | — | — |
| *S3 benchmark, 50 % size (same window)* | *$167.76* | *14.8 %* | *13.3 %* | — | — | — | — | — | — |

**P1 by coin (each alone, f = 100 %):**

| Coin | Net/yr | Max DD | Trades |
|---|---|---|---|
| BTC | 0.0 % | 4.2 % | 8 |
| ETH | 5.6 % | 11.0 % | 36 |
| XRP | 5.3 % | 10.7 % | 30 |
| LTC | 13.5 % | 8.9 % | 68 |
| DOGE | 6.5 % | **19.4 %** | 50 |
| SOL | 6.6 % | 8.0 % | 43 |

5 of 6 coins were profitable.

**P1 period returns (f = 100 % / f = 50 %), median and worst:**

| Period | f = 100 %: median / worst | f = 50 %: median / worst |
|---|---|---|
| 1 week | 0 / −7.5 % | 0 / −3.9 % |
| 2 weeks | 0 / −7.0 % | 0 / −3.5 % |
| 1 month | +1.0 / −7.9 % | +0.5 / −4.0 % |
| 3 months | +4.8 / −2.4 % | +2.5 / −1.1 % |
| 1 year | +53.2 / +1.4 % | +24.7 / +0.9 % |

The longest recovery was 661 days.

**Hourly execution check** (1-hour lag, 2025-11 → 2026-09):
* P1: mean trade +0.71 %, 389 trades, "150 %/yr". This passed the sign criterion.
* **Not credible.** The daily strategy earned only +1.4 % (2025) and +4.4 % (2026) in the same months. The hourly result most likely reflects thin-market hourly prints that cannot be executed at those prices; there is no order-book history to check.

## Post-hoc diagnostics (cannot change the verdicts)

* **The edge decayed.** P1 (f = 100 %) returned **+53 % in 2023 and +126 % in 2024, but +1.4 % in 2025 and +4.4 % in 2026.** In the most recent ~21 months it was **below S3** (S3 at 25 %: −1.2 % and +3.8 %; at 50 %: −2.4 % and +7.6 %).
* **The profit is concentrated.**
  * **The top 10 of 219 trades produced 86 % of the net profit** (top 5: 61 %).
  * **LTC produced 47 %**, and 26 of its 65 entries came on days with < C$25k traded on Ndax. Thin-market prints are the least reliable.
* **Cost sensitivity:** with spreads ×1.5 / ×2, drawdown rose to 19.4 % / 22.9 % at f = 100 %, and to 10.1 % / 12.1 % at f = 50 %.
* **Execution prices:** the daily open and close are last trades, not quotes. The open-price guard removes some stale signals (17 missed), but cannot prove the prices were executable.

## Ranking (short-term net profit, drawdown, strength of evidence)

1. **P1 Ndax gap reversion**
   * Highest historical net return, and the only candidate with an economic mechanism and a significant positive mean trade.
   * **Rejected** on its pre-registered test (drawdown 17.4 %).
   * The f = 50 % variant met the numbers (20 %/yr, DD 9.6 %), but its advantage came almost entirely from 2023–24 and ~10 trades, with a large share from thin LTC prints, and vanished in 2025–26.
   * **Evidence strength: weak to moderate.**
2. **P2 USDC/CAD peg reversion:** rejected; roughly break-even after costs.
3. **No other candidate passed feasibility.**

## Which strategy deserves further PAPER testing?

**None, on current evidence.**
* P1 is the only idea with a plausible mechanism. Its historical result fails the registered drawdown test, has decayed, and depends on prints whose executability cannot be verified.
* **If the owner wants to pursue it**, the honest next step is not a strategy run. It would be a **read-only forward collection of Ndax and Kraken order books** (as in the earlier 7-day study), to measure whether *executable* gaps of > 1 % still occur and revert.
  * That is a new live-data study and needs the owner's approval.
  * Choosing f = 50 % now would be a selection informed by the confirmation data.

## Disclosures

* **Prices reused:** Kraken prices were used by earlier hypotheses; Ndax daily prices were used in the cost study. The 2023–2026 period was held out only for these signals.
* **Selection:** the screen, the coin list and the costs were fixed before the test. The f = 50 % variant was pre-registered as a sensitivity, not as the test case.
* **Look-ahead:**
  * signals use closes up to d, and execution happens at d+1's open;
  * the 30-day median uses only earlier days;
  * Kraken's USD/CAD and USD prices come from the same UTC timestamps.
* **No independent validation exists.**

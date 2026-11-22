# Phase 3 report: audit of the strongest strategies, tests on genuinely new data, and shadow accounts (2026-11-22)

**Summary:**
* The calculations hold up.
* The strategies' edge does **not** carry over to markets never used to choose them, and they made almost nothing in
  the most recent 20 months.
* Three strategies met the 2 % requirement historically, and they are prepared as simulated $100 shadow accounts so
  they can be judged on market data that did not exist when they were chosen.
* **Nothing is deployed or claimed profitable.**

No parameter was changed in Phase 3: the strategies are frozen exactly as selected in DD2 (`candidates.mjs`).

## 1. Audit of calculations, data and execution realism

| Check | Result |
|---|---|
| Data integrity (Coinbase daily, 2015/16 → 2026-11) | No invalid OHLC, no off-grid times, no gaps except ETH's first week (2016-05, 2 days). The three moves > 40 % in a day are real events: 12 Mar 2020 (BTC, ETH) and 9 Nov 2022 (SOL, FTX) |
| Every fill of 4 strategies, 2016–2026 (681 entries; `engine/test/phase3-audit.test.mjs`) | All pass: entry and exit at the **next** open after the decision; price = open ± 0.05 %; stops at min(open, stop) − 0.10 %; fee = 0.40 % of notional; Kraken minimum and 1e-8 lot step; cash never negative; position ≤ 1/n of equity; risk at entry ≤ r %; stop = k × ATR |
| Look-ahead on real data | History truncated at 12 dates leaves every earlier result identical |
| Independent re-implementation (DD2) | Reproduces the winner exactly |
| Kraken vs Coinbase prices (713 common days) | Median daily-close difference 0.013 %, max 0.18 % |
| Same strategies on Kraken's own candles (2025-04 → 2026-11) | A: $100.23 vs $100.27 · C: $100.47 vs $101.05 · D: $100.83 vs $100.00 (practically equal) |
| Stop fills re-priced with hourly candles (158 stops since 2021) | No difference |
| Stop slippage 0.10 → 1.00 % | A: $119.27 → $113.85, drawdown 1.72 → **2.00 %** · B: $116.86 → $111.24, drawdown 1.38 → 1.81 % · C: $117.67 → $114.90, drawdown 1.79 → **2.03 %** |

**Observations:**
* Most exits are stop-loss fills (125 of 148 for A; 196 of 196 for D), so the results depend heavily on realistic stop
  execution.
* A and C reach the 2 % limit under severe stop slippage.

## 2. New evaluation: other markets never used for selection

**Setup:**
* The four frozen rules ran unchanged on **41 other coins** (Coinbase daily, 2017/2021 → 2026-11), with no choices
  involved.
* Rule A ran on each coin alone; B, C and D ran on fixed alphabetical triplets.
* Minimum order: today's Kraken minimum, about $5.

| Rule | At $100 (Kraken minimums bind) | At $10,000 (minimums do not bind; per $100) |
|---|---|---|
| A BTC momentum | 41 markets: median **1 trade**, ~0 %/yr; 8 profitable with DD < 2 % | median **−0.08 %/yr**, DD 2.8 %; 15 of 41 profitable; 1 of 41 meets both criteria |
| B 3-asset momentum 0.10 % | **no trades** on 13 triplets (all below minimums) | median −0.48 %/yr, DD 3.8 %; 0 of 13 meet both |
| C 55/10 breakout | median 1 trade; 7 of 13 profitable with DD < 2 % | median −0.20 %/yr, DD 3.7 %; 0 of 13 meet both |
| D 20/10 breakout | 3 of 13 meet both | median −0.23 %/yr, DD 5.7 %; 0 of 13 meet both |

**What the table shows:**
* On markets where the minimums do not bind, the rules have **no positive edge**: median slightly negative, drawdowns
  above 2 %.
* They did lose far less than holding those coins: median buy-and-hold ended at $7–14 per $100.
* At $100 the rules mostly cannot trade volatile coins at all: wide stops mean positions below the ~$5 minimum.
* **Interpretation:** the BTC/ETH/SOL results are probably specific to those assets and that history, not a general
  edge.

**The last 20 months, on Kraken data:**

| Strategy | Result |
|---|---|
| A | +$0.23 (9 trades) |
| B | 0 trades |
| C | +$0.47 (2 trades) |

## 3. Which strategies meet the 2 % requirement

| Strategy | 2016–2026 max DD | DD2 test (2023-07 → 2026-11) | Other markets | Verdict |
|---|---|---|---|---|
| **A** BTC 56-day momentum, 0.25 % risk | 1.72 % | +$2.57, DD 1.52 % | no edge | **Meets 2 % historically; fragile** (41 % reshuffle risk; 2.00 % at 1 % stop slippage) |
| **B** BTC+ETH+SOL 56-day momentum, 0.10 % risk | 1.38 % | +$1.93, DD 0.90 % | no edge | **Meets 2 % historically; most margin** (1.81 % at 1 % slippage); tiny return, often blocked by minimums |
| **C** BTC+ETH+SOL 55/10 breakout, 0.25 % risk | 1.79 % | +$5.58, DD 1.39 % | no edge | **Meets 2 % historically; thin margin** (2.03 % at 1 % slippage); few trades |
| **D** BTC+ETH+SOL 20/10 breakout, 0.25 % risk | **3.61 %** | +$9.71, DD 2.66 % | no edge | **Fails 2 %** (not proposed for a shadow) |
| S3 (running as a shadow) | ~40 % | +$61.62, DD 27.5 % | — | **Fails 2 %** |

## 4. Proposed shadow accounts (prepared, NOT deployed)

**What they are:**
* Three simulated $100 accounts for **A, B and C**, on branch `shadow/phase3`, built from the live Worker release.
* They use the same daily cron as S3 and run the **exact research code** (a verbatim port of the backtester; parity
  proven to the cent).
* New Kraken daily candles are stored as they complete.
* A market order fills at the open of the first 1-minute candle after it is accepted (never back-dated); stops are
  resting orders on the daily candle.
* Costs are 0.40 % fee + 0.05 % slippage (0.10 % on stops), with Kraken minimums.

**Automated daily report (about 00:03 UTC; one row and one `DAILY_REPORT` per account):**
* equity and net profit, maximum drawdown with a **2 % pass/fail flag**, fees, trades, skipped orders and open
  positions;
* benchmarks: cash, buy-and-hold of the same coins from activation, and the S3 shadow;
* rule violations: a 2 % breach is recorded once as `RULE_VIOLATION`; missing fill prices and data gaps are recorded.
* Shown in the dashboard's research page and at `GET /api/dashboard/shadows`.

**Safety:**
* Additive migration 0011: four `shadow_*` tables and three PROPOSED accounts.
* Nothing runs until migrated and activated (one read per minute until then).
* The runner writes only its own tables and its own three rows and events, and never touches bots, balances, positions,
  settings, the BTC trial or S3.

**Tests:**
* Port = research backtest on real candles.
* Live runner replay 2025-01 → 2026-11 = backtest of the same days.
* Fills use the recorded minute price.
* 2 % breach recorded once with the simulation continuing; isolation; lock; activation limited to the three accounts;
  additive migration.
* Dashboard panel and request shape.

**How to read them:**
* Weeks prove only that the mechanics work.
* Judging these rules needs **many months and dozens of trades**, because they trade rarely (A about 7 trades a year, C
  about 4).
* A shadow passing for a while is **not** proof of profit; one breaching 2 % is direct evidence against it.

## 5. Bottom line

* No strategy found so far is meaningfully profitable within a 2 % maximum drawdown on $100.
* The three that met 2 % historically earned about 1.5 % a year, show no edge on other markets, and sit close to the
  limit under realistic stop slippage.
* Forward shadow testing is the only remaining genuinely new evidence, so it is prepared for your approval.

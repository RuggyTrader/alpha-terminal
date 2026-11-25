# Jupiter Perps research report: Strategies A and B (PAPER), 2026-11-25

**Verdict: NONE QUALIFIES.**

Under the pre-registered rule, none of the 16 candidates (A and B, long/flat and long/short, at 1.1×, 2×, 3× and 5×) qualifies. Specifically:
* every candidate exceeds the 15 % drawdown limit in every development window;
* every candidate reaches the $75 account shutdown in 2022–26;
* none beats S3-25.

No candidate is promoted to PAPER trading. The PAPER engine and the Jupiter adapter were built and tested; they run in **observation mode** (no strategy).

PAPER research only:
* no wallet, keys, signing, transactions or live orders;
* nothing deployed, pushed or merged;
* the four bots, S3, P1, production configuration and databases are untouched.

## Disclosures

1. **Rule source.** No earlier pre-registration of "Strategy A / B" exists in this repository or in local records.
   * The rules come from the owner's specification of 2026-11-24.
   * Unspecified details are my own, fixed before any run: the exits, the ensemble averaging, the volatility sizing, B's sizing, the protective stop and the resize band.
   * Frozen config `jupiter-r11-v1a`, SHA-256 `0911358…d820a`.
   * Commits: pre-registration 2045a20, Amendment 1 268ec2c, engine 5bb910a, all before the first run.
2. **Reused data.** These families (trend and time-series momentum) were tested and rejected before (see `FAILED-CANDIDATES.md`). The DEV windows were used by earlier rounds. Passing on DEV data would not have been independent evidence.
3. **Substitute data.** Binance spot 1-hour candles stand in for Jupiter's oracle prices and are not Jupiter fills.
   * Today the Jupiter mark price is within 26–63 bps of the last Binance candle; most of that gap is the time since the candle closed.
   * Jupiter Perps launched in late 2023, so any execution before then is hypothetical.
4. **Costs: measured and assumed.**
   * **Read on-chain (2026-11-25):**
     * open/close fee 6 bps;
     * price-impact scalars;
     * 500× liquidation limit;
     * swap fee 10 bps plus a weight tax of up to 100 bps;
     * today's hourly borrow rates: longs about 12–13 %/yr, shorts (USDC) about 5.6 %/yr, **charged on the full position size**.
   * **Assumed:**
     * historical borrow rates (today's rate, or 2× for conservative costs);
     * keeper delay slippage (5 / 20 bps), request expiry (1 % / 5 %) and stop failure (2 % / 10 %);
     * stop slippage (10 / 50 bps);
     * open-interest imbalance fee (0 / 10 bps);
     * network fee ($0.02 / $0.10 per transaction).
5. **Venue facts used:**
   * minimum collateral $10;
   * **minimum leverage 1.1×**, so the requested 1× level was run at 1.1×;
   * liquidation takes **all** remaining collateral;
   * isolated margin per position;
   * long collateral is held in the asset token (hence the swap fee).

## Results

The generated tables are in `TABLES.md` (per candidate and window). Highlights from DEV-2 (2018-04..2026-09) under conservative costs:

| | Best CAGR | Lowest max drawdown | $75 shutdown |
|---|---|---|---|
| A, long/flat | 8.9 %/yr (L2), drawdown 78.5 % | 43.1 % (L3) | L3 and L5 shut down in early 2019 |
| A, long/short | all negative | 30.0 % (L1.1) | every level |
| B, long/flat | all negative | 32.8 % (L1.1) | every level, mostly in 2018 |
| B, long/short | all negative | 26.4 % (L1.1) | every level, in 2018 |

**Base costs look much better**, for example A long/flat at 2×: 33.4 %/yr. But drawdowns are 45–94 %, so the results depend heavily on the unknown historical borrow rates and execution costs.

**Borrow fees are the dominant cost.** For A long/flat at 1.1×, borrow was $75.69 of the $165 total costs. In longer high-leverage runs, borrow reached up to $4,498.

**DEV-3 (2022–26):**
* all 16 candidates reached the $75 shutdown (by 2022-11 at the latest);
* CAGR was −5.7 % to −6.5 %/yr.

**Rolling net returns** (no shutdown, DEV-2 conservative): the median 7-, 14-, 30- and 91-day return is 0 % or negative for every candidate.

| Horizon | Worst rolling return across candidates |
|---|---|
| 7 days | −12.6 % to −53.6 % |
| 91 days | −23.3 % to −73.3 % |

**Probability of falling 25 % within 91 days:** 0–47 %. Only two candidates are below 5 %, and both fail the drawdown criterion.

**$75 shutdown.** It triggered in 66 of 96 DEV runs. Equity fell as low as **$64.34**: the shutdown is a trigger, not a guaranteed loss limit. 44 runs ended below $75.

**Liquidations: 0.** The protective stops (440 fired, 22 failed and were retried) and the shutdown closed positions before liquidation. Liquidations were still modelled and are covered by tests.

**$10 minimum collateral.** It blocked 31,824 sizing decisions across the runs. At $100 split three ways, most partial-signal targets are too small for Jupiter.

**HOLDOUT** (2026-10-01..11-23, never used before; run once, after the DEV results were committed). BTC fell 29 %, ETH 38 % and SOL 42 % in this window.
* 6 of the 16 candidates reached the $75 shutdown.
* B long/short at 1.1× ended at $113.16 (drawdown 12.8 %) and at 2× at $121.70 (drawdown 22.3 %). This is a single crash regime, and by the pre-registered rule the holdout can only veto, not qualify.

## Why neither strategy is defensible here

* **Borrow on the full size.** About 12 %/yr for longs, on top of 0.12 % round-trip fees plus the swap fee, removes most of the trend premium these strategies earned in earlier tests.
* **Drawdowns.** Volatility-scaled exposure at 1.1–5× still produces 26–98 % drawdowns through 2018 and 2022. The $25 budget is used up in the first bear market.
* **Account size.** At $100, the $10 minimum collateral per position blocks most partial positions, and fixed network fees take a large share of the account.
* **Earlier evidence.** These families already failed out-of-sample replication on 10 coins (`futures/REPLICATION-REPORT.md`).

## Tests

* **Accounting tests (`engine/test/jupiter-backtest.test.mjs`, 14 tests):**
  * cost and liquidation math;
  * fee reservation before sizing;
  * minimum collateral and leverage, the leverage cap and the duplicate guard;
  * liquidation takes all collateral;
  * isolated margin;
  * realized-collateral allocation;
  * gaps, stops and stop failure;
  * borrow accrual;
  * shutdown overshoot below $75;
  * no martingale;
  * increase averaging;
  * strategies identical to an independent implementation;
  * sizing and rolling statistics.
* **PAPER tests (`engine/test/jupiter-paper.test.mjs`, 5 tests):**
  * the read-only network guard;
  * Perps API v2 request shapes and validation;
  * PAPER engine identical to the backtester;
  * restart recovery and rollback;
  * observation mode.
* **Full suite: 411 tests, 411 passed, 0 failed.**
* **On the real data:** strategy signals are bar-for-bar identical to the independent implementation (A: 19,787 / 13,287 bars; B: 660 / 452 decisions).
* **Ledger identities** hold to 1e-6 in every run.
* **Shared ledger refactor:** after it, the DEV and HOLDOUT results reproduce **byte-identical**.

**Defect found during testing and fixed before any run.** When two assets signalled in the same hour, both plans saw the full wallet. The second order was then rejected at execution. Cash committed to pending requests is now deducted before the next asset's plan.

## Changed / added files

All files are in the local research branch `research/futures`. Nothing was pushed.

**`engine/src/research/jupiter/`:**
* `config.frozen.json`
* `onchain.mjs` (read-only parameter reader)
* `fetch-binance.mjs`
* `costs.mjs`
* `strategies.mjs`
* `strategies-independent.mjs`
* `risk.mjs`
* `ledger.mjs`
* `backtest.mjs`
* `run-jupiter.mjs`
* `make-tables.mjs`
* `adapter.mjs`
* `store.mjs`
* `paper-engine.mjs`
* `dashboard.mjs`

**`engine/test/`:**
* `jupiter-backtest.test.mjs`
* `jupiter-paper.test.mjs`

**`docs/research/jupiter/`:**
* `PREREGISTRATION.md`
* `results-dev.json`
* `results-holdout.json`
* `TABLES.md`
* `REPORT.md`
* `ENGINE.md`

**`futures/perp.mjs` was left unchanged**, so earlier results stay reproducible. Its Jupiter-incompatible assumptions are documented above, and `backtest.mjs` supersedes it for Jupiter work.

## Remaining blockers before any real-money use

1. **No strategy qualifies.** That alone blocks promotion.
2. **Legal eligibility is unverified.**
   * Jupiter's terms exclude the US and sanctioned countries, not Canada.
   * They also forbid use that violates local law, and Ontario's position on leveraged perpetuals from an unregistered DeFi platform is unverified.
   * This needs legal advice.
3. **The official Perps API is labelled "work in progress".** The adapter mirrors the official CLI client (`perps-api.jup.ag/v2`, pre-v1 "early alpha"), and its request shapes may change.
4. **Historical borrow rates, keeper latency and failure rates are unknown.** They were assumed, and conservative costs change the results materially.
5. **Real execution would need a wallet, signing and an independent risk review.** All are out of scope and not implemented.

# Pre-registration: Strategies A and B on Jupiter Perps (PAPER research), 2026-11-25

Committed **before any backtest**. Research and PAPER only:
* no wallet, no keys, no signing, no transactions;
* nothing deployed;
* the four bots, S3, P1 and production are untouched.

**Frozen configuration:** `engine/src/research/jupiter/config.frozen.json`
* Canonical SHA-256 of the parsed JSON, re-serialized: **`4ba4df9a5a9d03ba8dae95b6a4db07c111e6794eb293c11c2429c400c098878e`**.
* The runner refuses any other configuration.

## Disclosures that apply to every result

1. **Source of the A/B rules.** I found no earlier pre-registration of "Strategy A (Donchian Trend Ensemble)" or "Strategy B (Time-Series Momentum)" in this repository, the research folders or local session records.
   * The rules below come from the owner's specification of 2026-11-24.
   * Details the owner did not supply are **my choices, fixed now and labelled as such**: channel exit length, ensemble averaging, the volatility-sizing formula, B's sizing, the protective stop and the resize band.
2. **These are previously rejected families, and the data are reused.**
   * Trend and momentum on BTC/ETH/SOL were tested and rejected before: H1/H2 trend did not replicate; 28-day momentum broke the 15 % limit; round 7 T1 4h Donchian and M1 were inconclusive.
   * All development windows were used by earlier price-based rounds.
   * The owner requested these strategies explicitly, for a new venue. A pass on DEV data would therefore **not** be independent evidence. The sealed holdout is only about 8 weeks.
3. **Data.** Binance spot 1-hour candles (BTCUSDT, ETHUSDT, SOLUSDT) are **substitute price data**. They are not Jupiter oracle prices and not Jupiter fills.
   * The USDT/USD basis is ignored.
   * Jupiter Perps only launched in late 2023, so any execution before then is hypothetical.
4. **Costs and the execution model.**
   * **Measured on-chain (read 2026-11-25):** the open/close fee (6 bps), the price-impact scalar, the 500× liquidation limit and today's hourly borrow rates. Borrow is charged on the **full position size**, about 12–13 %/yr for longs and 5.6 %/yr for shorts.
   * **Unknown, therefore assumed:** historical borrow rates (today's rate, or 2× for conservative), keeper delay and failure rates, and the open-interest imbalance fee.
5. **Venue facts that bind at $100:**
   * minimum collateral $10 per position;
   * minimum leverage 1.1× (so the 1× level is run at 1.1×);
   * liquidation takes **all** remaining collateral.
6. **Account shutdown.** The $75 equity shutdown triggers liquidation of the account's positions. It does **not** cap the loss at $25: gaps, failed stops and keeper delays can take equity below $75.

## Candidates

2 strategies × 2 variants (long/flat, long/short) × 4 leverage levels (1.1, 2, 3, 5) = **16 candidates**. Each is run under base and conservative costs in DEV-1, DEV-2 and DEV-3, plus per-asset runs and rolling-start analyses. The rules are given in full in the frozen configuration.

## Selection (fixed now)

* **Q1:** under conservative costs, in DEV-2 and DEV-3, the maximum drawdown is < 15 % and the $75 shutdown is never reached.
* **Q2:** under conservative costs, CAGR > 7.4 %/yr (S3-25's 2018-04..2026-09 result) in DEV-2, and > 0 in DEV-3.
* **Q3:** under conservative costs, zero liquidations in all three DEV windows.
* **Q4:** under conservative costs, in DEV-2, the probability of falling 25 % from any start day within 91 days is < 5 %.
* **Q5:** under conservative costs, in DEV-2, net positive on at least 2 of the 3 assets run alone.
* **Q6:** the HOLDOUT (2026-10-01..2026-11-23) is run once, after the DEV results are committed. A candidate is vetoed if it reaches the $75 shutdown or a drawdown ≥ 15 %. Q6 can veto but cannot qualify.

**Pick:** among the candidates passing Q1–Q5 and not vetoed by Q6, the one with the highest DEV-2 conservative CAGR. If none passes: **NONE QUALIFIES**, and no candidate is promoted to PAPER trading.

No parameter is tuned on any window. A failed candidate is not re-run with changed parameters.

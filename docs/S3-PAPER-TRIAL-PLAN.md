# S3 research-only forward SHADOW test (PREPARED, NOT ACTIVE, NOT DEPLOYED)

**Branch:** `trial/s3-paper` (local only), from the live Worker release (`9a3ac16` = Worker `03385dd2`).

**Status:** S3 is a research **candidate**, not an approved final strategy, and not shown to be profitable going forward.
The owner's 2 % drawdown objective stays in force. **No drawdown exception is approved** (in particular, not 30 %).

## What it is

A fully **simulated** $100 account (BTC $50 + ETH $50 sleeves) run by the Worker's existing every-minute cron with the
frozen S3 rule. It never reads or writes the production portfolio, any funded PAPER ledger, the bots, the mirror or the
0008 trial's rows. Nothing is sent to an exchange.

| Setting | Value |
|---|---|
| Strategy | S3-SMA200-VOL40 v1 (`worker/src/trial/s3.ts`, frozen `PARAMS`), daily at the UTC close, long only, no leverage |
| Target weight | 1{close > SMA(200)} × min(1, 0.40 / annualised 30-day realised volatility) |
| Re-sizing | corrected actual-weight band: when \|target − actual weight\| ≥ 0.10, or when entering or leaving |
| Fills | market order accepted at the close; fills at the open of the first Kraken candle **starting after acceptance** |
| Costs | 0.20 % fee per fill + 0.05 % slippage |
| Exchange rules | Kraken minimums (BTC 0.00006, ETH 0.002, cost ≥ $0.50); quantity floored to the lot step (1e-8); partial re-sizes below the minimum are **skipped and recorded**; a full exit always trades |
| Data | Kraken public OHLC (`krakenOhlc` + `validate`, now per pair) |
| Recorded | per asset and day: close, SMA, volatility, target, actual weight, cash, holdings, equity; per day: account equity, daily return, peak, drawdown; every order with its execution evidence (signal day, acceptance time, fill candle and interval, daily/candle open, fill price, raw and rounded quantity, fee, the minimums applied, skip reason, how late it was recorded) |
| Drawdown alerts | **2 %** (the owner's objective) and **30 %** (reporting threshold). **Alerts only**: recorded as events and shown in the report. **Neither is an approved trading risk limit, and neither stops or changes the simulation** |
| Outages | pending orders fill from Kraken history at the first candle after acceptance (coarser candles, recorded late); decisions from closes missed during an outage are recorded as MISSED, never back-dated |

## Implementation (smallest, reusing the existing trial infrastructure)

| Piece | File |
|---|---|
| Shared order sizing with lot rounding (`planOrder`), signal values (`signalAt`) | `worker/src/trial/s3.ts` (research parity unchanged) |
| Runner + read-only report | `worker/src/trial/s3_runner.ts` |
| Additive migration: 4 `trial_alloc_*` tables + one PROPOSED `trial_accounts` row | `worker/migrations/0010_s3_shadow.sql` |
| Cron call (no-op until migrated AND activated) | `worker/src/index.ts` |
| Report `GET /api/dashboard/trial/s3`; activation via the existing `/api/paper/trial-activate` with `account: "TRIAL-S3-SHADOW"` | `dashboard_api.ts`, `portfolio.ts`, `trial/report.ts` |

Reused unchanged: the cron, `trial_accounts` (status, lock, run log), `trial_events`, `krakenOhlc`/`validate`, the
outage interval selection, the one-time owner activation.

## Verification

`worker/test/trial_s3_shadow.test.mjs` drives the **real runner** through 2022-01 .. 2026-11 of real BTC/ETH daily
candles (≈ 1,780 days, minute-level clock) and requires:

1. **Research configuration:** every order (fill day, side, quantity, notional, skip), every daily equity mark, fees and
   final equity identical to the research backtest (golden file; the independent implementation reproduces the same
   backtest to the cent).
2. **Live configuration** (lot rounding + Kraken's own minimums): identical to the trial module's replay; within cents
   of the research backtest.
3. Account equity, daily returns, peak and drawdown; alerts (2 % fires, 30 % does not on this history; a TEST crash
   fires both and the simulation continues); outage catch-up without back-dating; data gaps; idleness; overlap lock;
   activation gating; complete table isolation; additive migration (`migrations.test.mjs`).

## Remaining before activation

1. Owner approval to apply migration 0010 to the production D1 and deploy the Worker containing the runner.
2. Owner activation (one passphrase action). The first decision is the first daily close after activation.
3. Optional, not built: a Trial-panel view of the S3 report (the JSON endpoint exists) and push notifications for the
   alerts (they are recorded and reported).

## How to read the results

* 2–4 weeks: proves the plumbing (every close processed, fills and fees reconcile, no unexplained skip). It says
  nothing about profitability, and S3 currently targets cash (both assets below their 200-day averages).
* ≥ 6–12 months: compare with the backtest range (2021–26: ≈ 13.7 % CAGR, 26 % max drawdown, Sharpe 0.6), with
  uncertainty, never as proof. Any proposal to relax the 2 % objective must come with a comparison of net returns,
  risk and realistic alternatives for the owner's approval.

# Pre-registration: market edge discovery — liquidations, open interest, volatility (2026-11-25)

Committed **before the data are downloaded and before any result is inspected**. Before writing this, I looked only at file formats: the column headers and a few rows of one Binance and one Bybit liquidation file for 2024-03-01.

Research only:
* no strategy is built or activated;
* no wallet or transactions;
* the four bots, S3, P1 (its forward study keeps running) and production are untouched.

The account rule for any later simulation: $100 PAPER, **$75 absolute shutdown** (not a trailing limit; it can be overshot). Peak-to-trough drawdown is reported as a diagnostic.

## Data (free, genuine, labelled)

| Dataset | Source | Granularity | Coverage | Known limitations |
|---|---|---|---|---|
| Liquidation orders, BTC/ETH/SOL USDT perpetuals | Tardis.dev free CSV (the first day of each month only), exchanges `binance-futures` (`forceOrder`) and `bybit` (`liquidation` / `allLiquidation`) | per order, microsecond timestamps; side `sell` = a long was liquidated, `buy` = a short was liquidated | the first day of each month, 2020-09-01 .. 2026-11-01 (SOL perpetuals from 2020-09) | **Not continuous** (about 1 day in 30). **Binance has reported at most the largest liquidation per symbol per second since 2021-04-27**, so its volumes are undercounts and the regime changes. OKX and BitMEX are excluded (OKX reports contracts that need conversion; BitMEX has no SOL); Bybit coverage may change with its feed versions. |
| Prices and volume | Binance USDT-M futures 1-minute klines (`data.binance.vision`, daily files) | 1 minute | each liquidation day and the following day (for 24 h forward returns) | Binance prices, not Jupiter oracle prices |
| Open interest | Binance USDT-M futures `metrics` (`data.binance.vision`): `sum_open_interest` (base) and `sum_open_interest_value` | 5 minutes | 2021-12 .. 2026-11 (as listed) | one venue; possible missing rows |
| Prices for H-OI | Binance USDT-M futures 5-minute klines (monthly files) | 5 minutes | the same period | |
| Prices for H-VOL | Binance spot 1-hour (already downloaded, SHA-256 in `jupiter/binance/MANIFEST.json`) | 1 hour | 2017-08 .. 2026-11 | spot, not perpetual |

**Data status.**
* All price data up to 2026-09-30 were used by earlier ALPHA TERMINAL rounds; **these are not unseen**.
* Hourly prices for 2026-10-01..11-23 were seen once (the Jupiter holdout, never used for selection).
* **The liquidation and open-interest data have never been used.** The relationship being tested is new, but the price paths are reused.
* Genuinely unseen data can only come from forward collection.

## H-L: liquidation cascades (Phase 1, primary)

**Liquidation intensity.** For each symbol: per-minute liquidation notional in USD (price × amount), summed over Binance and Bybit, per side:
* **long liquidations** (forced sells);
* **short liquidations** (forced buys).

`LQ(t)` is the sum over the 5 minutes [t − 5 min, t).

**Event.** `LQ(t)` for one side is ≥ the **99.5th percentile** of all 5-minute windows of that symbol and side on **earlier** liquidation days only (an expanding window, so the threshold is known in real time).
* **Burn-in:** the first 6 liquidation days of each symbol give the initial distribution and are excluded.
* **Declustering:** after an event, no new event on the same side for 60 minutes.
* **Clusters:** events within 4 hours of each other form one cluster, and inference uses clusters (days).

**Entry timing.** The event becomes observable at t (the end of the window). Allowing **1 minute** of feed and decision latency, the entry reference is the **open of minute t + 1**.

**Forward returns** from that open to the close at +5 min, 15 min, 1 h, 4 h and 24 h. They are direction-normalized so that positive = **rebound**:
* long-liquidation events: the raw return;
* short-liquidation events: −1 × the raw return.

**Also measured:**
* the maximum favourable and adverse excursion over 1 h and 4 h;
* the minutes until half of the preceding 15-minute move is retraced (rebound timing);
* the share of rebounds vs continuations;
* results per asset, per side, and per half (2020-09..2023-06 / 2023-07..2026-09).

**Controls (matched).** For every event, up to 5 control minutes from the **same symbol's liquidation days**, drawn from minutes with:
* `LQ` below its median;
* no event within ±2 h;
* the same UTC hour (±1);
* the same decile of the preceding 15-minute return (signed in the event's direction);
* the same decile of the preceding 60-minute realized volatility.

Controls use the same entry and horizon rules. **Effect** = event return − mean of its matched controls.

**Inference.**
* Day-clustered bootstrap (2,000 resamples) 95 % intervals for the mean effect.
* A one-sample t-test on the per-day mean effects.
* Holm–Bonferroni correction across the **30 primary tests** (3 assets × 2 sides × 5 horizons), α = 0.05.

**Economic test.** The direction-normalized mean effect must exceed a Jupiter round-trip cost:
* **optimistic:** 15 bps (6 + 6 bps fees, small slippage);
* **baseline:** 30 bps (plus keeper delay, slippage and network);
* **conservative:** 60 bps (plus a worse delay, the long-collateral swap fee and imbalance fees).

Borrow is negligible at ≤ 24 h (about 3 bps per day for longs).

**H-L is tradeable only if all of these hold:**
1. Holm-significant;
2. mean effect > 30 bps (baseline cost) at the same horizon;
3. the same sign on at least 2 of 3 assets;
4. the same sign in both halves.

Otherwise the result is "not tradeable" (significant but too small) or "rejected" (not significant).

**A positive H-L-rebound result is a negative H-L-continuation result and vice versa.** Both are reported from the same sign test, and neither is assumed.

**Sensitivity (reported, never used to select):**
* the 99th and 99.9th percentiles;
* 1-minute and 15-minute windows;
* entry delays of 3 and 5 minutes;
* Binance-only and Bybit-only liquidations;
* before and after the 2021-04-27 Binance reporting change.

## H-OI: open-interest divergence (Phase 2; run only if H-L is not tradeable, but registered now)

* **Data:** Binance 5-minute OI and klines, 2021-12 .. 2026-09.
* **Strong move:** at each 1-hour boundary, the 1-hour return is > 2 × its trailing 30-day standard deviation (hourly), in either direction. ΔOI is the change in `sum_open_interest` over the same hour.
* **Groups:**
  * move up + OI up ("new longs");
  * move up + OI down ("short covering");
  * move down + OI up ("new shorts");
  * move down + OI down ("long closing / liquidation").
* **OI cut-off:** "up" / "down" means |ΔOI| > 0.5 % of OI; smaller changes form a neutral group.
* **Entry:** the next 5-minute open after the hour (OI is published every 5 minutes, so this allows 5 minutes of latency).
* **Forward returns:** 1 h, 4 h and 24 h, direction-normalized (positive = continuation of the move).
* **Comparison:** each group vs the strong moves with neutral ΔOI, matched on hour of day and volatility decile.
* **Inference:** the same as H-L, Holm across 3 assets × 4 groups × 3 horizons = 36 tests.
* **Tradeable:** the same four conditions, with the bar > 30 bps.

## H-VOL: extreme volatility expansions (Phase 2)

* **Data:** Binance spot 1-hour, 2018-01 .. 2026-09.
* **Event:** an hour whose high–low range is ≥ 4 × the median hourly range of the previous 7 days; at most one event per 24 h per asset.
* **Direction:** the sign of that hour's close − open.
* **Entry:** the next hour's open.
* **Forward returns:** 1 h, 4 h and 24 h, direction-normalized (positive = continuation).
* **Controls:** hours with range ≤ 1.5 × the trailing median, matched on hour of day and the sign/decile of the hour's return.
* **Inference:** Holm across 3 assets × 3 horizons = 9 tests.
* **Tradeable:** the same four conditions.

## Discipline

* One run per registered test. Sensitivity variants are reported in full, never used to choose.
* Every hypothesis and variant goes into `docs/research/edge/LEDGER.md`.
* No trading rule is built unless a hypothesis meets its tradeable condition. Even then, it needs the owner's separate approval, and new (forward) data for validation.

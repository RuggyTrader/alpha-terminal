# Research ledger: market edge discovery (started 2026-11-25)

Every hypothesis, variant and decision, in order. Pre-registration: `PREREGISTRATION.md` (d750dda). Code was committed before each real-data run: d1afe36 (H-L), 1b151a8 (H-OI, H-VOL).

| # | Date | Item | Status | Notes |
|---|---|---|---|---|
| 1 | 2026-11-25 | Data availability check | done | **Binance historical liquidation snapshots:** no longer published (empty folder). **Tardis:** liquidation CSVs free on the first day of each month only (Binance futures `forceOrder` since 2019-11; Bybit; OKX; BitMEX). **Binance OI metrics:** 5-minute, from 2021-12. **Coinalyze / Coinglass:** need an account or payment (not used). |
| 2 | 2026-11-25 | Pre-registration H-L, H-OI, H-VOL | committed | Only file formats were inspected beforehand. |
| 3 | 2026-11-25 | Engine audit | done | `ENGINE-AUDIT.md`: hourly clock, borrow per call, keeper delay as price, hourly stops. An extension is deferred until an effect exists. |
| 4 | 2026-11-25 | Test fixtures corrected | done | Three test-fixture mistakes (flat baselines; same-hour events) were fixed. Two code bugs were found by tests and fixed **before** any real-data run: the hour-matching window and the half-retrace target. The control pool was changed to all liquidation days, as written in the pre-registration (the burn-in applies to events only). |
| 5 | 2026-11-25 | **H-L liquidation cascades** (688 events, BTC/ETH/SOL, Binance + Bybit, 75 first-of-month days 2020-09..2026-11) | **REJECTED** | **0 of 30 Holm-significant** (minimum adjusted p = 0.44). Raw direction-normalized means are −21 to +18 bps at 5 min–4 h (worst-case MFE/MAE about ±50–120 bps at 1 h), far below the 30 bps baseline cost; no consistent rebound or continuation. Sensitivity variants (99 / 99.9 %, 1 / 15-minute windows, 3 / 5-minute delays, each exchange alone, before / after the Binance change) are all below 25 bps raw. **Noted, not tradeable:** after short liquidations, 4 h returns are about +30 bps relative to matched controls in most variants, but the event's raw return is about 0 (the controls drift up), so there is nothing to trade, and it is not significant. |

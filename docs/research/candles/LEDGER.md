# Ledger: historical candle strategy discovery (2026-11-26)

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Pre-registration (28cfce0) | committed | 10 events × 4 TF × 3 assets × 3 horizons; matched controls; Holm; 4 screening conditions; walk-forward rules. No other thresholds tried. |
| 2 | Data assembly | done | **First pass:** blank-line parsing created a t = 0 row (fixed), and two SOL gaps were found (filled from Binance daily files). **Final:** 0 gaps, 0 duplicates, 0 bad OHLC (`VALIDATION.json`). |
| 3 | Engine tests | done | 6 tests, including **no false discovery on a random walk**. One test expectation was corrected: declustering legitimately suppresses a planted event within 12 bars of a natural one. |
| 4 | Screening run (c36eacd, one run) | **0 PASS** | Primary: 348 tests, 70 Holm-significant, 37 above 30 bps, **0 meeting all four conditions**. Regime: 1,005 tests, 109 Holm-significant, 0 also above cost. Every cell is in `screen-results.json`; tables in `TABLES.md`. |
| 5 | Backtests (walk-forward, Jupiter) | **not run** | No candidate passed, as pre-registered. |
| 6 | Post-hoc observation | **recorded, not promoted** | +3σ 1h up bars **continue** for 12 h: BTC +32, ETH +50, SOL +63 bps, positive in all periods. The direction was flipped after seeing the data, so it is a new hypothesis that needs out-of-sample replication. |
| 7 | 2026-11-27 | **Owner-requested exploratory test:** $10 collateral at 10×, +100 % take profit, liquidation at about −9.6 %, max 7 days, one trade at a time; fixed $10 and 10 %-of-equity sizing; signals continuation, reversion, random long, random coin flip | **does not reach $10 / week** | **Best:** SOL / ETH continuation at **base** costs, $100 → $264 / $251 over about 6 years (+$0.54 per trade, about 0.8 trades a week ≈ $0.43 / week), with a 35–62 % drawdown and the $75 shutdown hit (SOL). **Conservative costs:** every variant loses, mostly ruined. Win rates 48–54 % vs about 50–51 % needed. **10 % compounding sizing was worse than fixed $10.** The signals are in-sample / post-hoc, so this is not a candidate. |

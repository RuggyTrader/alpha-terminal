# Pre-registration: round S, stage 2: held-out confirmation of the three near-miss signals (2026-11-22)

Written after the development screen (`screen-results.json`, commit of this file), **before any data from the evaluation period was read** for these signals.

**The stage-1 verdict stands:** no signal passed the screen. Stage 2 is a new, separately registered test. It does **not** convert stage 1 into a pass.

## Why

The screen was deliberately strict (99 % CI on 2019/2016–2021 data). Three signals had the expected sign and large quintile spreads, but CIs that included 0:
* **S4** Coinbase premium: IC +0.157, t 2.2;
* **S1** funding: IC −0.169, t −1.7;
* **S3** stablecoin growth: IC +0.090, t 1.5 on BTC; IC +0.172, t 2.9 on ETH.

The evaluation period (2022-01-01 → 2026-09-30) has never been used for these signals. It is a genuinely held-out test of the *signal–return relationship*. Price data in it was used by earlier, price-based hypotheses.

## Test (identical definitions to stage 1; code `screen.mjs` with the period switched)

* **Signals:** S1, S3, S4, exactly as defined in `PREREGISTRATION.md`. No change to windows, sources or signs.
* **Samples:** weekly non-overlapping decision days in the evaluation period; forward 7-day returns ending ≤ 2026-09-30.
* **Statistics:** Spearman IC, block-bootstrap CI (blocks of 4, 5,000 resamples, same seed), quintile means.

## Criteria

* **CONFIRMED:** on BTC, the 99.67 % CI (Bonferroni 0.01 / 3) excludes 0 with the expected sign; **and** ETH's IC has the expected sign.
* **SUPPORTIVE:** the 95 % CI excludes 0 with the expected sign. This is reported, but it is **not** enough to proceed.
* **Only a CONFIRMED signal** moves to a pre-registered trading-rule test. That test includes the official 2 % drawdown, both as the conservative candle bound and reconstructed from time-ordered 5-minute data, plus costs, minimums and comparison with B, S3 and cash.
* If none is confirmed, the round ends with that result.

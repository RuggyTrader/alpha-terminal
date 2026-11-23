# S3 at smaller predetermined sizes under the owner's 15 % maximum-drawdown limit (2026-11-22)

**Result: one tested size, 25 %, passes the predeclared test.** Drawdown < 15 % and ≥ 5 %/yr in both windows, under both Ndax cost sets.

**Method:**
* Signals unchanged. Six sizes were fixed before the run (runner `engine/src/research/s3/s3-sizes.mjs`, commit `6d8caad`). Results: `s3-sizes-results.json`.
* **Limit used:** the owner set 15 % for this S3 test. The earlier official 2 % spot limit and its results remain documented.

## Results, $100 start, Ndax measured costs (0.20 % fee VERIFIED; spread MEASURED 2026-11-22, applied to history = ESTIMATE)

| Size of S3 | 2016-07 → 2026-09: final, net/yr | 2018-04 → 2026-09: final, net/yr | Max drawdown (official, candle; 5-min) | Sharpe 2016 / 2018 | Calmar 2016 / 2018 | < 15 % | ≥ 5 %/yr both |
|---|---|---|---|---|---|---|---|
| 100 % | $5,142.74, 46.9 % | $894.81, 29.4 % | 43.7 % (43.6 %) | 1.44 / 1.05 | 1.07 / 0.67 | ✘ | ✔ |
| 75 % | $2,101.73, 34.6 % | $546.15, 22.1 % | 35.9 % | 1.44 / 1.04 | 0.96 / 0.62 | ✘ | ✔ |
| 50 % | $803.44, 22.5 % | $316.49, 14.5 % | 25.3 % | 1.44 / 1.03 | 0.89 / 0.57 | ✘ | ✔ |
| 35 % | $434.57, 15.4 % | $230.02, 10.3 % | 17.9 % | 1.43 / 1.04 | 0.86 / 0.58 | ✘ | ✔ |
| **25 %** | **$291.02, 11.0 %** | **$182.96, 7.4 %** | **13.1 % (13.0 %)** | 1.44 / 1.04 | 0.84 / 0.56 | **✔** | **✔** |
| 15 % | $190.71, 6.5 % | $144.50, 4.4 % | 8.0 % | 1.44 / 1.04 | 0.81 / 0.55 | ✔ (also < 10 %) | ✘ (2018 window) |

**Notes on the table:**
* **Conservative Ndax costs:** 25 % gives 10.7 % and 7.3 %/yr with DD 13.3 %. This also passes.
* **Fees:** at 25 %, $3.76 over 2018–26.
* **Order sizes:** positions are ~$1–$13 per coin, above Ndax's ~$1 minimums (Kraken's ~$5 minimums would block many orders).

## Best risk-adjusted result per size

* **Sharpe:** essentially the same for every size (~1.44 in 2016–26, ~1.04 in 2018–26). Scaling down does not improve the edge; it only reduces both return and drawdown.
* **Calmar:** slightly higher at larger sizes.
* **Best compliant version:** 25 %, the largest tested size under 15 %.

## Caveats

1. **Little headroom.**
   * The 13.1 % historical drawdown sits close to the 15 % limit.
   * Earlier frontier research found realised out-of-sample drawdowns of 1.1–1.8× the in-sample figure.
   * At 1.5×, the 25 % version would reach ~20 % and breach the limit. The 15 % size (DD 8 %) has more headroom, but earns ~4–6.5 %/yr.
2. **In-sample selection, reused data.** The sizes were predetermined, but picking 25 % uses the same history that produced the drawdowns. S3 itself was selected on 2016–2021, and every period has been examined before. **This is not independent evidence.**
3. **Cost estimate.** The Ndax spread comes from one stressed week. Ndax's thin 2018–2020 market was probably costlier; the conservative set covers this partly.
4. **Concentration.** Returns come from bull markets; bear, crash and sideways periods lose. The 2016–26 figure includes the exceptional 2017 boom. The 2018–26 window (7.4 %/yr) is the more relevant one.
5. **Shadow unchanged.** The running S3 shadow is full size with 0.20 % + 0.05 % costs. It was not changed.

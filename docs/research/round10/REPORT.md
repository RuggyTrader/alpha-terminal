# Round 10 report: drawdown-budget strategies under the 15 % limit (2026-11-23)

* **Pre-registration:** `PREREGISTRATION.md` (ebc43ce).
* **Code:** 0206bce, committed before the single run.
* **Results:** `round10-results.json`.

Research only. These are historical simulations with estimated costs; they do not predict future returns. P1's forward PAPER study, S3, the four bots and production are unchanged.

## Verdicts (pre-registered rule, applied once)

| Candidate | DD < 15 % everywhere | Beats S3-25 in development | Holdout-1 > 0 and > S3-25 | Verdict |
|---|---|---|---|---|
| N1 constant mix 7 % | yes (worst 12.4 %) | **no** (5.9 / 3.8 %/yr vs 11.0 / 7.4) | **no** (2.6 vs 5.8) | **REJECTED** |
| N2 drawdown-floor buy-and-hold, D 15 % | **no** (15.09 %) | **no** (−0.1 %/yr in 2018–26) | **no** | **REJECTED** |
| N2 drawdown-floor buy-and-hold, D 10 % | yes | **no** (≈ 0 %/yr) | **no** | **REJECTED** |
| N3 drawdown-floor S3, D 15 % | yes (worst 13.7 %) | **no** (10.6 / 6.5 vs 11.0 / 7.4) | **no** (4.1 vs 5.8) | **REJECTED** |
| N3 drawdown-floor S3, D 10 % | yes, **< 10 % everywhere** (worst 8.9 %) | **no** (7.0 / 4.4) | **no** (2.7) | **REJECTED** |

## Main results (Ndax measured costs: 0.20 % fee + 0.25 % BTC / 0.19 % ETH spread per side)

**CAGR % / maximum official drawdown %.** Development data are reused; HOLDOUT-1 was never used before.

| Strategy | DEV-A 2016–26 BTC+ETH | DEV-B 2018–26 BTC+ETH | HOLDOUT-1 2014–16 BTC | HOLDOUT-2 2018–26 LTC+XRP |
|---|---|---|---|---|
| **S3-25 (benchmark)** | **11.0 / 13.1** | **7.4 / 13.1** | **5.8 / 10.6** | 2.8 / 13.9 (conservative costs: 15.8) |
| S3-30 | 13.2 / 15.5 | 8.9 / 15.5 | 6.9 / 12.6 | 3.2 / 16.5 |
| Buy-and-hold | 74.3 / 89.8 | 33.9 / 82.0 | 19.3 / 74.2 | 11.7 / 86.0 |
| N1 | 5.9 / 12.3 | 3.8 / 10.0 | 2.6 / 8.1 | 3.1 / 9.6 |
| N2 D15 | 9.2 / 15.0 | −0.1 / 15.0 | 1.8 / 14.3 | −0.2 / 15.1 |
| N3 D15 | 10.6 / 10.9 | 6.5 / 10.8 | 4.1 / 10.0 | 1.7 / 13.3 |
| N3 D10 | 7.0 / 7.3 | 4.4 / 7.3 | 2.7 / 6.6 | 1.0 / 8.8 |

**The 5-minute time-ordered drawdown agrees within 0.1 pp for every BTC/ETH row,** except N2, where the candle bound is more conservative.

**Conservative costs** cut S3-25 by 0.1–0.8 pp a year and change no verdict.

## Why the overlays failed

* **N2: cash lock.** After the 2018 crash, buy-and-hold equity fell to the floor. The cushion went to zero, the exposure went to zero, and the account sat in cash for the rest of the window (≈ 0 %/yr). This is the known weakness of portfolio insurance with a ratcheting floor.
* **N3** cut S3's drawdown (13.1 → 10.8 %) but also its return. It is slightly better per unit of drawdown (DEV-A return/DD 0.98 vs 0.84). However, it lost to S3-25 on return in every window, including the holdout, and to S3-30. The overlay de-risks after losses, and crypto's recoveries are fast, so it is underexposed when the recovery comes.
* **N1** earns the diversification return, but at the 7 % weight a 15 % limit allows, the return is only 3–6 %/yr.

## Short-horizon returns: what the 15 % limit allows

These are rolling net returns of **S3-25**, DEV-B 2018–26.

| Horizon | Median | 5th percentile | Worst | Best |
|---|---|---|---|---|
| 1 week | 0.0 % | −1.4 % | −4.4 % | +6.7 % |
| 2 weeks | 0.0 % | −1.9 % | −5.2 % | +8.7 % |
| 1 month | 0.0 % | −2.6 % | −7.0 % | +12.0 % |
| 3 months | 0.0 % | −4.2 % | −6.9 % | +23.3 % |

* **The median is 0 because S3 is in cash about 42 % of days.** Its gains come in a few trending months.
* **Calendar years:** −0.6, +6.0, +22.7, +9.2, −0.9, +11.9, +14.1, −1.2 and +3.8 % (2018–2026).
* **Holdout-1** (never used): −3.7 % (2014), +5.3 % (2015), +11.5 % (2016, to June).

## The new finding: S3-25 on genuinely unused data

* **HOLDOUT-1** (BTC 2014-05..2016-06) is the first test of S3's frozen rules on data that played no part in choosing them. Because ETH lacks history there, it is a BTC-only S3 at 25 %.
* **Result:** +5.8 %/yr (conservative 5.0 %), maximum drawdown 10.6 % (11.2 %), 43 orders. That window includes the 2014–15 bear market, in which BTC fell about 60 % more, and a long sideways period.
* **What it shows:** S3-25 did not break on unseen data.
* **What it does not show:** a strong edge. Buy-and-hold made 19 %/yr in that window with a 74 % drawdown. S3-25 kept about a third of the return for a seventh of the risk.

## Excluded before testing

* **CTREND cross-sectional trend factor:** it needs long–short across a broad coin universe; Ndax is long-only with about six liquid coins; a 2026 replication reports negative net returns after corrections.
* **Intraday momentum:** basis-point edge, far below the ~0.9 % round trip.
* **Options volatility premium:** not available at $100.

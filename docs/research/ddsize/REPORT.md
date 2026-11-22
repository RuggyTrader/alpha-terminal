# H-G1 report: optimal drawdown-budget sizing of S3, and the drawdown-efficiency bound (2026-11-22)

**Verdict: H-G1 is compliant but too small.**
* It meets 2 %, but earns 0.65 %/yr: below the "meaningful" bar, and below strategy A.
* Pre-registered in `PREREGISTRATION.md` (commit `feb29cb`); run once.
* Research only.

## Results (Ndax costs 0.20 % + 0.25 %, $1 minimum; Kraken daily prices; 2018-04 → 2026-09; $100)

| Multiplier m | Final | Net/yr | Strict max DD | Orders | Note |
|---|---|---|---|---|---|
| 1 | $100.00 | 0.00 % | 0 % | 0 | every order below the $1 minimum (~2 % exposure) |
| 2 | **$105.66** | **0.65 %** | 1.30 % | 15 | compliant |
| 3 | $101.27 | 0.15 % | 1.39 % | 19 | compliant |
| *S3 unscaled (same simulator)* | *$820.50* | *28.1 %* | *40.8 %* | 204 | independently reproduces S3 within ~1 pp/yr of the main backtester |

**Exploratory only (`explore-hg2.mjs`; chosen after seeing the above, so NOT evidence).** m = 9.5, taken from S3's design (a 5-σ day at its 40 % volatility target):
* $106.95 (0.79 %/yr), but max DD **2.23 %**: it breaches the limit.
* After 2022 it **never trades again**.

## The key finding: "cash lock" under a hard trailing 2 % limit

A hard limit measured from the running peak means:
* once the account has lost ~2 % from its peak, **any** new position could breach the limit;
* so a compliant policy must stop taking risk until a new peak is made;
* but a new peak cannot be made without taking risk.

The optimal policy (Grossman–Zhou) approaches the floor asymptotically and then effectively sits in cash. Our runs show exactly this.

**Drawdown-efficiency table** (`efficiency.json`). Each strategy is at its native size, with Ndax costs, 2018-04 → 2026-09. "μ/G" is annual return ÷ worst single day.

| Stream | Annual return | Worst day | μ/G | Rough upper bound at 2 % DD |
|---|---|---|---|---|
| S3 | 29.2 % | 8.97 % | 3.26 | ~6.5 %/yr |
| A BTC momentum | 1.4 % | 0.64 % | 2.25 | ~4.5 %/yr |
| B 3-asset momentum | 1.4 % | 0.66 % | 2.08 | ~4.2 %/yr |
| D 20/10 breakout | 3.1 % | 1.55 % | 2.02 | ~4.0 %/yr |
| C 55/10 breakout | 1.8 % | 1.55 % | 1.16 | ~2.3 %/yr |
| BTC buy-and-hold | 34.1 % | 41.2 % | 0.83 | ~1.7 %/yr |
| ETH buy-and-hold | 25.4 % | 63.8 % | 0.40 | ~0.8 %/yr |

**The bound is optimistic:** it ignores cash lock and minimum orders. Realized results at 2 % are 0.6–1.4 %/yr for every stream tested.

**A new hypothesis can only reach meaningful profit at 2 % if:**
* its return-to-worst-day ratio is **much higher (≳ 5–10)**; and
* its losses do not cluster, which avoids cash lock.

In practice that means **hedged or market-neutral** return streams, not directional spot exposure.

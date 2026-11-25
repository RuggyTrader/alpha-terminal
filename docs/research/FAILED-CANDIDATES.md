# Register of failed and unproven candidates (kept to prevent selective reporting)

Every candidate tested is listed here with the reason it was not adopted. Figures use $20 (round 1) or $100 (round 2) PAPER-equivalent capital, after the stated costs. Full data is in the referenced files.

## Round 1 (2026-11-15): original OTE strategies on 1m/5m, Aug–Nov 2026

Source: `docs/research/2026-11-15/`.

| Candidate | Out-of-sample net @0.20% (all bots) | Verdict |
|---|---|---|
| Original four OTE strategies | −40.80 (987 trades) | loses in every regime; ALPHA-01 loses even before fees |
| Fee-aware filter minNetRR 0.5 / 1.0 / 1.5 / 2.0 | −20.37 / −10.43 / −4.28 / −1.77 | fewer trades, still negative expectancy |
| minNetRR 1.0 + 0.05% slippage | −9.36 | negative |
| Fewer setups (minScore 2), alone / with minNetRR 1.0 | −28.29 / −6.19 | negative |
| Wider targets: 100% / 161.8% / 161.8% + minNetRR | −38.96 / −37.82 / −31.73 | negative |
| EMA-200 trend filter, alone / with minNetRR 1.0 | −26.28 / −6.07 | negative |
| ATR ≥ 0.25% (5m bots) | −1.72 | negative |
| 15m / 30m / 60m OTE (two bots each), with and without minNetRR | −6.97 … −0.66 | negative, or too few trades |
| 60m + EMA-200 + minNetRR 1.0 | +0.03 on 8 trades | too few trades; negative in development |

## Round 2 (2026-11-15): higher-timeframe families, BTC/SOL 2021–2026

Source: `docs/research/2026-11-15-round2/`. Costs: 0.20% + 0.05% slippage.

### Settings that passed validation

| Candidate | Final-test net | Trades | Verdict |
|---|---|---|---|
| SOL 4h Donchian 20, long only | −20.66 | 54 | failed the final test |
| BTC 4h Donchian 100, long only | −7.97 | 20 | failed the final test |
| BTC 4h MA-200, long only | −9.23 | 82 | failed the final test |
| BTC 4h EMA 20/50, long only | −0.66 | 37 | failed the final test |
| BTC 4h pullback, long only | +0.02 | 8 | break-even; too few trades |
| BTC 4h pullback, LONG+SHORT | +6.87 / **−1.09 with short borrowing** | 13 | fails once realistic borrowing is charged |
| SOL 1d pullback, LONG+SHORT | +7.69 / +4.59 with borrowing | 7 | too few trades; profit almost entirely from shorts |
| BTC 1d Donchian 20, long only | −2.88 | 9 | failed the final test |
| BTC 1d MA-100, long only | −3.08 | 10 | failed the final test (the protocol's long-only pick) |
| **BTC 1d MA-50, LONG+SHORT** | +14.55 / **+7.42 with borrowing** | 32 | not accepted: its short side lost money in development and validation; real shorts need margin or derivatives; the interval includes zero |
| BTC 1d EMA 20/50, long only | −8.83 | 13 | failed the final test |
| BTC 1d EMA 50/200, LONG+SHORT | −2.42 | 24 | failed the final test |
| BTC 1d pullback, LONG+SHORT | −4.19 | 15 | failed the final test |

### Failed in validation (16 combinations), or no robust setting in development (3)

**Failed in validation.** Listed in `r2-results.json` (`passes_validation: false`):
- SOL 4h: Donchian L+S, MA L and L+S, EMA L and L+S, pullback L and L+S;
- SOL daily: Donchian L and L+S, MA L and L+S, EMA L and L+S;
- BTC: 4h Donchian L+S, 4h MA L+S, daily Donchian L+S.

**No robust setting in development:**
- SOL daily pullback, long only;
- BTC 4h EMA L+S;
- BTC daily pullback, long only.

### Original OTE on 4h / daily

Negative in development for 7 of 8 combinations, and rejected.

### Under forward test, not proven

**Candidate B, BTC daily MA-50 long only:** +21.10 / +13.43 / +4.12 (19 trades), 95% interval −0.42 to +1.19 per trade.
- Not the protocol's pick: the robust-median rule chose MA-100.
- Now in an isolated forward PAPER trial (pending deployment approval).

## Round 3 (2026-11-16): pre-registered daily long-only hypotheses, BTC/SOL/ETH 2021–2026

Source: `docs/research/round3/`. Costs: 0.20% + 0.05% slippage, $100, no leverage.

| Candidate | Validation BTC / SOL | ETH (run once) | Verdict |
|---|---|---|---|
| H1 momentum, 180-day (development plateau median) | +9.93 / −5.67 | −7.36 (18 trades) | failed validation |
| H2 volatility-target trend, SMA 100, 50% | +23.81 / −5.52 | +9.16 (52 trades, max drawdown 54%); negative at 0.40% | failed |
| H3 breakout 100/50, 5×ATR | +1.59 / −0.85 | +7.69 (6 trades) | failed |
| H4 relative strength, 90-day | −59.07 | +2.17 (max drawdown 79%) | failed |
| H5 cash vs BTC, 200-day rising (baseline) | −16.37 / −57.18 | −18.82 | failed |
| **H6 regime-filtered MA-50** | +7.42 / +4.88 | +13.70 (36 trades) | **not recommended**: the H6 study showed the filter cuts exposure but not expectancy; unfiltered Candidate B does as well or better on a risk-adjusted basis on most markets |

## Round 5 (2026-11-16): OTE / Fibonacci on 4h and daily, seven new markets

Source: `docs/research/round5/` (pre-registration `bac1a9d`, before any run). These are pooled results on LTC, LINK, AVAX, ADA, BCH, DOGE and XRP, with $100 per market, 0.20% fee + 0.05% slippage, and strict acceptance timing.

| Candidate | Development / validation net (validation trades, markets positive) | Verdict |
|---|---|---|
| F0 original OTE 4h, LONG / SHORT | +3.24 / −9.21 (106, 3/7); −33.91 / +6.66 (83, 2/7) | fails |
| F1 4h + daily EMA50, LONG / SHORT | +5.96 / +0.56; −27.47 / +12.66 | fails |
| **F2 4h + daily EMA50 + −1.618 target, LONG** (round-4 SOL lead) | +13.17 / +8.03 (51, 3/7); CI per trade [−0.63, 1.28]; +0.01 at 0.40% | **fails; the SOL result is not confirmed on new markets** (LTC and DOGE carry it) |
| F2 SHORT, and neighbours −1.0 / −2.0 | development negative for SHORT; LONG neighbours +3.20 / +5.47 in validation | fails |
| F3 daily OTE + weekly EMA20 (± −1.618), both sides | 10–11 validation trades; validation −5.45 to −11.53 | fails; too few trades |
| F4 OTE pullback inside BTC MA-50 trend, LONG | +10.07 / +28.08 (64, 3/7); CI [−0.38, 1.39] | fails; simple trend following made +70.13 on the same markets |
| F4 SHORT | −13.10 / +32.90 (45, 4/7) | fails (development negative) |
| F5 + PD confluence minScore 2, LONG / SHORT | −4.29 / −2.79 (18); +8.22 / +25.21 (21, 2/7) | fails; too few trades |
| F6 volatility stop + fee-aware reward, LONG / SHORT | +3.45 / −0.75; +13.85 / −0.91 | fails |

Conclusion: OTE timing showed no demonstrated value over simple trend following, and no hybrid OTE candidate qualifies for a forward trial.

## Round 6 (2026-11-16): fee-aware OTE variants, live 5m profiles

Source: `docs/research/round6/` (pre-registration `f9506dc`, before any run). Sizing is as live ($20 wallet, $10 risk capped), with strict acceptance and 0.20% fee + 0.05% slippage. Independent data: LTC, LINK, ADA, DOGE 5m, 2024-07 → 2026-11.

| Candidate | Independent gross before fees / net (trades) | Verdict |
|---|---|---|
| V0 baseline | −11.39 / −54.46 (1206) | fails; negative before fees |
| V1a / V1b fee-aware minimum reward (minNetRR 1.0 / 2.0) | −10.31 / −52.09 (1170); −8.31 / −27.85 (367) | fails; fewer trades only |
| V2 fee-aware break-even (entry ± 0.45%) | −11.40 / −56.96 (1276) | fails; slightly worse than baseline |
| V3 target −1.0 | −10.36 / −52.24 (1174) | fails |
| V4 stop ≥ 0.8% | −8.29 / −42.73 (882) | fails |
| V5 minScore 2 | −12.62 / −54.80 (1155) | fails |
| V6 combined | −6.32 / −39.43 (850) | fails; no independent market positive, CI entirely below 0 |

Conclusion: the 5m OTE strategy has no edge before costs on independent markets, so fee-aware rules reduce losses only by trading less.

## Round 7 (2026-11-16): different strategy families

Source: `docs/research/round7/` (pre-registration `255a351`, before any run). Independent set: 8 never-used markets. Costs: 0.20% + 0.05% slippage.

| Candidate | Independent net (trades, + of 8) | Status |
|---|---|---|
| T1 LONG Donchian 55/20, 4h | +275.8 (601, 5/8) | INCONCLUSIVE: breadth, 99.5% CI and drawdown fail; XLM is 85% of the net |
| M1 LONG 30-day momentum, 1d | +83.9 (169, 4/8) | INCONCLUSIVE: breadth and CI fail; concentrated in 2024 |
| T2 LONG SMA200, 4h | −18.1 (1293, 2/8) | FAILED |
| B1 LONG squeeze breakout, 4h | −33.0 (651, 2/8) | FAILED |
| R1 LONG mean reversion, 4h | −42.9 (156, 0/8) | FAILED |
| All five SHORT candidates (T1, T2, M1, B1, R1) | −7.8 to −90.8 | FAILED |

## Round 8 (2026-11-17): cross-sectional momentum rotation

Source: `docs/research/round8/` (pre-registration `931cf8a`, before the data download and any run). Independent set: 10 markets never used by any round.

| Candidate | Independent net | Status |
|---|---|---|
| X1 rotation, 30-day return, top 2, weekly, 1d | −96.5 (buy-and-hold −89.9), drawdown 97% | FAILED: every independent gate fails. Development +136.6 and validation +15.9 did not transfer to smaller markets; 2022 reversals were ruinous |

## Round 9 (2026-11-17): strategy discovery tournament

Source: `docs/research/round9/` (pre-registration `7288171`, code `7fc53ef`, both before any run; reproduced byte-identical). Independent set: 15 never-used markets. Run at $20 per market (the real wallet size) with Kraken minimums.

| Candidate | Independent net ($20; $100) | Status |
|---|---|---|
| F1 BTC-regime Donchian 4h 55/20 | +26.8; +147.3 | INCONCLUSIVE: CI includes 0, 7/15 markets, concentrated, 92% of signals below Kraken minimums at $20 |
| F3 regime-adaptive 4h | +52.5; −88.1 | INCONCLUSIVE: the $20 result is a minimum-size selection artifact; FET is 96% of the net |
| F5 BTC-regime relative strength 1d | +10.6; −34.0 | INCONCLUSIVE: 19 entries, CI includes 0, a neighbour is negative |
| F4 reversion after extreme bars 4h | +0.3; −5.2 | FAILED: negative in development, validation and at stress costs |
| F2 volatility-normalised momentum 1d | — | FAILED: under 30 development trades at $20 |

## Futures research (2026-11-22): trend-following, leveraged long/short (THEORETICAL PAPER ONLY)

**Sources:** `docs/research/futures/`:
* PERP-PREREGISTRATION (commit `ae82626`; Amendment 1 `fa1c350`);
* PERP-REPORT;
* AUDIT-AND-EDGE-REPORT (`3a835dd`);
* REPLICATION-PREREGISTRATION (`1a29f35`);
* REPLICATION-REPORT (`36d81d2`).

**Simulator:** fractional perpetual-style (`perp.mjs`). It was audited against an independent re-implementation: agreement < 5e-13 over 126 configurations; ledger identity < $3e-9.

**Rules (frozen):**
* SMA-200 trend on daily closes, executed hourly. Sized at 1× gross, or volatility-targeted (min(1.5, 0.106 / σ30) per asset).
* Costs: ideal (percentage of notional) and conservative ($0.50 minimum per order, 2× spread, 2 % missed orders, $10 minimum liquidation fee).
* Proxies: Kraken spot prices; Binance or constant funding.

| Candidate | BTC+ETH result (2017–26, compounded) | Timing edge vs passive exposure (BTC/ETH, gross) | Cross-market replication (10 coins, 2018–26) | Status |
|---|---|---|---|---|
| **H1 trend long-only** | Volatility-targeted: ideal 20.8 %/yr, DD 27 %; conservative 12.1 %/yr, DD 34 %, negative after 2018. 1×: ~68 %/yr, DD 75–77 %. 2× DD 98 %; 3× and 5× ruin. | Alpha +26.9 %/yr (CI +7.7 to +48.6), random-timing p 0.02 incl. 2017; **excl. 2017 +15.9 % (CI −3.7 to +35.3), p 0.10** | Pooled gross alpha −0.4 %/yr (CI −10.6 to +9.5), p 0.23. **Pooled net alpha −13.6 %/yr (CI −23.4 to −3.8): significantly negative.** 1/10 coins positive net. Effective independent coins 2.3. Pooled DD 51–60 %. | **REJECTED** |
| **H2 trend long/short** | Volatility-targeted: ideal 18.7 %/yr, DD 37 %; conservative ~0 %/yr, DD 56 %, ruin in 2018–26. 1×: 44.5 %/yr, DD 90 %. 2× DD 99.8 %; 3× and 5× ruin. | Alpha +53.7 %/yr (CI +15.4 to +97.2), p 0.025 incl. 2017; **excl. 2017 +31.9 % (CI −7.4 to +70.5), p 0.12** | Pooled gross alpha −0.9 %/yr (CI −21.2 to +19.0), p 0.24. Pooled net alpha −7.9 %/yr (CI −22.5 to +6.4). 1/10 coins positive net (ADA, dependent on 2021). Effective independent coins 2.8. Pooled DD 58–104 %. | **REJECTED** |
| H3 BTC/ETH relative momentum, market-neutral | ≈ 0 %/yr at every sizing; DD 28–96 %; conservative ruin | — | not run (failed first) | **REJECTED** |

**Reasons for rejecting H1 and H2:**
1. **No drawdown compliance.** No configuration on any asset, rule, sizing or cost model stayed within the 15 % research ceiling (10 % preferred). The best was 27 % (H1 volatility-targeted, ideal costs, BTC/ETH).
2. **No repeatable timing edge.**
   * The BTC/ETH timing value is borderline once 2017 is excluded, and concentrated in a few events (2018 and 2022 bear markets).
   * It does not appear across 10 other coins (1/10 positive after costs; pooled p ≈ 0.23–0.24).
   * The coins are correlated (effective N ≈ 2.3–2.8).
3. **Costs.**
   * Realistic minimum per-order fees make any $100 implementation lose.
   * Executable versions need ≈ $4,200 (one futures contract per leg) to ≈ $21,000 (five per leg), or ≈ $1,600 for unlevered ETFs.
   * No Ontario route offers fractional leveraged long/short crypto at $100.
4. **Higher risk does not help.** 2× and above raised drawdowns to 95–100 % or ruin without improving returns.

**Statistical limitations:**
* All data is reused (BTC/ETH examined since Round 1; the 10 coins in Phase 3 and H-L1).
* Survivorship bias: only coins still in Kraken's archive.
* Short histories: ADA from 2019, DOGE from 2020.
* Constant or proxy funding.
* Spot price as a proxy for perpetual prices.
* Arithmetic annualized alphas.

**Do not retest with different parameters to obtain better historical results.**

## Other candidates rejected since Round 9 (2026-11-21 / 22)

| Candidate | Source | Result | Status |
|---|---|---|---|
| DD2 / Phase 3 small-risk A, B, C, D (2 % target, spot) | `dd2/`, `phase3/`, `OFFICIAL-DRAWDOWN.md` | Under the official high-water-mark drawdown: **C fails** (2.24–2.39 %); **A** borderline (1.93 % from 2018, fails 2016–26 at 2.20 %); **B** passes (≈ 1.55 %) at ≈ 1 %/yr only; **D** fails. No edge on 41 other coins. | A, C, D REJECTED; B compliant but not meaningful |
| H-L1 liquidity provision (wick capture, maker limits) | `liquidity/` | 0/6 settings profitable on BTC/ETH/SOL; 0/10 coins; negative expectancy; no edge under realistic intrabar fills | **REJECTED** |
| H-G1 drawdown-budget (Grossman–Zhou) sizing of S3 | `ddsize/` | 0.65 %/yr with DD 1.3 % (compliant, too small); cash lock after drawdowns | **REJECTED** (not meaningful) |
| Round S independent signals: funding, exchange flows, stablecoin supply, Coinbase premium, Fear & Greed | `signals/` | No signal passed the development screen; 3 near-misses not confirmed on held-out 2022–26 (|IC| ≈ 0.04–0.05) | **REJECTED** |
| One-contract CME Micro Ether at $100 | `futures/PROBE-REPORT.md` | All frozen rule types: DD 50–76 %, liquidation lock-out | **REJECTED** (infeasible) |
| Crypto futures contracts at $100 (CME micro, Coinbase nano, Bitnomial) | `futures/CONTRACT-AUDIT.md` | Whole contracts of $172–$862 exposure; overnight margins above equity; US-only perps | **REJECTED** (infeasible) |

## Discovery phase (2026-11-22): Ndax-executable short-term hypotheses

Source: `docs/research/discovery/` (pre-registration `0d86edb`; runner `6b2a837`; REPORT; diagnostics). Confirmation period 2023-01 → 2026-09; Ndax measured costs.

| Candidate | Result | Status |
|---|---|---|
| **P1 Ndax cross-currency gap reversion** (BTC, ETH, XRP, LTC, DOGE, SOL; long-only; Makarov & Schoar 2020) | f = 100 %: 41.5 %/yr, **DD 17.4 %**, 219 trades, PF 2.09. The f = 50 % sensitivity: 20.0 %/yr, DD 9.6 %. **Decayed:** +53 % in 2023, +126 % in 2024, +1.4 % in 2025, +4.4 % in 2026. **Top 10 trades = 86 % of profit**; LTC 47 %, much of it on thin days. The hourly "150 %/yr" is not credible (stale prints). | **REJECTED** (pre-registered drawdown criterion; not a convincing improvement on S3) |
| **P2 USDC/CAD peg reversion** | 1.1 %/yr, 16 trades, mean trade CI includes 0 | **REJECTED** |
| Seasonality, macro-announcement drift, options expiry | edge ≪ Ndax round-trip cost; weak evidence | rejected before testing |

## Round 10 (2026-11-23): drawdown-budget strategies under the owner's 15 % limit

**Sources:** `round10/PREREGISTRATION.md` (ebc43ce), `round10/REPORT.md`; code 0206bce; one run.

| Candidate | Result (Ndax measured costs; CAGR / official DD) | Verdict |
|---|---|---|
| N1 constant mix 7 % BTC/ETH (volatility harvesting) | 5.9 / 12.3 (2016–26), 3.8 / 10.0 (2018–26); holdout 2014–16 2.6 / 8.1 | **REJECTED** (below S3-25 everywhere) |
| N2 drawdown-floor (Grossman–Zhou/CPPI) buy-and-hold, D 15 % / 10 %, m 2 | ≈ 0 %/yr in 2018–26 (cash lock at the floor); D 15 % breaches 15 % (15.09) | **REJECTED** |
| N3 drawdown-floor S3, D 15 % / 10 %, m 2 | 10.6 / 10.9 and 7.0 / 7.3 (2016–26); holdout 4.1 / 10.0 and 2.7 / 6.6 | **REJECTED** (lower DD but lower return than S3-25 in every window, and below S3-30) |
| CTREND cross-sectional trend factor | needs long–short over a broad universe; 2026 replication negative after corrections | rejected before testing (not executable on Ndax) |
| Intraday momentum; options volatility premium | edge far below costs; not available at $100 | rejected before testing |

**By-product:** S3-25 (BTC-only) passed its first test on never-used data: 2014-05..2016-06, 5.8 %/yr, drawdown 10.6 %. On LTC+XRP (coins seen elsewhere) it made 2.8 %/yr and **breached 15 % under conservative costs (15.8 %)**.

## Jupiter Perps research (2026-11-25): Strategies A and B, leveraged long/short (PAPER)

**Sources:** `jupiter/PREREGISTRATION.md` (2045a20, Amendment 1 268ec2c), `jupiter/REPORT.md`, `jupiter/TABLES.md`. The owner requested these previously rejected families explicitly for a new venue.

| Candidate | Result (DEV-2 2018-04..2026-09, conservative Jupiter costs) | Verdict |
|---|---|---|
| A Donchian Trend Ensemble 4h (10/20/40/80-day), long/flat, 1.1×/2×/3×/5× | best 8.9 %/yr with drawdown 78.5 % (2×); 3× and 5× hit the $75 shutdown in 2019; all hit it in 2022–26 | **REJECTED** |
| A long/short, all levels | negative; drawdown 30–43 %; $75 shutdown | **REJECTED** |
| B time-series momentum (28-day lookback, 5-day hold), long/flat and long/short, all levels | negative; drawdown 26–50 %; $75 shutdown in 2018 | **REJECTED** |

**Main causes:**
* the borrow fee on the full size (about 12 %/yr for longs);
* 26–98 % drawdowns;
* the $10 minimum collateral at $100;
* these families already failed out-of-sample replication.

**Holdout** (2026-10..11 crash): B long/short at 1.1× ended +13 %. A single regime; under the pre-registered rule the holdout can only veto.

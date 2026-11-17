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

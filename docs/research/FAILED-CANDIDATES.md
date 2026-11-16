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

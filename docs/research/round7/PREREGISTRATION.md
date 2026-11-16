# Research round 7: different strategy families (PRE-REGISTRATION, 2026-11-16)

Written and committed **before any round-7 run**. Every setting below is frozen.

- **Research only:** no bot, parameter or deployment changes.
- **Nothing here is a profit claim.** A candidate that passes becomes ELIGIBLE FOR FURTHER VALIDATION only, i.e. a separate, owner-approved forward PAPER trial.

## Economic hypothesis

**Why the old approach failed.** Rounds 1–6 showed that short-horizon OTE entries cannot pay a 0.40% round trip. Their average move is ≈ 0.07%, and they lose even before fees on independent markets.

**What is tested here.** Strategies that hold for many bars and target **large moves** (trend, momentum, breakout), or that buy **statistically stretched** prices inside a trend (mean reversion), may earn moves several times larger than the cost.

**The hypothesis.** At least one simple family has positive net expectancy after realistic costs. That must hold on markets **no earlier round has touched**, in more than one market regime.

## Families and the complete parameter grid (`engine/src/research/r7/families.mjs`)

| Family | Rule | Grid | Timeframes |
|---|---|---|---|
| T1 Donchian breakout | close beyond the prior N-bar range; exit beyond the opposite M-bar range; 2×ATR initial stop | (N, M) ∈ {(20,10), (55,20)} | 4h, 1d |
| T2 MA regime trend | close above a rising SMA(N) (falling, for SHORT); exit on a close back through it; 3×ATR trailing stop | N ∈ {50, 100, 200} | 4h, 1d |
| M1 Time-series momentum | every 7th bar: hold while the L-bar return has the trade's sign; 3×ATR trailing stop | L ∈ {30, 60, 120} | 1d |
| B1 Volatility contraction breakout | Bollinger width in its lowest 20% (of 120 bars) within 5 bars, then a close beyond the prior 20-bar range; 3×ATR trail; 30-bar time exit | — | 1h, 4h |
| R1 Mean reversion in trend | close beyond SMA20 ± k·σ20 on the trend side of SMA200; exit at SMA20 or after 12 bars; 2.5×ATR stop | k ∈ {2, 2.5} | 1h, 4h |

**Configurations:** 19 per side, **38 in total**. LONG and SHORT are evaluated separately; a SHORT is a fully collateralised PAPER short (no borrowing, no leverage).

## Execution and costs (`engine/src/research/r7/bt.mjs`, tested)

**Execution rules:**
- Signals use completed bars only; market orders fill at the next bar's open.
- Stops fill at the stop or a worse gap open. A stop and a target inside the same bar resolve **stop first**.
- Sizing: 2% risk of current equity per trade, capped by equity. Kraken minimums apply (public AssetPairs, fetched 2026-11-16).
- $100 per market per run.

**Costs:**
- **Selected:** 0.20% per fill (the production fee model) + 0.05% slippage.
- **Sensitivity** (from the repository's cost profiles, `costs.mjs`): 0.40% + 0.10% slippage, and 0.80% per fill.
- **Not used:** maker-only discounts, which the account is not shown to qualify for.

## Data (Coinbase public candles: 1h, with 4h built from 1h, and daily)

| Set | Markets | Period | Use |
|---|---|---|---|
| **Development** | BTC, ETH, SOL | 2021-07-01 → 2024-07-01 | choose ONE configuration per family and side |
| **Validation (time)** | BTC, ETH, SOL + LTC, LINK, AVAX, ADA, BCH, DOGE, XRP | 2024-07-01 → 2026-11-15 | out-of-sample in time. These markets were examined before (OTE, and SMA-50 trend in round 5) |
| **Independent (untouched)** | DOT, ATOM, UNI, AAVE, XLM, ETC, FIL, ALGO | 2021-07-01 → 2026-11-15 | **never used by any round.** The confirmatory test |

## Selection (frozen)

1. For each family and side, the configuration with the **highest pooled development net**, among configurations with ≥ 30 development trades, is the candidate. That gives **at most 10 candidates**.
2. Development results are reported for every configuration, so nothing is hidden.

## Acceptance (ALL required; selected 0.20% + 0.05% unless stated)

1. Development net > 0 (pooled).
2. Validation net > 0, pooled over the 10 validation markets.
3. Independent net > 0 (pooled), with **≥ 6 of 8** independent markets positive.
4. At least **100** independent trades.
5. Independent per-trade bootstrap interval **at 99.5%** with its lower bound > 0. That is Bonferroni over the 10 candidates (two-sided 95% / 10).
6. Independent net > 0 at **0.40% + 0.10% slippage**.
7. **Risk profile:** median independent-market max drawdown ≤ 25%, and the worst ≤ 40%.
8. **Regime robustness:** independent pooled net positive in **≥ 3 of the 5** calendar years 2022–2026 (2021 H2 reported).

**Also reported (not gates):**
- buy and hold and cash on the same markets;
- gross vs net and fee drag;
- trade frequency and exposure;
- the 0.80% scenario.

## Interpretation rules

- Passing makes a candidate **ELIGIBLE FOR FURTHER VALIDATION** (a separate forward PAPER trial, owner-approved). It does not make it proven.
- Failing configurations go to `FAILED-CANDIDATES.md`.
- **Not allowed:** changing a threshold after results, adding markets or periods after results, or re-running with new parameters to rescue a family.

# Research round 6: fee-aware OTE variants (PRE-REGISTRATION, 2026-11-16)

Written and committed **before any round-6 run**. Every setting below is frozen. Results are reported whether they help or not.

- **No live strategy parameter is changed. Nothing is deployed.**
- A candidate must pass on independent data before it may even be *proposed* for a forward PAPER trial.

## Why

The profitability audit (`docs/research/PROFITABILITY-AUDIT-2026-11-16.md` on the release branch) found that the losses come from costs:
- the round-trip cost is 0.40% (+ slippage);
- stops are often smaller than that cost;
- break-even exits lock in −0.40%.

This round tests whether fee-aware rules make the existing OTE strategy net-positive. Reducing losses is reported, but it is not the bar.

## Scope

**Strategy:** the production OTE / Fibonacci / PD-Array code (`ote.mjs`) with the **live 5m profiles**:
- `solusd-5m` for SOL;
- `btcusd-5m` for BTC, ETH and the other markets, as in rounds 4–5.

**Timeframe:** 5m only. The paused 1m bots are not studied, because multi-year 1m data is not in the research set; that is a stated limitation.

**Execution:** the production fleet backtest with strict acceptance:
- an order is fillable only from the bar after acceptance;
- order identity is side + limit;
- stops fill at the stop or a worse gap open.

**Sizing (as live):** a $20 wallet per run, $10 dollar-risk target, capped by the wallet (reduce-to-fit), Kraken minimums, no leverage, no size increase. Both directions, as the live profiles trade them, reported separately.

**Costs:** 0.20% fee per fill + 0.05% slippage (selected). Sensitivity: 0.15% slippage, and 0.40% per fill.

**Data and periods:**

| Set | Markets | Period | Status |
|---|---|---|---|
| Development | BTC, SOL, ETH (Coinbase 5m) | 2021-07 → 2024-07 | examined in rounds 1–5 |
| Validation | BTC, SOL, ETH | 2024-07 → 2026-11 | examined |
| **Independent** | LTC, LINK, ADA, DOGE (Coinbase 5m, downloaded for this round) | 2024-07 → 2026-11 | no 5m OTE run ever made on them; their 4h / daily candles were used in round 5 |

## Variants (frozen)

| ID | Change from the live profile | Hypothesis |
|---|---|---|
| V0 | none (baseline) | — |
| V1a / V1b | fee-aware minimum reward: `minNetRR` 1.0 / 2.0 with `researchCostPct` 0.2 | skip setups whose target cannot pay the fees |
| V2 | fee-aware break-even: when break-even triggers, the stop moves to entry ± 0.45% (round-trip fee + slippage) instead of exactly to entry (research input `beFeeOffsetPct`) | break-even exits stop costing 0.40% |
| V3 | larger target: `tp2Ext` −1.0 | wins pay more than the fixed cost |
| V4 | fewer, wider trades: skip setups whose stop is closer than 0.8% (2 × round-trip fee) from entry (research input `minStopPct`) | remove trades whose risk is smaller than their cost |
| V5 | more selective: `minScore` 2 | fewer, better-confirmed setups |
| V6 | V1a + V2 + V3 + V4 combined | the fee-aware package |

**No other variant, threshold or market is added after seeing results.**

## Acceptance (a variant passes only if ALL hold, at 0.20% + 0.05% slippage)

1. Net positive in development (pooled BTC/SOL/ETH) **and** validation (pooled) **and** independent (pooled LTC/LINK/ADA/DOGE).
2. At least 30 independent trades.
3. Independent per-trade bootstrap 95% interval above 0.
4. Independent still positive at 0.15% slippage.
5. At least 3 of 4 independent markets positive.

Also reported, though not a gate: positive at 0.40% per fill, and the improvement over V0.

**If one passes:** propose a frozen forward PAPER trial for the owner. Nothing is deployed.

**If none passes:** record every variant in `FAILED-CANDIDATES.md`.

# Research round 6: fee-aware OTE variants (report, 2026-11-16)

**RESEARCH, not PAPER results. Nothing is deployed, and no live parameter was changed.**

- **Protocol:** `PREREGISTRATION.md` (`f9506dc`). The V2 trigger was clarified in `0d73f75` before the first run.
- **Driver:** `engine/src/research/r6.mjs` (`ec27efc`).
- **Results:** `r6-results.json`.

**Setup:**
- Live 5m profiles, sized like the live bots: a $20 wallet per market with a $10 risk target capped by the wallet.
- Strict acceptance; 0.20% fee per fill + 0.05% slippage.

**Data:**

| Set | Markets | Period |
|---|---|---|
| Development | BTC, SOL, ETH (examined before) | 2021-07 → 2024-07 |
| Validation | BTC, SOL, ETH | 2024-07 → 2026-11 |
| **Independent** | LTC, LINK, ADA, DOGE (no 5m OTE run ever made on them) | 2024-07 → 2026-11 |

## Results (pooled net $; independent markets carry $20 each)

| Variant | Dev net (trades) | Val net (trades) | **Independent: gross before fees / fees / net (trades)** | Markets + | Independent 95% CI per trade | Independent @0.15% slippage | Pass |
|---|---|---|---|---|---|---|---|
| V0 baseline | −43.24 (1346) | −42.08 (940) | **−11.39** / 43.07 / −54.46 (1206) | 0/4 | [−0.050, −0.043] | −59.42 | no |
| V1a minNetRR 1.0 | −36.05 (974) | −30.33 (637) | −10.31 / 41.77 / −52.09 (1170) | 0/4 | [−0.049, −0.039] | −57.49 | no |
| V1b minNetRR 2.0 | −10.07 (127) | −3.30 (55) | −8.31 / 19.55 / −27.85 (367) | 0/4 | [−0.097, −0.058] | −34.47 | no |
| V2 fee-aware break-even | −46.61 (1442) | −45.14 (981) | −11.40 / 45.55 / −56.96 (1276) | 0/4 | [−0.047, −0.042] | −60.92 | no |
| V3 target −1.0 | −40.40 (1241) | −37.59 (909) | −10.36 / 41.88 / −52.24 (1174) | 0/4 | [−0.051, −0.042] | −57.34 | no |
| V4 stop ≥ 0.8% | −37.40 (868) | −28.47 (527) | −8.29 / 34.45 / −42.73 (882) | 0/4 | [−0.057, −0.042] | −50.21 | no |
| V5 minScore 2 | −44.23 (1161) | −40.69 (902) | −12.62 / 42.18 / −54.80 (1155) | 0/4 | [−0.051, −0.044] | −59.09 | no |
| V6 combined (V1a+V2+V3+V4) | −36.84 (801) | −24.92 (507) | −6.32 / 33.11 / −39.43 (850) | 0/4 | [−0.063, −0.036] | −47.90 | no |

## Conclusions

1. **No variant passes.** Each one fails every pre-registered criterion: it is negative in development, validation and the independent set; no independent market is positive; and every confidence interval lies entirely below zero.
2. **The 5m OTE strategy has no edge even before fees on independent data.**
   - The baseline gross on the four new markets is −$11.39 over 1,206 trades. Every variant is negative before fees too.
   - Fees (≈ $0.036 per trade at $20 notional) multiply a loss that already exists. They are not its only cause.
   - The live 8-trade gross of +$0.14 (profitability audit) is consistent with noise.
3. **The fee-aware rules mainly reduce how much the strategy trades.**
   - V1b, V4 and V6 cut losses by removing trades (V6: −28% loss on the independent markets, with 30% fewer trades).
   - None turns the result positive.
   - **The fee-aware break-even (V2) made results slightly worse:** keeping trades open until price clears the fees lets more of them reach the full stop.
4. **Larger targets (V3) and stricter confluence (V5) make no material difference.**
5. **Slippage sensitivity:** at 0.15% slippage every variant loses about 5–8 more. At 0.40% per fill the losses roughly double (V0 independent −97.5).

**Recommendation:** no forward trial is proposed. The paused 1-minute bots should stay paused. Further OTE fee tuning is unlikely to help, because the problem appears before costs.

**Limitation:** the 1m timeframe is not studied, because there is no multi-year 1m data.

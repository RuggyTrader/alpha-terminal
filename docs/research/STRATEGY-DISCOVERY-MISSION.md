# Strategy Discovery Mission: report (2026-11-17)

## Answer

**No strategy passed. No suitable candidate has been found.**

- Nothing tested so far shows a credible positive net edge on untouched data under the account's real constraints.
- No forward-trial proposal is made.
- Production was not touched: no bot, wallet, order, setting or engine change.

## 1. Strategies researched (rounds 1–9, all pre-registered from round 3 on)

| Round | Family | Result |
|---|---|---|
| 1–6 | OTE / Fibonacci (1m → 1d, 21+ variants, fee-aware versions) | FAILED everywhere after fees. Negative **before** fees on independent 5m markets (round 6 baseline: gross −11.4, net −54.5, 1,206 trades) |
| 7 | Donchian trend T1, MA trend T2, time-series momentum M1, squeeze breakout B1, mean reversion R1; long and short | T1 and M1 LONG INCONCLUSIVE (concentrated); every other config and every short FAILED |
| 8 | Cross-sectional momentum rotation | FAILED (−96.5 on 10 untouched markets, 97% drawdown) |
| **9** | **F1** regime-filtered Donchian, **F2** volatility-normalised momentum, **F3** regime-adaptive trend/range, **F4** reversion after extreme moves, **F5** regime-filtered relative strength | **F1, F3, F5 INCONCLUSIVE; F2, F4 FAILED** |

**Coverage of the mission's families:**
- **A, trend breakout:** T1, F1.
- **B, momentum:** M1, F2, X1, F5.
- **C, regime-adaptive:** F3, plus the BTC regime filter in F1, F2 and F5.
- **D, mean reversion:** R1, F4.
- **E, multi-asset:** X1, F5.

## 2. Hypotheses and sources

**Hypothesis:** rules that hold for days or weeks capture moves large enough to pay a 0.50% round trip. Regime filters (BTC above its 200-day SMA) avoid bear-market whipsaw.

**Literature (motivation only, never evidence):**
- Moskowitz, Ooi & Pedersen (2012), time-series momentum.
- Liu & Tsyvinski (2021) and Liu, Tsyvinski & Wu (2022), crypto momentum factors.
- Faith (2007), Donchian / turtle breakouts.
- Moreira & Muir (2017), volatility scaling.
- Short-term reversal after extreme moves.

The pre-registrations are `docs/research/round7/`, `round8/` and `round9/PREREGISTRATION.md`.

## 3. Markets and timeframes

**Markets:**
- Development and validation: the owner's liquid set (BTC, ETH, SOL, LTC, LINK, XRP, ADA, AVAX).
- **Independent, never used before each round:** 8 markets (round 7), 10 (round 8) and **15 (round 9)**.

**Timeframes: 1h, 4h, 1d.**
- 15m was excluded deliberately. Rounds 1–6 showed short-horizon rules cannot pay a 0.50% round trip; the average OTE move is about 0.07%.

## 4. Dataset provenance

- **Source:** Coinbase Exchange public candles (`engine/src/research/download.mjs`). 4h bars are built from 1h.
- **Hashes:** per-file SHA-256 prefixes are in each results file's `provenance`.
- **Why not Kraken data:** Kraken's public OHLC returns only the last 720 candles, so it cannot provide history.
- **Kraken order minimums:** Kraken public AssetPairs, fetched 2026-11-17 (`round9/kraken-minimums-2026-11-17.json`).
- **Survivorship:** only currently listed Coinbase products can be downloaded. Round 9 nevertheless includes four markets that Coinbase stopped (ENJ, LRC, STORJ, BAL).

## 5. Methodology (frozen before each run)

**Splits:**
- Development 2021-07 → 2024-07 selects ONE configuration per family.
- Validation 2024-07 → 2026-11 on the same markets.
- The independent untouched markets (2022 → 2026-11) are the confirmatory test.

**Gates (all required):**
- positive net in development, validation and independent;
- breadth across markets;
- ≥ 100 trades;
- a **Bonferroni-corrected** bootstrap interval with its lower bound > 0 (round 9: 5 candidates, so 99%);
- positive at **0.40% + 0.10%** costs;
- drawdown limits;
- positive in ≥ 3 of 5 years;
- concentration (no market > 50% of net profit, no trade > 25%);
- **parameter neighbours** positive;
- **≥ 80% of signals executable at $20.**

## 6–11. Results, out of sample, drawdown, costs, uncertainty

Round 9 details are in `round9/REPORT.md`; full numbers are in `round9/r9-results.json`.

### Leaderboard (independent markets; **every candidate failed or is inconclusive: none is shown to be profitable**)

| Category | "Winner" | Why it is not a recommendation |
|---|---|---|
| Top net return ($20) | F3 regime-adaptive, +52.5 | **−88.1 at $100.** The $20 profit is a selection artifact of order minimums; FET supplies 96% of it |
| Top risk-adjusted (daily Sharpe, $20) | F3, 0.57 | same artifact; worst market drawdown 55% |
| Lowest drawdown | F4 reversion (≈ 0–6%) | almost never invested; FAILED (negative in development and validation) |
| **Best robustness** | **F1 regime Donchian 4h 55/20** | positive at $20, $100 and stress costs, with all 3 neighbours positive. But the 99% CI includes 0, only 7/15 markets were positive, and the result is concentrated in two markets |
| Lowest fee drag | F1, 7.9% of gross profit | as above |
| Best feasible for the current account | **none** | every candidate fails the ≥ 80% executable-signal gate at $20 (F1: 8%) |

### Comparison with the OTE baseline

**OTE:**
- negative before fees on independent 5m markets;
- hundreds to thousands of trades;
- fees about the size of the gross loss again.

**F1:**
- positive before and after fees;
- 129 executable trades in 5 years at $20 (423 at $100);
- fees 7.9% of gross profit.

F1 is a **clearly different and better-behaved rule** than OTE, but "better than OTE" is not the standard. It has not shown a statistically credible edge.

## 12. Failed candidates

See `FAILED-CANDIDATES.md` (updated for rounds 8 and 9) and `registry/candidates.json`. The registry now holds **29 candidates: 0 eligible, 6 inconclusive, 23 failed.**

## 13. Does any candidate pass?

**No.**

## 14. Actual-account feasibility (the decisive constraint)

**The account:**
- Book total **$99.35** in five wallets of about $20 each (authoritative ledger, read-only, 2026-11-17).
- Fee model 0.20% per fill, verified in `worker/src/bot_ledger.ts`.
- Long only: Kraken spot has no shorting without margin.

**At 2% risk per trade, a $20 wallet risks $0.40.**
- With 2–3×ATR stops on 4h or daily bars, the position is a few dollars.
- Kraken's order minimums for most alt-coins are 15–1,300 coins, about $5–$30.
- **88–92% of signals cannot be placed.**
- Even BTC, ETH and SOL trade only when the stop is tight.

**Implication:**
- A trend rule like F1 needs **either** pooled capital of roughly $100 or more per strategy, **or** sizing by allocation (a fixed share of the wallet) instead of by risk.
- Allocation sizing is a **different rule**, with different drawdowns. It has not been tested and would need its own pre-registration and data that is still untouched.

## 15. Code and data versions (branch `research/round4`)

| Round 9 item | Commit |
|---|---|
| Pre-registration | `7288171` |
| Code (before any run) | `7fc53ef` |
| Results and reports | commit of this report |

- **Code:** `engine/src/research/r7/bt.mjs` (backtester), `r8/xsmom.mjs` (rotation), `r9/families.mjs`, `r9/run.mjs`.
- **Tests:** `engine/test/r7-backtester`, `r8-rotation`, `r9-families` (23 tests).

## 16. Best candidate for further validation

**None qualifies.**

**Strongest research lead:** F1 (BTC-regime-filtered 55/20 Donchian breakout on 4h, long only). It deserves a **research-only forward observation**, which is signals recorded and no orders, if the owner wants one. This report does not propose it as a PAPER trial.

## 17. Limitations, and whether another round is justified

- **Independent data is nearly exhausted.** 43 markets have now been used across rounds 1–9. The remaining Coinbase markets with 2021 history are few and less liquid.
- **Further historical rounds would be less and less credible.** Each new hypothesis tested on reused data inflates false-discovery risk.
- **The honest next evidence is forward data**, prospectively recorded and untouched by design.
- A justified next step would be a **pre-registered forward observation**: F1 with allocation sizing on $20, recording signals only, measured after a fixed horizon (e.g. 6 months) against fixed gates. Its rules would be frozen today.
- Intra-bar execution is modelled conservatively (stop first, gap fills). Real spreads on small alt-coins may be wider than the 0.05–0.10% assumed.

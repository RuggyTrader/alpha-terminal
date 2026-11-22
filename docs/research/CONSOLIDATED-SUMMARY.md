# ALPHA TERMINAL: Phase 1 (historical research) consolidated summary (2026-11-22)

This closes **Phase 1, historical research.** It gathers every strategy and execution-cost study into one place.

**Safety:**
* Research only. Nothing was deployed, merged, pushed or changed in production.
* The engine, the four bots and S3 are untouched.
* No strategy rule was re-optimised for this summary.

---

## Final recommendation

> **Do not advance any strategy to Phase 3 (implementation) under the current 2 % drawdown requirement.**
> No tested strategy meets 2 % while producing meaningful net profit. The ones that meet 2 % earn about $1 a year on $100,
> and they showed no edge on markets that were not used to select them.
>
> **For execution:**
> * Lowest total trading cost for a $100 Canadian account at today's fees: **Ndax, CAD pairs, plain market orders.**
> * On Kraken, use **post-only limit orders**, never taker orders.
>
> **If you later decide to change the drawdown requirement** (your decision, not proposed here), the Phase 2 candidate would be
> **S3 executed with Ndax market orders**. Historically that earned ~29 %/yr with ~41 % maximum drawdown, 2018–2026.

---

## 1. What is verified and what is estimated

| Item | Status | Source |
|---|---|---|
| Historical prices (daily, hourly), 2013–2026-09 | **Verified, authentic** | Kraken's official OHLCVT archive (SHA-256 recorded); Coinbase public candles in earlier rounds (match Kraken within 0.013 % median) |
| Ndax daily prices, 2018-03 → 2026-11 | **Verified, authentic** | Ndax public API |
| Kraken fee schedule 2017–2026; Ndax 0.20 % flat | **Verified** | archived official pages + today's pages. Switch dates are known only within months. |
| Kraken minimum order sizes 2020–2026 | **Verified** | archived support pages (pre-2020 assumed) |
| Kraken spreads and C$50 book-walk costs, 2019-07 → 2026-11 | **Observed** on 22–36 sampled days, **interpolated** in between | Tardis.dev free first-of-month order-book data |
| Kraken spreads before 2019-07; crash-day spreads | **Assumed / estimated**; stress-tested ×2 | the estimators calibrated poorly, so they are not used as data |
| Ndax spreads (any past date) | **Assumed** = today's observed level; variants ×2 and "never below Kraken's" | no Ndax order-book history exists for free |
| Limit-order (maker) fills | **Hypothetical** | fills only if a later hourly bar trades through the limit by 0.05 % |
| All strategy returns | **Simulated** on historical data that was used for development and selection | **not** unseen evidence |

---

## 2. Strongest strategies, with realistic costs

**Data and costs:** Kraken official daily prices; 2018-04 → 2026-09 (both venues); $100 start; today's fees and minimums; each route's measured or assumed costs.

| Strategy | Best route | Net annual | Max drawdown | Meets 2 %? | Meaningful profit? |
|---|---|---|---|---|---|
| **S3**: 200-day trend × 40 % vol target, BTC+ETH | **Ndax market** | **29.3 %** ($100 → $892) | **40.8 %** | ✘ (by ~20×) | yes, historically |
| S3 | Kraken CAD post-only | 28.3 % | 40.4 % | ✘ | yes |
| S3 | Kraken CAD market (taker) | 25.7 % | 44.1 % | ✘ | yes |
| **A**: BTC 56-day momentum, 0.25 % risk | Kraken CAD post-only | 1.39 % | **1.81 %** | ✔ | **no** (~$1.40/yr) |
| A | Ndax market | 1.43 % | 2.43 % | ✘ | no |
| **B**: 3-coin momentum, 0.10 % risk | Kraken CAD post-only | 0.95 % | **1.46 %** | ✔ | **no** (~$1/yr) |
| B | Ndax market | 1.39 % | 3.03 % | ✘ | no |
| **C**: 3-coin 55/10 breakout | Kraken CAD post-only | 1.22 % | 2.14 % | ✘ at today's fees (✔ only at old 0.26 % fees) | no |
| **D**: 3-coin 20/10 breakout | Kraken CAD post-only | 2.13 % | 3.74 % | ✘ | no |
| *Buy-and-hold BTC+ETH (earlier rounds)* | — | — | 58–90 % | ✘ | — |

**Evidence beyond these numbers (earlier reports):**
* **Pre-registered selection** chose S3 as the best *risk-adjusted* strategy (strategy-select). DD2 chose A as the best under 2 %.
* **A, B and C** showed **no edge on 41 other coins** (median slightly negative), and made almost nothing in the last 20 months (A +$0.23; B 0 trades; C +$0.47).
* **A** has a **41 % chance** of breaching 2 % from trade order alone. A and C reach 2 % under severe stop slippage.
* **Low drawdown limits fail out of sample.** At 3 %, 10 % and 15 % limits, the pre-selected strategies broke their limits in the test, by up to 1.8×.
* **S3 cannot be scaled to 2 %.** That needs ~5 % exposure, about $1.60 per coin, which is below the minimum order sizes.

### Does any strategy satisfy 2 % *and* produce meaningful net profit?

**No.**
* **A and B** meet 2 % historically on Kraken with post-only orders, but earn **about 1–1.4 % a year (≈ $1 on $100)**. That is less than a savings account typically pays, and their edge did not generalise.
* **C** fails 2 % at today's fees, and **D** fails it at any fee.
* **S3** produces meaningful profit, but its drawdown is ~40 %.

---

## 3. Cheapest execution: total cost, not advertised fee

**Total cost per side today (C$50 order, BTC; this week's live spreads):**

| Route | Fee | Spread + impact | Total per side | Notes |
|---|---|---|---|---|
| **Ndax CAD market** | 0.20 % | ~0.25 % | **~0.45 %** | maker = taker; post-only brings no fee benefit |
| Kraken CAD post-only | 0.40 % | saves the half-spread; ~7 % of orders missed | ~0.40 % when filled | misses are re-decided next day |
| Kraken USD market | 0.80 % | ~0 % | ~0.80 % | plus 0.93 % one-time CAD↔USD conversion |
| Kraken CAD market | 0.80 % | ~0.03–0.2 % | ~0.83–1.0 % | the most expensive way to trade |

**Effect on S3, 2018-04 → 2026-09:**

| Route | Net annual | Fees on $100 |
|---|---|---|
| **Ndax market** | **29.3 %** | **$47** |
| Kraken post-only | 28.3 % | $89 |
| Kraken USD hybrid | 28.2 % | $100 (+0.93 % conversion) |
| Kraken CAD market | 25.7 % | $159 |
| *Zero cost (gross)* | *32.7 %* | — |

**Robustness:**

| Ndax variant | S3 net annual |
|---|---|
| Ndax costs ≥ Kraken's historical spreads | 28.97 % (still best) |
| Observed Ndax premium changes included | 29.35 % |
| Ndax spreads ×2 | 27.6 % (Kraken post-only would then be cheaper) |

**Caveats:**
* **The result depends on Kraken's current 0.40 %/0.80 % fees.** At Kraken's pre-2024 fees (0.16 %/0.26 %), Kraken USD market orders were slightly cheaper than Ndax.
* **The 4-hour "limit then market" hybrid underperformed plain post-only.** Its fallback orders are adversely selected.
* **Spreads depend on the market regime.** Kraken's CAD books tightened ~30× between 2019 and 2026, but widened sharply during this week's sell-off.
* **Withdrawals:** Ndax $1.50 Interac vs Kraken C$10 (10 % of a $100 account).
* **Minimum orders matter in both directions.** Kraken's larger minimums block small trades; that is what keeps A and B under 2 %. On Ndax those trades go through and drawdowns exceed 2 %.

---

## 4. State of the work (preserved, nothing deployed)

| Item | Where | State |
|---|---|---|
| All strategy and cost reports | `docs/research/` on branch `research/costs`. Includes strategy-select, dd2 (REPORT, FRONTIER-REPORT), phase3 (REPORT, FEE-REVIEW), costs (REPORT, HISTORICAL-REPORT), FAILED-CANDIDATES, rounds 1–9, and this file. | committed locally |
| Research branches | `research/strategy-select`, `research/dd2` (pushed earlier); `research/phase3`, `research/costs`, `shadow/phase3`, `lab/stage-0` (local only, never pushed) | clean |
| Offline backup of all research branches | `%USERPROFILE%\AlphaTerminal\backups\research-branches-20261122.bundle` (SHA-256 in the `.sha256` file beside it) | verified |
| Historical cost data and results | `%USERPROFILE%\AlphaTerminal\research\hist-costs\` | private, outside Git |
| 7-day collector | `%USERPROFILE%\AlphaTerminal\research\cost-study\`: 31 samples (2.5 h, 22 Nov), partial analysis `analysis-partial-final.json`, task definition `scheduled-task-definition.xml` | **stopped**: its Windows task was removed after verifying it ran only `cost-study\run-hidden.vbs`; its one-time Claude final-report task was deleted (prompt kept on disk). Partial data is **not conclusive**. |
| Engine, four bots, S3 shadow | production | **unchanged**. The "ALPHA TERMINAL Engine" task is still running. S3 still uses its frozen 0.20 % + 0.05 % cost setting, which overstates net results vs Ndax by ~1.4 pp/yr. |
| Phase 3 shadow accounts A/B/C | `shadow/phase3` | prepared, **not deployed** (per instruction) |

## 5. What would justify reopening development

Under the agreed process, historical data already used for selection will not be mined again. Reopening needs **one** of:

* **Genuinely new evidence:** market data after the selection date. That is Phase 4 forward PAPER data, which requires an approved implementation first.
* **An explicit change of constraints:** the drawdown limit, account size, or allowed instruments. This is your decision; it is not recommended here.

Until then, development is **paused**. No new live-data studies, strategies or deployments will start without your approval.

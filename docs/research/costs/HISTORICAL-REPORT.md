# Historical trading-cost study, 2016–2026: Kraken vs Ndax for a $100 Canadian account

*Prepared 2026-11-22 for review after the owner's vacation. Research and simulation only.*

**Safety:**
* No account was opened and no order was placed.
* No private key or credential was used.
* S3, the four production bots, balances, strategies, risk settings and production services were not touched.
* Nothing was deployed, merged or pushed.
* All strategy rules are frozen: nothing was optimised, and every period below has been examined before. **None of these results is unseen, out-of-sample evidence.**

---

## 1. Answer first

| Question | Answer |
|---|---|
| Cheapest practical execution today, $100 account | **Ndax, CAD pairs, plain market orders** (0.20 % flat fee). |
| If staying on Kraken | Use **post-only limit orders at the best bid/ask**, not market orders and not the 4-hour hybrid. |
| Does it materially improve net performance? | **S3: yes.** About **+3.7 percentage points a year** vs Kraken CAD market orders at today's fees, and **+1.1 pp/yr** vs Kraken's best method (post-only). **Small-risk strategies A–D: no.** The gains are ≤ 0.3 pp/yr and are outweighed by the drawdown effect below. |
| Does cheaper execution make the 2 % drawdown target reachable? | **No.** S3's drawdown is 39–46 % on every route. A, B and C meet 2 % only on Kraken. On Ndax, its ~$1 minimum orders let through hundreds of small trades that Kraken's minimums used to block, and drawdowns rise to 2.4–3.0 %. D fails everywhere (3.6–4.9 %). |
| Robustness of the Ndax recommendation | Robust to: today's stressed spreads, a conservative Ndax spread history, and observed Ndax price-premium changes. **Not robust to** Ndax spreads twice today's level; then Ndax ≈ Kraken post-only. |
| Biggest caveat | The advantage depends on **Kraken's current fees** (0.40 %/0.80 %). Under Kraken's **historical** fees (0.16 %/0.26 % until 2024), Kraken USD market orders would have been slightly *cheaper* than Ndax. |

---

## 2. Data used: authentic, free, and kept small

| Data | Source | What it covers | Size |
|---|---|---|---|
| **Kraken daily + hourly OHLCVT** (BTC, ETH, SOL in USD and CAD; USD/CAD) | **Kraken's official downloadable archive** (support.kraken.com, "Downloadable historical OHLCVT data"). Only the 14 needed CSV files were extracted from inside the zip with HTTP range requests (`kraken-archive.mjs`), not the whole archive. | Each pair from its first trade to **2026-09-30**: BTC/USD from 2013, BTC/CAD from 2015, ETH from 2015, SOL/USD from 2021-06, SOL/CAD from 2024-11, USD/CAD from 2020-03 | ~13 MB downloaded instead of 9.5 GB; SHA-256 sums saved |
| **Observed Kraken top-of-book** (best bid/ask + size, every change) | Tardis.dev "quotes", free first day of each month, no key; reconstructed from Kraken's public book feed | 36 days, 2019-07 → 2026-11: quarterly, plus 2021-05, 2021-11, 2022-06, 2022-12, 2024-03, 2026-11 | streamed (~0.6 GB), only summaries kept |
| **Observed Kraken 5-level depth** (C$50 / C$100 book walks) | Tardis.dev "book_snapshot_5", same free days | 22 days, 2019-07 → 2026-11: CAD books, USD/CAD and SOL/USD, plus 4 days of BTC/ETH USD as a check | streamed (~1 GB), only summaries kept |
| **Kraken public trades** (with aggressor side) | Kraken official REST `/0/public/Trades` | 28 sampled days per pair: 2016–2019 quarterly; crash days 2017-12-17, 2018-02-06, 2020-03-12/13, 2021-05-19, 2022-05-12, 2022-06-13, 2022-11-09; plus calibration days | ≤ 40,000 trades/pair-day; 6.6 MB compressed |
| **Ndax daily OHLCV** | Ndax public API `GetTickerHistory` | BTC/CAD and ETH/CAD from 2018-03-21; SOL/CAD from 2021-12-25 | 0.7 MB |
| **Ndax and Kraken books today** | our 7-day read-only collector (`cost-study/`) | 2026-11-22 onward | — |
| **Fee schedules and minimum orders** | archived official pages (Wayback Machine) + today's official pages and public API | 2017 → 2026 | — |

**Not available for free, so not used:**
* **Ndax historical order books or trades.** Ndax's public API has no trade history, and its archived ticker bid/ask fields **fail a plausibility check**: BTC shows exactly 0.432 % on every day from 2021 to 2026, and 2018–2020 values are 0 or nonsense. They were therefore *not* used.
* **Free book data before 2019-06-04**, when Tardis's Kraken coverage starts.

---

## 3. Observed vs estimated

| Cost component | Period | Status |
|---|---|---|
| Kraken CAD/USD spreads and C$50 book-walk cost | 2019-07 → 2026-11 | **OBSERVED** on the sampled days; **interpolated** between them (sources used in the simulation: 21 % observed-day, 63 % interpolated, 16 % assumed) |
| Kraken spreads | **before 2019-07** | **ASSUMED**: the first observation (2019-07) is carried back, with a ×2 stress variant. The two estimators tried could not be trusted (§3.1). |
| Kraken spreads **on crash days** | 2020-03-12/13, 2021-05-19, 2022 | not first-of-month, so **not observed**. Trade-based **estimates** only (§3.1). |
| Ndax spread / C$50 cost | all history | **today's OBSERVED level** (collector), applied to all history as an **assumption**; ×2 and "never cheaper than Kraken" variants |
| Ndax premium vs Kraken CAD | 2019 → 2026 | **observed** daily closes (3-day median); a noisy proxy, used as a sensitivity only |
| Limit-order fills | 2016 → 2026 | **modeled**: fills only if a later Kraken hourly bar *trades through* the limit by 0.05 %. No historical queue data exists. |
| Kraken fees | 2017 → 2026 | **verified** from archived pages; switch dates approximate (§4) |
| Kraken minimum orders | 2020-03 → 2026 | **verified** from archived support pages; before 2020-03 **assumed** equal to 2020-03 |
| Kraken FX conversion fee (0.20 %) | all | verified today; **assumed** for the past |

### 3.1 Why pre-2019 spreads are an assumption, not an estimate

Two estimators were calibrated against the observed Kraken spreads on the same months:

* **Close-high-low estimator** (Abdi–Ranaldo) on Kraken's official hourly bars:
  * correlation with observed spreads (log scale): **0.37**;
  * after scaling, only **26 %** of months land within 2× of the observed value.
  * The estimator mostly measures volatility, not spread.
* **Trade-based buyer/seller price gap** from Kraken's official trades. Fills are first grouped into orders, then the first fills of opposite-side orders < 10 s apart are compared:
  * 35 overlapping months; correlation **0.64**;
  * after scaling, only **11 %** land within 2× of the observed value.
  * Kraken's 2016–2018 CAD markets traded too rarely (often < 50 usable pairs a day) for any estimate.
* **Crash days, trade-gap estimate (raw, not calibrated, indicative only):**
  * **12–13 Mar 2020:** BTC/CAD gap 38–51 bps, about 1.5–2× the spread interpolated from the Jan and Apr 2020 observations; BTC/USD gap 10–11 bps.
  * **2022 crash days:** BTC/CAD 3–24 bps, ETH/CAD 19–22 bps.
  * So costs on crash days were plausibly 1.5–2× normal for a short time. For S3 this matters little, because it trades a few times a month.

Neither estimator is good enough to stand in for data, so pre-2019 costs are labeled ASSUMED and stress-tested at ×2. The estimates are kept in `spread-model.json` for reference only.

### 3.2 What the observed books show

C$50 market-order cost per side (half-spread + impact) on Kraken CAD books:

| Date | BTC/CAD | ETH/CAD | USD/CAD (C$100) |
|---|---|---|---|
| 2019-07-01 | **63 bps** | **88 bps** | not listed |
| 2021-01-01 | 10 | 20 | 16 |
| 2022-06-01 | 4 | 11 | 2 |
| 2024-01-01 | 2.5 | 4 | 1.4 |
| 2026-11-01 | 1.4 | 2.8 | 1.5 |
| **2026-11-22 (live, falling market)** | 2.6 | 18 | 25 |

Kraken's USD books (BTC, ETH) cost ≤ 0.3 bps per side on every check date.

**What this means:**
* Kraken's CAD books **tightened about 30×** between 2019 and 2026.
* **Spreads depend strongly on the market regime.** On 22 Nov 2026, BTC was down about 20 % from 1 Nov, and the live ETH/CAD spread was 76 bps and USD/CAD 30 bps. Kraken's REST and websocket books agreed, so this is the real market, not a data error.
* One sampled day per quarter therefore carries real sampling noise. This is why every conclusion below is stress-tested.

---

## 4. Fee schedules and minimums (verified)

**Kraken Pro, entry tier (maker / taker):**

| Period | Fees | Verified from |
|---|---|---|
| ≤ 2024-03-05 | **0.16 % / 0.26 %** | archived pages 2017-09, 2019-03, 2020-07, 2022-06, 2023-10, 2024-03 |
| by 2024-07-07 → ≥ 2025-10-04 | **0.25 % / 0.40 %** | archived pages 2024-07, 2025-07, 2025-10 |
| by 2026-03-27 → today | **0.40 % / 0.80 %** | archived pages 2026-03, 2026-07; today's CA page |

The simulation switches on 2024-05-01 and 2026-01-01; the exact dates are not known.

**Ndax:** **0.20 % flat** (maker = taker) on archived pages from 2019-10, 2023-06 and 2024-05, and today. Ndax launched in March 2018.

**Kraken minimum order sizes** (archived support article 205893708):

| Snapshot | BTC | ETH | SOL |
|---|---|---|---|
| 2020-03 | 0.002 | 0.02 | — |
| 2021-05 | 0.0001 | 0.004 | — |
| 2022-05 | 0.0001 | 0.001 | 0.02 |
| 2023-05 | 0.0001 | 0.01 | 0.25 |
| 2024-06 | 0.0001 | 0.002 | 0.05 |
| today (API) | 0.00006 | 0.002 | 0.05 |

Ndax today: BTC 0.00001, ETH 0.0001, SOL 0.01. Ndax's historical minimums were not found, so today's are assumed.

**Other costs:**
* Kraken FX (USD/CAD) fee: 0.20 %.
* The Kraken USD route pays CAD→USD at the start and USD→CAD at the end: **0.93 %** of the account in total, at observed USD/CAD costs.

---

## 5. Total cost per order side by market cycle (BTC; basis points; C$50)

| Cycle | Kraken CAD market, historical fee | Kraken CAD market, **today's fee** | Kraken USD market, today's fee | Ndax market (today's spread) | Ndax, conservative (≥ Kraken's spread) |
|---|---|---|---|---|---|
| 2017–18 (assumed spreads) | 89 | 143 | 82 | 45* | 83* |
| 2019 recovery | 74 | 128 | 81 | 45 | 69 |
| Mar 2020 crash | 41 | 95 | 81 | 45 | 45 |
| 2020–21 bull | 34 | 88 | 80 | 45 | 45 |
| 2022 bear | 31 | 85 | 80 | 45 | 45 |
| 2023–26 | 45 | 82 | 80 | 45 | 45 |

\* Ndax did not exist before March 2018.

**ETH is similar:**

| Cycle | Kraken CAD, today's fee | Ndax |
|---|---|---|
| 2017–18 | 168 | 40–108 |
| 2023–26 | 84 | 40 |

**What dominates today's costs:**
* **The fee.** On Kraken today the 0.80 % taker fee is about 95 % of the total cost per side.
* On Ndax, the 0.20 % fee and the spread (~0.20–0.25 % this stressed week) are about equal.

---

## 6. Strategies recalculated (frozen rules, $100, Kraken official daily prices)

**Model:**
* Signals use Kraken USD daily closes; fills happen at the next daily open plus each route's cost.
* "Today's fees" means today's fee schedule and today's minimums applied to all history. **This is the decision-relevant comparison.**
* "Historical fees" means what each period's fee schedule would have charged.

**Windows:**
* **2018-04 → 2026-09** is the only window in which both venues existed.
* 2016-07 → 2026-09 is Kraken only.

### 6.1 S3 (200-day trend × 40 % volatility target, BTC + ETH), 2018-04 → 2026-09

| Route | Final | Net annual | Max DD | Orders (missed) | Fees |
|---|---|---|---|---|---|
| *Zero cost (gross)* | *$1,106.52* | *32.65 %* | *38.8 %* | 282 | — |
| *S3 shadow setting 0.20 % + 0.05 %* | *$975.57* | *30.70 %* | *40.0 %* | 282 | $49.91 |
| **Ndax CAD · market** | **$891.98** | **29.34 %** | 40.8 % | 282 | **$47.04** |
| Ndax · + observed premium changes | $893.01 | 29.35 % | 40.8 % | 281 | $46.92 |
| Ndax · spread ≥ Kraken's history (conservative) | $870.69 | 28.97 % | 41.4 % | 282 | $45.92 |
| Ndax · spread ×2 (stress) | $797.52 | 27.64 % | 41.8 % | 283 | $43.72 |
| Kraken CAD · **post-only**, today's fees | $830.22 | 28.25 % | 40.4 % | 285 (23) | $89.43 |
| Kraken USD · hybrid + conversion, today's fees | $829.71 | 28.24 % | 41.3 % | 283 | $99.72 |
| Kraken CAD · hybrid 4 h, today's fees | $742.15 | 26.57 % | 42.5 % | 289 | $96.35 |
| Kraken USD · market + conversion, today's fees | $738.84 | 26.50 % | 42.7 % | 283 | $168.48 |
| Kraken CAD · **market (taker)**, today's fees | **$698.76** | **25.68 %** | 44.1 % | 283 | **$158.76** |
| *Kraken USD · market + conversion, **historical** fees* | *$933.04* | *30.02 %* | 40.1 % | 282 | $90.65 |
| *Kraken CAD · post-only, historical fees* | *$912.05* | *29.67 %* | 39.3 % | 282 (23) | $53.55 |
| *Kraken CAD · market, historical fees* | *$885.32* | *29.22 %* | 41.5 % | 283 | $85.53 |

**Kraken only, 2016-07 → 2026-09, today's fees:**

| Route | Final | Net annual |
|---|---|---|
| Kraken CAD market | $3,618 | 41.9 % |
| Kraken CAD hybrid | $4,113 | 43.7 % |
| Kraken USD hybrid | $4,669 | 45.5 % |
| **Kraken CAD post-only** | **$4,973** | **46.4 %** |
| *Gross (zero cost)* | *$6,590* | *50.4 %* |

That window includes the 2017 boom, so its large dollar figures are not comparable to the 2018+ table.

**Per cycle**, net return of S3 (2018-04 window; the 2017–18 column comes from the 2016 Kraken-only window):

| Cycle | Gross | Ndax market | Kraken CAD post-only (today) | Kraken CAD market (today) |
|---|---|---|---|---|
| 2017–18 (Kraken only) | +383.7 % | n/a | +373.8 % | +326.1 % |
| 2019 recovery | +46.3 % | +42.7 % | +43.3 % | +35.7 % |
| Mar 2020 crash | −22.9 % | −24.1 % | −23.6 % | −25.7 % |
| 2020–21 bull | +325.2 % | +310.2 % | +314.1 % | +295.7 % |
| 2022 bear | −20.7 % | −21.7 % | −24.8 % | −22.6 % |
| 2023–26 | +197.3 % | +163.1 % | +156.0 % | +135.4 % |

Close-to-close drawdown within each cycle is 21–32 % on every route.

**Findings for S3:**
* **Cheapest overall at today's fees: Ndax.**
  * Ndax beats Kraken taker orders in every cycle.
  * Against Kraken post-only the result is mixed:
    * post-only was slightly better in 2019 (+43.3 % vs +42.7 %) and 2020–21 (+314.1 % vs +310.2 %);
    * Ndax was better in 2022 (−21.7 % vs −24.8 %) and 2023–26 (+163.1 % vs +156.0 %).
  * Post-only lost most in the 2022 bear, because it missed some exits in falling markets.
  * Ndax's overall lead over post-only (~1.1 pp/yr) is therefore real but modest. It rests mainly on the 2022–26 period and on today's 0.80 % Kraken fee.
* **On Kraken, post-only beats hybrid and market.**
  * 285 of 308 post-only orders filled (93 %).
  * The 23 misses cost little, because S3 re-decides the next day.
  * The 4-hour hybrid *underperforms* post-only: the orders that don't fill are disproportionately those where the price ran away, so the fallback market order is adverse selection.
* **S3's shadow cost setting (0.20 % + 0.05 %) is about 1.4 pp/yr more optimistic than Ndax's measured reality.** This is informational only; S3 was not changed.

### 6.2 Small-risk strategies A–D, 2018-04 → 2026-09 (today's fees and minimums)

| Strategy | Best Kraken route | Ndax market | Meets 2 %? |
|---|---|---|---|
| A BTC momentum | post-only: 1.39 %/yr, DD **1.81 %** | 1.43 %/yr, DD **2.43 %** | Kraken ✔ · Ndax ✘ |
| B 3-asset momentum | post-only: 0.95 %/yr, DD **1.46 %** | 1.39 %/yr, DD **3.03 %** | Kraken ✔ · Ndax ✘ |
| C 55/10 breakout | post-only: 1.22 %/yr, DD **2.14 %** | 1.54 %/yr, DD **2.38 %** | ✘ both (✔ only at Kraken's *historical* fees) |
| D 20/10 breakout | post-only: 2.13 %/yr, DD 3.74 % | 2.84 %/yr, DD 4.89 % | ✘ both |

**Notes on these strategies:**
* **Why Ndax raises their drawdowns:**
  * Kraken's minimums block hundreds of entries: A 413, B 2,581.
  * Ndax's ~$1 minimums let those trades through, so returns rise slightly and drawdowns rise above 2 %.
  * This repeats the earlier finding, now verified across the 2019–2026 cycles.
* **Kraken's historical minimums were much larger** (0.002 BTC ≈ $6–$40 in 2018–2020). With them:
  * A, B and C would have traded far less (A: 21 orders instead of 83);
  * A would have earned only 0.66 %/yr.
* Even the best results are ~1–1.6 %/yr. **No execution method makes these strategies worthwhile, or makes S3 compatible with 2 %.**

---

## 7. Recommendation

1. **For S3 (or any strategy with ~$50 orders and modest turnover): Ndax, CAD pairs, plain market orders.**
   * About +3.7 pp/yr vs Kraken taker orders at today's fees, and +1.1 pp/yr vs Kraken post-only.
   * Fees ~$47 vs ~$159 over 8.5 years on S3.
   * Also cheaper to withdraw: $1.50 vs C$10.
   * Post-only on Ndax gives no fee benefit, because maker and taker are both 0.20 %.
2. **If Kraken is used: post-only limit orders at the best bid/ask, re-decided daily if unfilled.** Not taker orders, and not the 4-hour hybrid.
3. **For the 2 %-target strategies (A, B): Kraken post-only**, because its minimum order sizes act as a risk filter. This keeps the 2 % target satisfied, at only ~1–1.4 %/yr.
4. **Keep the 2 % target; it remains unreachable for S3 on any venue** (drawdown 39–46 %).

**Change this recommendation if:**
* the 7-day collector (final report due 29 Nov) shows Ndax's C$50 cost persistently above ~0.45 % per side, which is about 2× this week's level;
* Kraken lowers its entry-tier fees again;
* Ndax changes its 0.20 % fee.

---

## 8. Limitations, stated plainly

* **Spread sampling:** spreads come from one day per quarter (plus stress days). Crash-day spreads were *not observed*. Pre-2019 spreads are *assumed* (×2 stress shown).
* **Ndax's spread history is unknown;** today's (stressed-week) level was applied to all history. Ndax's 2018–2020 market was thin (C$2–28 M traded a year), so its early costs were probably higher than assumed. The conservative variant covers this partly.
* **Limit-order fills** use an hourly trade-through rule, not a queue model. This is conservative for fill rate but ignores partial fills.
* **Prices and FX:** prices are Kraken USD daily bars. CAD-account FX moves are not modeled, except the USD route's conversion cost. Kraken's official archive ends 2026-09-30, so the windows stop there.
* **Fee-switch dates** are known only to within months.
* **Not new evidence:** all periods were examined in earlier phases. No rule was changed or tuned.

## 9. Vacation status

* **7-day collector:** the user-level Windows task keeps sampling Ndax and Kraken every 5 minutes **only while this PC is on and awake**. Gaps are recorded, not filled.
* **Final 7-day analysis:** the one-time Claude task "ALPHA TERMINAL: 7-day Ndax vs Kraken cost study — final report" fires on 2026-11-29 at 15:15. It runs only if the Claude app is open, or on its next launch, and analyzes whatever samples exist.
* **No cloud service, paid tool or new infrastructure** was created.

## Files

**Code** (branch `research/costs`, local only, not pushed): `engine/src/research/costs/`
* `kraken-archive.mjs`
* `hist-books.mjs`
* `hist-depth.mjs`
* `hist-trades.mjs`
* `ndax-history.mjs`
* `hist-spreads.mjs`
* `hist-backtest.mjs`

`engine/src/research/dd2/bt.mjs` gained three *optional* hooks: a V-family audit log, `stopExec` and `minQtyAt`. Earlier results were verified byte-identical with the hooks unused.

**Data and results** (private, outside Git): `%USERPROFILE%\AlphaTerminal\research\hist-costs\`
* `kraken-ohlcvt/` (with SHA256SUMS)
* `books-observed.json`
* `depth-observed.json`
* `trades-kraken.json`
* `kraken-trades-raw/`
* `ndax/`
* `spread-model.json`
* `hist-backtest-results.json`
* logs

# Pre-registration: H-L1 "liquidity provision to forced sellers" (wick capture), 2026-11-22

Written and committed **before any run on real data**. Research only: nothing is traded, deployed or merged.

## 1. Why this hypothesis (and why it is genuinely new)

**What has already failed.** Every strategy tested so far is directional: it holds BTC/ETH/SOL during trends, momentum or breakouts.
* A directional position must be tiny to keep drawdown under 2 %. It then earns ~1 %/yr, and pays the spread and taker fee twice per trade.

**H-L1 is a different source of return.** It sells immediacy to forced sellers.
* In crypto, liquidation cascades and panic market sales sweep thin order books within minutes. They push the price far below fair value, after which it partly recovers.
* A resting buy order far below the market is paid this liquidity premium. It is the textbook short-horizon reversal after order-flow shocks.
* Execution is by **maker orders**: the cheapest execution available. No spread is paid and the maker fee is lower.
* Each position is short (hours to days), with a hard stop. Exposure exists only after a crash, never during the long trends that dominated earlier drawdowns.

**No earlier round tested this.**
* Rounds 1–9, strategy-select, DD2 and Phase 3 contain no resting-limit / wick strategy.
* "Short-term reversal after extreme moves" was only *listed* as an idea in STRATEGY-DISCOVERY-MISSION.md.

## 2. Rules (fixed; implemented in `engine/src/research/lab/wick.mjs`, tested in `engine/test/lab-wick.test.mjs`)

* **Volatility, σ:** std of daily log returns over the 30 complete days before the current day.
* **Entry:**
  * every hour, while flat in an asset, rest one post-only BUY limit at L = last hourly close × exp(−z·σ);
  * it fills only if that hour's low trades **through** L by eps = 0.05 %; fill price min(open, L).
* **Exits:**
  * stop = entry × exp(−z·σ) (market sell);
  * take-profit **limit** = entry × exp(m·z·σ) (maker), with **m = 0.5**: recover half the drop;
  * time stop after holdH hours (market sell).
* **Conservative intrabar rule:** if the fill hour also reaches the stop, the trade counts as stopped. Afterwards the order of checks is time stop → stop → target.
* **Size:**
  * risk **r = 0.25 %** of equity between entry and stop;
  * at most 1/n of equity per asset (n = assets in the portfolio), limited by cash;
  * orders below the venue minimum are skipped.
* **Account:** $100 USD, long-only spot, no leverage, shared cash.
* **Drawdown:** strict: all open positions marked at each hour's low, together.

### Settings (the ONLY ones run; all are reported, none is selected)

| | z (drop size, in daily σ) | holdH |
|---|---|---|
| a / b | 1.5 | 24 / 72 |
| c / d | 2.0 | 24 / 72 |
| e / f | 3.0 | 24 / 72 |

## 3. Costs (from `lab/costs.mjs`)

* **Primary: Kraken USD at today's fees** (0.40 % maker / 0.80 % taker, VERIFIED).
  * Exit slippage ASSUMED: 0.10 % BTC/ETH, 0.15 % SOL, 0.25 % other coins.
  * Minimum order $5 ASSUMED.
  * The one-time CAD→USD→CAD conversion (0.93 %, observed) is charged on the account.
* **Secondary:**
  * Kraken at historical fees (verified schedule);
  * Ndax 0.20 % flat: HYPOTHETICAL, because the price path is Kraken's (Ndax has no free intraday history), with Ndax spread +0.25 % on exits.
* **Stress:** eps 0.25 % (the low must trade 0.25 % through the limit) and 2× slippage.

## 4. Data (Kraken's official OHLCVT archive; hourly bars; validated by `lab/data.mjs`)

| Set | Purpose | Assets | Period |
|---|---|---|---|
| **D** | development: mechanics and go/no-go only; nothing is tuned | BTC, ETH portfolio | 2016-01-01 → 2020-12-31 |
| **C1** | first evaluation of H-L1 on the main assets | BTC, ETH, SOL portfolio (SOL from its 2021-06 listing) | 2021-01-01 → 2026-09-30 |
| **C2** | first evaluation on other markets | each of XRP, XLM, LTC, XMR, ETC, ADA, BCH, ZEC, DASH, DOGE alone, $100 each | 2018-01-01 → 2026-09-30 |

**C2 coin list:** the 10 largest non-stable USD hourly files in Kraken's archive, chosen by an objective rule before any run.

**Honesty note:** these price periods were examined by *other* (directional, daily) hypotheses in earlier rounds. They have not been used for *this* hypothesis. Results are therefore "first evaluation of H-L1 on historical data", **not** untouched out-of-sample evidence. Genuinely new evidence can only come from forward PAPER data after implementation (Phase 4).

## 5. Pass criteria (all at the primary cost model)

1. **C1:** at least 4 of 6 settings have net profit > 0 and strict max drawdown < 2 %.
2. **C2:** for at least 4 of 6 settings, the median coin has net profit > 0.
3. **Expectancy:** for the median-performing setting on C1, the pooled C1 + C2 mean R has a 90 % bootstrap CI lower bound > 0.
4. **Stress:** criterion 1 still holds under the stress model, with net > 0 for at least 3 of 6 settings.
5. **Meaningful profit:** label the result "meaningful" only if C1 earns ≥ 3 %/yr net with drawdown < 2 %. Otherwise "positive but too small".

**Outcomes:**
* Passing 1–4 makes H-L1 a Phase 2 candidate (with its execution venue decided on total cost).
* Failing any of them means it is **rejected** and reported as such. No rule or parameter will be changed afterwards to rescue it.
* Set D cannot pass or fail the hypothesis. It is reported, and it only stops the study early if the code misbehaves (for example, fills that contradict the bars).

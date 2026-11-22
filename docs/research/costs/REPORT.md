# Cheapest crypto execution for a $100 Canadian account (2026-11-22)

**Research and simulation only.** No account was opened and no order placed. No bot, S3, production service or
setting was changed. Strategies are frozen; only the execution costs change.

## 1. Venues: verified costs (official pages, read 2026-11-22)

Platforms registered in Ontario (OSC list, updated 2026-11-15) include Kraken, Ndax, Coinbase Canada, Crypto.com,
Bitbuy/Coinsquare, Netcoins, Newton, Shakepay, Wealthsimple, Webull, Questrade, Satstreet and Fidelity.

| Venue | Spot maker / taker | Verified? | Minimum order (BTC / ETH / SOL) | CAD deposit / withdrawal | API |
|---|---|---|---|---|---|
| **Ndax** | **0.20 % / 0.20 % flat** (no tiers, no maker/taker split) | ✔ ndax.io/en/fees | **0.00001 / 0.0001 / 0.01** (≈ $1 CAD; public API) | Free / **$1.50** Interac ($4.99 EFT) | ✔ official (AlphaPoint), supported by CCXT |
| Kraken Pro, Tier 1 ($0+) | 0.40 % / **0.80 %** | ✔ kraken.com/ca/pro/fees | 0.00006 / 0.002 / 0.05 (≈ $5); $1 CAD minimum cost | Free / **$10 CAD** Interac (support page) | ✔ full; post-only supported |
| Crypto.com Exchange, Level 1, no CRO | 0.25 % / 0.50 % (0 % maker needs ≥ 50,000 CRO) | ✔ fee page; **Canadian access to the Exchange not verified** | small | not checked | ✔ |
| Bitbuy Pro | 0.50 % / 0.50 % | ✔ official FAQ and fee page | — | — | gated (approval questionnaire) |
| Coinbase Advanced (Canada) | table shown only after sign-in | ✘ unverified (third parties: ≈ 0.50–0.60 % / 0.90–1.20 % entry) | — | — | ✔ |
| Newton, Shakepay, Wealthsimple, Webull | "no commission" but priced through a spread | not compared: no public trading API for automation | — | — | ✘ |

**Notes on the table:**
* **Age:** age of majority in the province (18 in AB, MB, ON, QC, PE, SK; 19 elsewhere; Ndax eligibility page).
* **Ndax order types:** post-only gives **no fee advantage** on Ndax, which charges the same 0.20 % for maker and taker.

## 2. Measured market costs (public order books; 24 samples over 6 minutes, Saturday 2026-11-22)

| Book | Median spread | $50 market-order cost (half-spread + impact) |
|---|---|---|
| Kraken BTC/CAD · ETH/CAD · SOL/CAD | 0.06 % · 0.43 % · 0.36 % | 0.03 % · 0.22 % · 0.18 % |
| **Ndax** BTC/CAD · ETH/CAD · SOL/CAD | **0.52 % · 0.41 %** · 0.04 % | 0.26 % · 0.20 % · 0.02 % |
| Kraken / Coinbase / Crypto.com USD books | ≤ 0.01 % BTC, ≤ 0.06 % ETH, ≈ 0.14 % SOL | ≤ 0.04 % |

**What this means:**
* **CAD books are much wider than USD books.** For a Canadian, the spread can cost as much as the fee.
* Ndax's BTC/CAD mid-price was about **0.9 % above Kraken's** in this sample. A constant premium mostly cancels between
  buying and selling, but it is a risk.
* **These are estimates from one short weekend sample.** They need a multi-day measurement before being relied on.

## 3. Execution methods (simulated on real hourly prices, 2021-07 → 2026-11)

* **MARKET:** taker fee + the measured market-order cost.
* **MAKER:** post-only at the best bid or ask. It fills only if a later hourly candle trades **through** the limit by
  0.05 % within 24 h; otherwise the order is **missed** and the strategy re-decides at the next close.
* **HYBRID:** the same limit order for 4 h, then a market order.
* Stops are always market.
* Missed and partial fills, delays and adverse moves come from real price paths.

**Results:**
* Where maker and taker fees differ (Kraken, Crypto.com), **HYBRID is cheapest**: it saves most of the fee gap without
  missing trades.
* MAKER alone misses 6–24 orders per strategy, which costs return (S3 on Ndax: 12.7 % vs 14.0 %/yr).
* On **Ndax**, MARKET ≈ HYBRID, and MAKER is worse.

## 4. Strategies recalculated (2021-07 → 2026-11, $100 start)

**S3 (frozen):**

| Venue · method | Final | Net annual | Max DD | Orders (missed) | Fees |
|---|---|---|---|---|---|
| Kraken CAD · MARKET (current taker) | $171.21 | 10.5 % | 30.0 % | 169 (0) | $44.60 |
| Kraken CAD · HYBRID | $195.06 | 13.2 % | 27.3 % | 167 (0) | $27.08 |
| Kraken USD · HYBRID (+ one-time CAD→USD conversion, not included) | $203.44 | 14.1 % | 27.3 % | 165 (0) | $25.88 |
| **Ndax CAD · MARKET** | **$202.40** | **14.0 %** | 27.5 % | 169 (0) | **$12.20** |
| Ndax CAD · HYBRID | $202.43 | 14.0 % | 27.4 % | 174 (0) | $12.41 |
| Crypto.com USD · HYBRID (access unverified) | $215.17 | 15.3 % | 26.6 % | 165 (0) | $16.70 |
| *Reference: S3's current setting 0.20 % + 0.05 %* | $220.24 | 15.8 % | 26.5 % | 165 | $12.86 |

**S3 does not meet 2 % anywhere (27–30 %).**

**Small-risk strategies (A, B, C, D):**

| Strategy | Kraken (any method) | Ndax (any method) |
|---|---|---|
| A BTC momentum | 0.6–0.8 %/yr, DD 1.6–1.9 % ✔ 2 % | 0.9–1.1 %/yr, DD **2.0–2.4 %** ✘ (maker exactly 2.00 %) |
| B 3-coin momentum 0.10 % | 0.5–0.6 %/yr, DD 1.6–1.9 % ✔ | 1.0–1.1 %/yr, DD **2.5–2.7 %** ✘ |
| C 3-coin 55/10 breakout | 1.1–1.2 %/yr, DD 1.8–1.9 % ✔ | 2.0–2.1 %/yr, DD **2.3–2.4 %** ✘ |
| D 3-coin 20/10 breakout | 2.3–2.6 %/yr, DD 3.2–3.6 % ✘ | 3.0–3.3 %/yr, DD 5.1–5.2 % ✘ |

**Why the small-risk strategies fail at Ndax:** Kraken's ~$5 minimum was blocking hundreds of small entries (skipped:
384 for A). At Ndax's ~$1 minimum those trades happen. Returns rise a little, and drawdowns rise above 2 %. **Cheaper
execution does not make the 2 % target achievable**, and it removes an accidental risk filter.

## 5. Recommendation

**Cheapest verified option for a $100 Canadian account: Ndax, CAD pairs, plain market orders** (or limit-then-market;
there is no benefit to post-only on Ndax).
* Verified 0.20 % flat fee, free CAD deposits, $1.50 withdrawals, about $1 minimum orders, official API.
* **Saving against Kraken taker on CAD pairs, for S3, 2021–26:**

  | | Ndax | Kraken taker |
  |---|---|---|
  | Fees | $12.20 | $44.60 |
  | Final balance | $202.40 | $171.21 |
  | Net annual | 14.0 % | 10.5 % |

  That is **about 3.5 percentage points a year**: roughly $6 of fees a year on $100 at S3's turnover.
* Kraken's $10 withdrawal fee (10 % of a $100 account) is another reason against Kraken for a small account.

**If staying on Kraken:**
* Use the **HYBRID** method (post-only, then market after 4 h): 13.2 %/yr instead of 10.5 %.
* Optionally trade USD pairs after a one-time CAD→USD conversion (14.1 %/yr before the conversion cost).

**Uncertain, needs checking:**
* Ndax's CAD spreads and its price premium (one short sample);
* whether Crypto.com's Exchange (cheapest simulated) is available to Canadian retail accounts;
* Coinbase Canada's actual fee tier (shown only after sign-in).

## Verified vs estimated

| Verified | Estimated |
|---|---|
| fee schedules (Ndax, Kraken, Crypto.com, Bitbuy) | spreads and market-order costs (one 6-minute sample) |
| Ndax and Kraken minimum orders (public APIs) | maker fill model (0.05 % trade-through, 24 h / 4 h windows) |
| Ndax deposit and withdrawal fees | Kraken withdrawal fee (support page) |
| OSC registration list | CAD→USD conversion cost (not modeled); USD-based price history used for CAD trading (FX moves not modeled) |

Files: `engine/src/research/costs/spreads.mjs`, `compare.mjs`; results `spreads-live.json`, `compare-results.json`.

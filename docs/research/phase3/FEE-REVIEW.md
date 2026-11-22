# Final read-only review: verified Kraken fees and their effect on S3 and the 2 % target (2026-11-22)

**Scope:**
* Read-only. No change to production bots, S3's settings or running state, balances, databases or deployment.
* Live Worker unchanged: `637e9f32`.
* Recalculations are offline backtests of S3's frozen rules.

## 1. Verified Kraken fees for our modeled account

**Source:** Kraken's own page, kraken.com/pro/fees, read 2026-11-22.

| Tier 1 ($0+ 30-day spot volume) | Maker | Taker |
|---|---|---|
| Spot | **0.40 %** | **0.80 %** |

**Notes on the fee:**
* **Tier:** a $100 account cannot reach Tier 2, which needs $2,500 of 30-day spot volume. S3 turns over roughly 1–3 times its equity a year.
* **Discount:** the page also offers −0.02 % on "eligible discounted pairs". I could not open the list to confirm BTC/USD and ETH/USD, so the best case is 0.78 %.
* **Region:** the rate can differ by region; the page shown was the one served to this computer.
* **Kraken app (non-Pro) buying** is priced separately and is not modeled.

**S3's orders are market orders**, decided at the daily close and filled at the next open, so they pay the **taker fee: 0.80 %**. Maker 0.40 % applies only to resting limit orders that fill without crossing the spread, and a daily rule cannot rely on that.

## 2. Does S3's simulated fee underestimate costs?

**Yes, by a factor of four.**
* S3's frozen setting is 0.20 % per fill + 0.05 % slippage: the production PAPER fee model, not Kraken's.
* All my earlier research used 0.40 % taker, also too low.

**S3's live records:** ACTIVE since 2026-11-21 23:03 UTC; 1 daily close processed; **0 orders, 0 trades, $0 fees, $100 in cash** (both coins below their 200-day average). There are no recorded trades to correct, and nothing was changed.

## 3. S3's historical performance recalculated at the verified fees

Shadow configuration: BTC + ETH, $50 sleeves, Kraken minimums and lot rounding, actual-weight rebalancing band.

| Fee model | 2022-01 → 2026-11 | 2023-07 → 2026-11 (DD2 test period) |
|---|---|---|
| Current S3 setting: 0.20 % + 0.05 % | $216.82 · 17.2 %/yr · max DD 24.6 % · fees $11.63 | $166.61 · 16.3 %/yr · DD 25.2 % · fees $8.48 |
| Kraken maker 0.40 %, no slippage (optimistic: assumes limit orders always fill) | $206.72 · 16.1 %/yr · DD 25.5 % · fees $22.66 | $159.46 · 14.8 %/yr · DD 26.1 % · fees $16.57 |
| Kraken taker 0.78 % + 0.05 % (if discounted) | $181.11 · 13.0 %/yr · DD 28.0 % · fees $41.12 | $141.35 · 10.8 %/yr · DD 28.6 % · fees $30.28 |
| **Kraken taker 0.80 % + 0.05 % (verified Tier 1)** | **$180.00 · 12.8 %/yr · max DD 28.1 % · fees $42.03** | **$140.56 · 10.6 %/yr · max DD 28.7 % · fees $30.97** |

**What the recalculation shows:**
* Over 2022–26 there were 144 orders and none was skipped for the minimum.
* At the verified fee, **fees take about a third of S3's gross gains**, and the historical return falls by about 4–6 points a year.
* Over 2016–2026 (research version), S3 falls from 44.6 %/yr to 41.5 %/yr, and its drawdown rises from 41.8 % to 43.6 %.
* That period is dominated by the 2016–2021 bull market and must not be extrapolated.

## 4. Comparison with the 2 % drawdown target

| Strategy at the verified 0.80 % taker fee | Annual return (history) | Max drawdown | 2 % target |
|---|---|---|---|
| S3 (frozen) | 10.6–12.8 % | 28–29 % (2022–26); 43.6 % (2016–26) | **Fails, by more than 10 ×** |
| Phase 3 A: BTC momentum, 0.25 % risk | 1.19 % | 2.07 % | **Fails** (passed at 0.40 %) |
| Phase 3 B: 3-coin momentum, 0.10 % risk | 0.98 % | 1.79 % | Meets, barely; about 1 %/yr |
| Phase 3 C: 3-coin 55/10 breakout | 1.31 % | 1.96 % | Meets, barely; about 1 %/yr |

**Why S3 cannot meet the target:**
* Scaling S3 down to 2 % would need about 5 % exposure: about $1.60 per coin, below Kraken's about $4 minimum (shown earlier).
* At the higher fees, the scaled-down return would be close to zero.

## 5. Limitations

* Fee tier and region are taken from the page served to this computer. The −0.02 % pair discount is unconfirmed. Withdrawal, deposit and funding costs are not modeled.
* Slippage of 0.05 % is assumed. Real slippage at $50 order sizes on BTC/ETH is likely small, but unmeasured.
* The fills use daily candles (S3 trades at the next open; the live shadow uses the first 1-minute candle after acceptance). Spreads at that minute are not modeled.
* All history used here was examined in earlier rounds. These are historical figures, not forecasts.
* S3's running shadow still uses 0.20 % + 0.05 %, by instruction. Its reported results will therefore **overstate** what a real Kraken Tier 1 account would earn, by roughly a third of gross gains when it trades.

## 6. Conclusion: is further strategy development justified?

**No, not under the current constraints.**
* With Kraken's verified 0.80 % taker fee and $4–5 minimum orders, the strategies that fit within a 2 % drawdown earn about **1 % a year** historically, and one of the three now fails the limit.
* That is below what interest-bearing cash typically pays, with more risk and no evidence of a general edge (Phase 3: none on 41 other markets).
* S3 earned more historically (10–13 %/yr at verified fees), but with drawdowns of 28–44 %, which the 2 % target excludes.

**Development is paused until one of these holds:**
* genuinely new evidence, such as the S3 shadow's own forward record over many months;
* or a deliberate change of research constraints: drawdown target, account size, instruments, or fee tier.

All research and code are preserved on local branches:
* `research/dd2` (also on GitHub);
* `research/phase3`, `shadow/phase3`, `trial/s3-paper` and `lab/stage-0` (local; `trial/s3-paper` is on GitHub).

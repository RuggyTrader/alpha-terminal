# Profitability audit of the four funded PAPER OTE bots (2026-11-16)

**Investigation only.** No strategy, risk setting, wallet, position, order or execution rule was changed.

**Data:**
- One read-only snapshot of the authoritative Worker ledger, taken at **2026-11-16T18:39:52Z** (`bot_positions`, `bot_fills`, `trades`, `portfolio_wallets`, `bot_pending_orders`).
- The raw snapshot is kept privately outside git.
- Strategy Mirror, research trials and backtests are excluded from every live figure below.

## 1. Portfolio (funded PAPER)

| Item | Value |
|---|---|
| Starting capital (net funding) | $100.000 |
| Account equity | $99.586 (all cash: nothing reserved, no open position) |
| Verified realized net P&L | **−$0.414** |
| Unrealized P&L | $0.00 (no open position) |
| Total return | −0.41% |
| Completed trades | 8 (7 bot ledger, 1 legacy ALPHA-02 ledger) |
| Wins / losses after fees | 1 / 7 (win rate 12.5%) |
| Wins / losses before fees | 4 / 3, plus 1 at exactly 0 (win rate 50%) |
| Profit factor after fees | 0.05 (before fees 2.35) |
| Maximum drawdown (closed trades) | $0.437 |
| Average net trade | −$0.052 |
| Total fees paid | **$0.553** |
| Gross trading result before fees | **+$0.139** |

**Ledger checks (all hold):**
- Every recorded gross P&L equals quantity × price move.
- Net = gross − entry fee − exit fee on every trade.
- Every fill was charged exactly 0.20% of its notional (the Ndax-equivalent model).
- Equity = funding + realized net, to the micro-dollar.

## 2. Per bot

| Bot | Trades | Gross | Fees | Net | Win rate (before / after fees) | Avg win / loss (net) | Avg hold | Max DD | Avg move captured | Avg planned R:R | Avg realized R (gross) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SOL Flare (SOL 1m) | 1 | +0.066 | 0.079 | −0.013 | 100% / 0% | — / −0.013 | 96 min | 0.013 | +0.33% | 4.14 | 0.48 |
| SOL Orbit (SOL 5m) | 3 | −0.023 | 0.159 | **−0.182** | 33% / 0% | — / −0.061 | 17 min | 0.182 | −0.09% | 1.46 | 0.03 |
| BTC Hash (BTC 1m) | 4 | +0.096 | 0.315 | **−0.219** | 50% / 25% | +0.023 / −0.081 | 29 min | 0.242 | +0.12% | 3.92 | 0.47 |
| BTC Atlas (BTC 5m) | 0 | — | — | — | — | — | — | — | — | — | — |

- **Largest losses:** BTC Hash (−$0.219) and SOL Orbit (−$0.182).
- **BTC Hash** had a positive gross result (+$0.096), but its fees ($0.315) were more than three times that.
- **SOL Orbit** includes the legacy-ledger trade, recorded with no fee under the legacy "none" cost profile.

## 3. Fee impact, every completed trade

| # | Bot · side | Entry / exit notional | Entry + exit fee | Gross (%) | Net (%) | Stop dist. | Target dist. | Fees ÷ planned risk | Exit |
|---|---|---|---|---|---|---|---|---|---|
| 1 | SOL Orbit LONG (legacy) | 9.92 / 9.89 | 0 + 0 | −0.032 (−0.32%) | −0.032 | not recorded | not recorded | — | not recorded |
| 2 | BTC Hash SHORT | 19.86 / 19.89 | 0.0397 + 0.0398 | −0.029 (−0.15%) | −0.109 (−0.55%) | 0.15% | 0.58% | **2.71** | initial stop |
| 3 | BTC Hash LONG | 19.75 / 19.71 | 0.0395 + 0.0394 | −0.042 (−0.21%) | −0.121 (−0.61%) | 0.21% | 0.83% | **1.87** | initial stop |
| 4 | BTC Hash SHORT | 19.63 / 19.57 | 0.0393 + 0.0391 | **+0.066** (+0.34%) | −0.012 (−0.06%) | 0.33% | 1.30% | 1.22 | moved stop (after +1.0 R) |
| 5 | SOL Orbit LONG | 19.86 / 19.86 | 0.0397 + 0.0397 | 0.000 (0%) | −0.079 (−0.40%) | 0.93% | 1.37% | 0.43 | break-even stop at entry |
| 6 | SOL Flare SHORT | 19.86 / 19.79 | 0.0397 + 0.0396 | **+0.066** (+0.33%) | −0.013 (−0.07%) | 0.70% | 2.88% | 0.57 | trailing stop |
| 7 | SOL Orbit LONG | 19.78 / 19.79 | 0.0396 + 0.0396 | **+0.008** (+0.04%) | −0.071 (−0.36%) | 0.68% | 0.99% | 0.58 | moved stop just above entry |
| 8 | BTC Hash SHORT | 19.62 / 19.52 | 0.0392 + 0.0390 | +0.101 (+0.52%) | **+0.023** (+0.12%) | 0.18% | 0.71% | 2.20 | trailing stop (+2.85 R) |

**Trade outcomes:**
- **Profitable before fees, losses after fees:** 3 (trades 4, 6, 7).
- **Unprofitable even before fees:** 4. That is trades 1, 2 and 3, plus trade 5 at exactly zero.
- **Profitable after fees:** 1 (trade 8).

**Fee drag:**
- Total fees $0.553 against a gross result of +$0.139, so the net loss is −$0.414.
- Fees equal **229% of gross profits** (the gross winners total $0.242).
- **Fees exceed the entire net loss: without fees the eight trades would have made +$0.14.** That is too few trades to call an edge.

**Fee model check:**
- Every bot-ledger fill was charged exactly 0.20% (the configured Ndax-equivalent rate). Fees were not reduced for this report.
- The single legacy trade was recorded under the legacy ledger's "none" cost profile, as that ledger was configured at the time.

**Break-even price move (both directions, every bot):** about **0.40%** of the entry price. That is 0.20% on entry plus 0.20% on exit notional; there is no slippage in the bot-ledger model. A trade must move about 0.40% in its favour before it earns anything.

## 4. Strategy and execution

**Stops are smaller than the fees on the 1-minute BTC bot.**
- BTC Hash's stops were 0.15–0.33% from entry, below the 0.40% round-trip fee.
- Each of its stopped trades therefore lost about 1.9–2.7 times its planned risk.
- Its planned 3.9 R:R becomes **0.33–1.24 net of fees**.

**The break-even and trailing rules lock in fee losses.** Moving the stop to entry (trade 5) or just past it (trade 7) guarantees a net loss of about 0.36–0.40%. Five bot-ledger trades exited on a moved stop. Four of them were profitable before fees, and three of those four ended as losses after fees.

**The position size is set by the wallet, not by the risk setting.**
- Each bot's configured dollar risk is $10, but its $20 wallet caps each position near $20 notional.
- As a result, the actual stop risk was $0.03–0.18 per trade, while the fee is a fixed ~$0.079 per round trip.
- Fees scale with notional, so a larger size would not change the percentage economics. **This report does not recommend increasing size or risk.**

**Comparisons:**

| Comparison | Gross | Net | Note |
|---|---|---|---|
| SHORT (4 trades) | +$0.204 | −$0.111 | |
| LONG (4 trades) | −$0.066 | −$0.303 | |
| SOL 1m vs SOL 5m | | −$0.013 (1 trade) vs −$0.182 (3) | |
| BTC 1m vs BTC 5m | | −$0.219 (4) vs no trades | |

The samples are far too small to rank directions or timeframes.

**What the records do not support:** no entry or exit rationale beyond the recorded levels and exit types is claimed.

## 5. Strict-fill comparison

| | Before the switch (6 trades) | After 2026-11-16T03:19:37Z (2 trades) |
|---|---|---|
| Gross | +$0.029 | +$0.110 |
| Fees | $0.396 | $0.157 |
| Net | −$0.367 | −$0.048 |

**Strict-rule compliance:** both post-switch entries filled on a candle that started after the ledger accepted the order, at the limit price and for exactly the accepted quantity (`worker/scripts/strict-fill-observe.mjs`: 10 orders, 0 violations, 0 duplicates).

**This is not evidence of an improvement.** Two trades cannot show one.

## 6. Historical evidence for these exact configurations

**Round 1** (`docs/research/2026-11-15/`): the same original strategies, at 0.20% per fill, on the untouched out-of-sample period 2 Oct – 12 Nov:

| Bot | Trades | Gross before fees | Net | Profit factor | Break-even fee per fill |
|---|---|---|---|---|---|
| SOL Flare (1m) | 418 | −$0.52 | −$15.10 | 0.05 | none (negative even at 0%) |
| SOL Orbit (5m) | 145 | +$1.66 | −$7.46 | 0.12 | 0.031% |
| BTC Hash (1m) | 339 | +$0.92 | −$14.23 | 0.04 | 0.008% |
| BTC Atlas (5m) | 85 | +$2.07 | −$4.01 | 0.20 | 0.063% |

**Rounds 4 and 5** (5.4 years, more markets, strict fills) found the same pattern: 5m–1h OTE loses heavily after fees. No hybrid OTE hypothesis passed.

**Conclusion: prior research does not establish positive out-of-sample expectancy after realistic costs for any of the four live configurations.** It establishes the opposite. Their gross edge (0.01–0.06% of turnover) is far below the 0.40% round-trip cost.

**The live result agrees with that research. It does not add evidence of its own:** eight trades are far too few.

## 7. Recommendations (nothing implemented; owner decisions)

**Bot by bot:**

| Bot | Recommendation | Basis |
|---|---|---|
| SOL Flare | **Consider an authorized pause** (or keep as the baseline knowingly) | No edge even before fees out-of-sample (418 trades) |
| BTC Hash | **Consider an authorized pause**, or keep only as the baseline | Stops below the fee, so every stopped trade loses 2–3× its planned risk. Largest live loss. Break-even fee 0.008% per fill |
| SOL Orbit | **Additional research** (fee-aware break-even rule, below) | Its break-even exits lock in −0.40% per trade |
| BTC Atlas | **Continue PAPER observation unchanged** | No live trades yet. Least-bad historically, but still negative after fees |

**Hypotheses for separately tested improvements (none implemented):**

1. **Fee-aware entry filter.** Skip setups whose stop distance is under 2× the round-trip fee, i.e. under 0.8%.
   - Expected benefit: removes the trades whose planned risk is smaller than their cost.
   - Caveat: round 1 found such filters mostly reduce the number of trades, cutting the out-of-sample loss from −$40.80 to −$1.77 at minNetRR 2.0. This only reduces losses; it is not a source of edge.
2. **Fee-aware break-even.** Move the stop to entry ± the round-trip fee, instead of to the entry price itself.
   - Expected benefit: break-even exits stop costing 0.40%.
3. **Testing for any change:** pre-register it, run it on data not yet examined with strict fills, at 0.20% and 0.40%, and require ≥ 30 out-of-sample trades with positive net and a confidence interval above zero. Only then propose a frozen forward PAPER trial.

**Realistic expectation:** rounds 4 and 5 suggest these changes are more likely to reduce losses than to create a positive edge.

## Executive summary

1. **Why it is losing money:** fees. Eight trades made +$0.14 before fees and paid $0.55 in fees. The strategy's moves (about 0.07% average, ≤ 0.52% best) are smaller than the 0.40% round-trip cost.
2. **How much of the loss is fees:** all of it. Fees ($0.553) exceed the whole net loss ($0.414).
3. **Profitable without fees?** Slightly, +$0.14 over 8 trades. That is not statistically meaningful, and round 1 found SOL Flare negative even before fees.
4. **Best and worst bot:** least bad SOL Flare (−$0.013, one trade); worst BTC Hash (−$0.219). BTC Atlas has no trades.
5. **Are the 1-minute bots viable at 0.20% per fill?** No. Historically, BTC 1m breaks even only at a 0.008% fee and SOL 1m at none. Live BTC 1m stops are below the fee itself.
6. **Evidence of positive net expectancy for OTE?** None, live or historical.
7. **What next:** an owner decision on pausing the 1-minute bots; fee-aware filter and break-even research under the standard protocol; and the BTC trend trial, which is the only candidate with positive historical evidence and is still not started.

**Established findings:** the fee arithmetic, the ledger reconciliation and the historical out-of-sample results.

**Hypotheses and needing larger samples:** every live comparison between bots, sides, timeframes or strict versus non-strict fills.

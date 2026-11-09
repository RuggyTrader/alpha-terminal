# SOLUSD OTE + PD Array: net profitability after realistic costs (research, 2026-11-09)

Research only. The production engine, its `solusd-5m` settings, balances, saved state and the Windows startup task
were not changed. Past results on one market and one 5-month period; not a forecast.

## Conclusion

**The strategy is not profitable after realistic trading costs, and none of the 576 tested configurations shows a
robust, repeatable edge.** The original settings lose most of the account after costs (−69.6% with Ndax costs,
−94.8% with Kraken Pro Tier 1 costs over 148 days). Before costs they make a small profit (+9.5%), almost all of it
in the first months (+0.75% in the untouched last 40%). Changes that cut trading frequency and widen stops (higher
timeframes, a minimum stop distance, a 200-bar trend filter) reduce the losses a lot, but every configuration chosen
without looking at the future lost money out of sample, the walk-forward lost in all three folds, and the few
configurations that happened to be positive out of sample did so on 1–3 trades. **No configuration is recommended
for adoption.** The best-supported finding is directional: trade far less often, with wider stops, only with the
trend — and that still needs a genuine edge the data does not show.

## Data (verified)

| | |
|---|---|
| Source | Kraken public Trades API (SOLUSD), aggregated to 5-minute candles (`engine/src/cli/history-chunks.mjs`) |
| Period | 2026-06-12 00:00 → 2026-11-09 00:00 UTC (150 days); first 2 days warm-up only |
| Candles | 43,188 of 43,200; 12 five-minute periods had no trades and are left empty (not invented): 08-06 07:05, 07:10; 08-20 07:05; 10-30 02:25–03:05 (9 in a row) |
| Integrity | 0 unordered, 0 duplicate timestamps, 0 invalid OHLC, 0 outside the period |
| Cross-checks | Kraken's own OHLC candles: 485 compared, 0 differences. Previously verified 25-day file (Oct 13–Nov 7): 7,191 compared, 0 differences |
| Market | SOL ranged $64.10–$124.55 (start $66.74, end $86.44): a strong rise, then a fall |

## Method

- The engine's own strategy code (`onBar`), long-only, no leverage, 1% risk per trade capped to the balance
  (`sizing.mjs`), compounding from $100.
- **Conservative fills:** a resting limit order fills only when price trades 1 tick through it (stress: 3 ticks).
- **Costs on every fill** (`engine/src/costs.mjs`): limit entries and take-profits pay the maker fee; stop-loss,
  break-even, trailing and time exits pay the taker fee plus slippage.

| Venue | Fees | Slippage on stop exits | Status |
|---|---|---|---|
| Kraken Pro, Tier 1 (< $2.5K 30-day volume) | 0.40% maker / 0.80% taker | 0.03% | **Verified**: kraken.com/pro/fees (read 2026-11-09); live SOLUSD book: spread $0.02 (0.023%), a $100 market buy filled at the best ask. A −0.02% "selected pairs" discount was not confirmed for SOL/USD |
| Ndax | 0.20% flat (no maker/taker split) | 0.10% | Fee **published** (ndax.io/fees, read 2026-11-09). Ndax trades SOL against CAD; its spread and depth were **not measured** (no connection made): the slippage is an **estimate**. Minimum order ≈ $1–5 (help centre) |

- **Grid (576):** timeframe 5/15/30/60 min × take-profit extension 0.25 (original), 0, −0.27, −0.618 × exits
  (original break-even at 45% + trailing from 5%; none; later: break-even 60%, trailing 50%) × minimum stop distance
  0 / 0.8% / 1.5% × 200-bar EMA trend filter off/on × minimum PD-array score 1/2. Baseline = the original settings
  (5 min, TP 0.25, original exits, no filters, score 1).
- **Selection:** only the first 60% (2026-06-14 → 2026-09-10); at least 15 trades and drawdown ≤ 15% there. Strict
  rule: also profitable after Ndax costs in both halves of that period and profit factor ≥ 1.2. The last 40%
  (2026-09-10 → 2026-11-09) was used only after selection. Anchored 3-fold walk-forward over the whole period.

Commands (engine/): `node src/cli/research.mjs --candles data/SOLUSD-5m-150d.json --out runs/research-150d`, then
`node src/cli/research-oos-winners.mjs ...`. Full output: `docs/research/report-150d.json`, `oos-winners-150d.json`.

## Original strategy (baseline)

| Costs | Period | Trades | Net return | Max drawdown | Profit factor | Win rate | Avg net / trade | Costs paid |
|---|---|---|---|---|---|---|---|---|
| Ndax | full | 271 | **−69.59%** | 69.59% ($69.59) | 0.12 | 14.4% | −$0.26 | $74.82 |
| Ndax | selection 60% | 165 | −49.90% | 49.90% | 0.15 | 17.0% | −$0.30 | $55.09 |
| Ndax | **out of sample 40%** | 106 | **−39.29%** | 39.29% | 0.05 | 10.4% | −$0.37 | $39.39 |
| Kraken Pro T1 | full | 271 | **−94.84%** | 94.84% | 0.03 | 4.8% | −$0.35 | $97.68 |
| Kraken Pro T1 | out of sample | 106 | −70.07% | 70.07% | 0.00 | 0.9% | −$0.66 | $69.70 |
| No costs | full | 271 | +9.48% | 4.64% ($5.10) | 1.28 | 38.8% | +$0.035 | $0 |
| No costs | out of sample | 106 | +0.75% | 4.40% | 1.06 | 39.6% | +$0.007 | $0 |

By thirds of the period (Ndax): −38.5%, −26.0%, −33.2%. Stress, out of sample (Ndax): slippage 0.20% −44.3%;
0.30% −48.9%; fees 0.25% −45.4%; 3-tick fills −37.9%. Default touch fills (TradingView-style) instead of 1-tick:
full period −70.7% — the conservative fill rule is not what makes it lose.

**Why it loses:** the stops are very tight (often < 1% from entry). At 1% risk and no leverage almost every position
is the whole balance, so one round trip costs 0.4–0.5% of the balance (Ndax) or 1.2%+ (Kraken) — about half to more
than the whole risk. The gross edge is about 0.035% of the balance per trade; costs are ten times that.

## Selected configurations (chosen on the first 60% only)

Top by selection-period return (all 10 listed in `report-150d.json`): every one lost money out of sample after Ndax
and Kraken costs; most traded only 3 times out of sample.

The strict rule kept two:

| | Robust pick 1 | Robust pick 2 |
|---|---|---|
| Settings | 5 min, TP extension −0.27, no break-even / trailing, stop ≥ 0.8%, no trend filter, score ≥ 1 | 15 min, TP extension −0.618, original exits, stop ≥ 0.8%, no trend filter, score ≥ 1 |
| Selection (Ndax) | +11.98%, 15 trades, DD 5.43%, PF 2.16, win 53%, avg +$0.80 | +5.61%, 18 trades, DD 4.31%, PF 1.57, win 33%, avg +$0.31 |
| **Out of sample, Ndax** | **−4.11%**, 3 trades, DD 4.11% ($4.11), PF 0, win 0%, avg −$1.37 | **−6.60%**, 11 trades, DD 6.60% ($6.60), PF 0.18, win 18%, avg −$0.60 |
| Out of sample, Kraken T1 | −6.05% | −13.52% |
| Out of sample, no costs | −2.77% | −1.58% |
| Stress OOS (slip 0.3 / fee 0.25 / 3-tick fills / Kraken slip 0.06) | −4.64 / −4.38 / −4.12 / −6.13% | −8.54 / −7.58 / −6.61 / −13.79% |
| Thirds of the period (Ndax) | +10.41% (10 tr) / +1.42% (5) / −4.11% (3) | +3.58% (13) / +1.96% (5) / −6.60% (11) |
| Full period (Ndax) | +7.38%, 18 trades, DD 5.43% ($6.16), PF 1.49 | −1.36%, 29 trades, DD 7.28% ($7.75), PF 0.93 |

Both faded steadily from the first period to the last and lost in the untouched period under every cost model,
including no costs: a sign of fitting to the earlier market, not of a repeatable edge.

## Walk-forward (anchored, Ndax costs)

| Fold | Train → test | Chosen (best on all data before the test) | Test: return, trades, PF | Baseline in the same test |
|---|---|---|---|---|
| 1 | Jun 14–Jul 21 → Jul 21–Aug 27 | 15 min, TP −0.618, original exits, no filters | −8.46%, 23 tr, PF 0.31 | −20.51% |
| 2 | Jun 14–Aug 27 → Aug 27–Oct 3 | 15 min, TP −0.618, original exits, stop ≥ 0.8% | −2.01%, 4 tr, PF 0.04 | −28.96% |
| 3 | Jun 14–Oct 3 → Oct 3–Nov 9 | 5 min, TP −0.27, no BE/trail, stop ≥ 0.8% | −2.76%, 2 tr, PF 0 | −22.77% |

Compounded: **−12.78%** (baseline in the same windows: −56.39%). Losing less than the baseline is not profitability.

## Configurations that happened to profit out of sample (descriptive, not selected)

15 of 576 (Ndax), 10 of 576 (Kraken), 78 of 576 with no costs. All 15 Ndax ones use the 200-bar trend filter with a
0.8–1.5% minimum stop on 15- or 60-minute candles, and made **1–3 trades** out of sample (+0.05% to +1.24%) and 2–8
in the selection period, several of them negative there. Too few trades to distinguish skill from luck, and none
would have been chosen without looking at the out-of-sample period. Full list: `docs/research/oos-winners-150d.json`.

Charts: `docs/research/equity-ndax.svg` (baseline and the two picks after Ndax costs), `equity-ndax-picks.svg`,
`equity-no-costs.svg`, `equity-trend-filtered.svg`.

## How confident are these results?

- **High** that the original strategy loses after either venue's costs: 271 trades, every third of the period
  negative, every stress test negative, and the cause (tight stops vs fixed percentage costs) is mechanical.
- **High** that no tested change produces a reliable edge here: selection-based picks, the strict rule and the
  walk-forward all lost out of sample.
- **Low** for anything about the trend-filtered, wide-stop group: a handful of trades.
- Limits: one asset, one 5-month period in which SOL rose sharply and then fell; Ndax liquidity unmeasured; closed-trade
  drawdowns (intra-trade swings not included); limit-fill realism is approximated.

## PAPER simulator recommendations (not implemented; needs approval)

Yes — ALPHA PAPER results are currently cost-free and therefore overstate what a small account would keep.
Recommended, keeping raw strategy performance separate from executable PAPER performance:

1. **Fees per fill**, by venue profile (start with Ndax 0.20% flat; Kraken Pro Tier 1 0.40% / 0.80% as an
   alternative), maker for resting limit entries/take-profits, taker for stops and closes. Record each fee as its own
   portfolio entry (kind `FEE`) so balances, history and the consistency check stay exact.
2. **Slippage** on taker fills: a configurable % against the trade (Ndax estimate 0.10%; Kraken 0.03% measured).
   The ledger already fills at the live Kraken price, which captures part of it.
3. **Spread:** not separately needed while fills use the live last price plus taker slippage; record the source.
4. **Capital limits:** already enforced (balance check, no leverage, long-only, order and exposure limits).
5. **Minimum order sizes:** enforce the venue's minimum (Kraken 0.05 SOL / $0.50 already in the engine's small-account
   sizing; Ndax ≈ $5) in the Worker too, refusing smaller orders with a clear code.
6. **Conservative limit fills:** an engine option (`limitThroughTicks`) already exists for research; for PAPER, keep
   the engine's fill rule and let the ledger's live price decide, as now.
7. **Reporting:** show "gross" (strategy P&L at fill prices) next to "net" (after simulated fees and slippage) on
   Verified Performance and Trade Proof, so the cost of trading is visible on every trade.

## Not changed

Production engine and settings, the running SOLUSD strategy, balances, risk settings, saved state, the Windows
startup task. Nothing deployed; live trading stays disabled.

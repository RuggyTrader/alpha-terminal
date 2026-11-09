# SOLUSD 5m OTE strategy: original-strategy audit and corrected 150-day baseline (2026-11-09)

Research only. No production code, settings, ledger, balance, engine process, Windows task or deployment was
changed. Every number below comes from real Kraken SOLUSD candles and the engine's own strategy code; nothing is
estimated unless it is labelled as an estimate.

Reproduce:

```
cd engine
node src/cli/baseline.mjs --candles data/SOLUSD-5m-150d.json --reference-candles data/SOLUSD-5m-25d.json --out ../docs/research/baseline-150d
node src/cli/parity.mjs --candles data/SOLUSD-5m-25d.json --reference parity/tv-solusd-5m-2026-11-07.json --history-from 2026-10-19T00:00:00Z --out runs/audit-parity
node --test test/baseline.test.mjs test/parity.test.mjs
```

Outputs: [`docs/research/baseline-150d/`](research/baseline-150d/) has `baseline.json` (all metrics),
`trades.csv` (all 579 trades with costs), `fill-property-diffs.json`, `model-a-gross.svg` and `model-b-costs.svg`.

---

## 1. Original strategy audit

Specification: `tradingview/ote_pd_array_strategy.pine` (the version with break-even, trailing stop and the ALPHA
webhook messages). The engine's port is `engine/src/ote.mjs` plus the fill emulator `engine/src/broker.mjs`. The
inputs are in the `solusd-5m` profile (`engine/profiles/solusd-5m.env`).

### Inputs (field by field)

| Group | Input | Your TradingView value | Engine (solusd-5m) | Match |
|---|---|---|---|---|
| Structure | Swing length | 5 | 5 | ✓ |
| | Min leg | 3.5 ATR | 3.5 | ✓ |
| | Max setup age | 32 bars | 32 | ✓ |
| Trade plan | Entry mode | Limit @ 0.705 | Limit @ 0.705 | ✓ |
| | Stop placement | Swing origin (1.0) | Swing origin (1.0) | ✓ |
| | SL buffer | 0.1 ATR | 0.1 | ✓ |
| | TP2 extension | **+0.25** (intentional) | 0.25 | ✓ preserved |
| Confluence | Min score | 1 | 1 | ✓ |
| | FVG / min size | on / 0.1 ATR | on / 0.1 | ✓ |
| | OB / displacement | on / 1 ATR | on / 1 | ✓ |
| | RB / wick / min range / lookback | on / 0.5 / 0.8 ATR / 8 | same | ✓ |
| Display | PD arrays, table, stop line | on | on (no effect on trades) | ✓ |
| | Max zones | 70 | 70 | ✓ (**this one does affect trades**: it caps the zones counted for confluence) |
| Trading | Longs / Shorts | enabled / enabled | true / true | ✓ |
| | Risk | fixed $10 | 10 | ✓ |
| | Break-even / trigger | on / 0.45 | on / 0.45 | ✓ |
| | Trailing / activation / length / buffer | on / 0.05 / 3 / 0.05 ATR | same | ✓ |
| Sessions | Hours / weekend / sleep | off / off / off | off / off / off | ✓ |
| | Time zone | America/New_York | America/New_York | ✓ |
| | Other session times | Pine defaults | Pine defaults (asserted in `parity.test.mjs`) | ✓ |
| Notifications | all | as supplied | no effect on trades | ✓ |

### Properties

| Property | Recorded (`engine/parity/tv-solusd-5m-2026-11-07.json`) | Engine | Notes |
|---|---|---|---|
| Initial capital | $100 (Properties tab) | not used | The Pine header says `initial_capital=10000`; the Properties tab overrides it. Neither changes a trade: quantity = risk ÷ stop distance. |
| Default order size | 1 Quantity | not used | Every `strategy.entry` passes `qty=`, so it is never used (as you said). |
| Pyramiding | 0 | one position at a time | ✓ |
| Commission / slippage | 0% / 0 ticks | none in Model A | ✓ |
| Calculation | on bar close | once per completed bar | ✓ |
| Bar detail | Default, 4 ticks per bar | O→H→L→C or O→L→H→C path, whichever extreme is nearer the open first | ✓ (TradingView's documented rule) |
| Margin long / short | 0 (leverage ∞) | no capital check | With margin 0, TradingView runs no margin-call logic: positions are never limited by equity and equity can go negative (see section 4). |
| Limit order execution | "Requested price" | open price when a bar gaps through the limit | **Unresolved**, see Problem 2 |
| Order execution delay | "One tick" | an exit can fill on the entry's own path | **Unresolved**, see Problem 2 |
| Chart time zone | UTC | UTC | ✓ |

### Execution rules checked against the Pine source

- **Same order of operations.** The script steps run in this order in both: zone mitigation, then new zones,
  then position sync, market structure, setup cancel, plan and order, management, and time exit.
- **ATR.** `ta.atr(14)`: the first true range is high − low; the seed is the SMA of 14 values, then Wilder's RMA.
  Unit-tested.
- **Pivots.** `ta.pivothigh/low(5,5)`, confirmed 5 bars later. Ties: a value equal to an older bar still counts as
  a pivot; equal to a newer bar does not. This rule is **inferred from data, not documented by TradingView**. Of
  the four tie rules, only this one reproduces the benchmark: 5 of 5 listed trades and the full summary. The other
  rules give 65–69 trades and profit factors from 1.60 to 3.63.
- **FVG, OB and RB detection and mitigation** (close beyond the zone), the zone cap at 70, and the confluence
  window (zones formed since the leg start): same expressions as the Pine.
- **Entry.** Limit at 0.705, rounded to $0.01, (re)placed each bar while the timing, validity, direction and
  confluence conditions hold, and cancelled otherwise. Setups expire after 32 *bars* or when price breaks the
  swing origin.
- **Quantity** = $10 × 1 ÷ (|entry − stop| × 1). No rounding, as in Pine. The test asserts every full stop-loss
  loses about $10.
- **Stop loss** = swing origin ± 0.1 ATR. **TP2** = `lvl(0.25)`, i.e. 25% of the way back from the swing extreme
  toward the origin, which is between the 0.705 entry and the extreme.
- **Break-even** at 45% of the way to TP2, from the bar after entry. **Trailing** starts at 5% and follows
  the latest 3-bar swing ± 0.05 ATR, only ever tightening and only on the right side of the close. Both are
  re-placed through `strategy.exit` with the same id.
- **Same-bar entry and exit.** The exit bracket can fill later on the same bar's path. Pine's "entered and closed
  inside a single bar" branch is ported.
- **Exit labels.** The TP2, trailing, break-even and SL labels use Pine's own tolerance rule (2 ticks).
- **No lookahead** and **restart determinism** (JSON state save and resume) are covered by existing engine tests.

### Discrepancies and uncertainties found

1. Code comment only: `ote.mjs` lists `maxZones` under "Display (no effect on trading)", but it does affect
   confluence. The value used (70) is correct. No behaviour change is needed; fixing the comment is optional.
2. The two fill Properties above can't be distinguished by the benchmark. This is material over 150 days
   (Problem 2).
3. The pivot tie rule is inferred from data (5 listed trades plus the summary), not from TradingView
   documentation.
4. **$25K figure: not determined.** I checked it against everything computable from the trades:
   - largest position value in the benchmark window: $8,363.37;
   - largest over 150 days: $15,060.79;
   - largest quantity: 206.6 SOL;
   - traded notional in the window: $478,268;
   - Pine header capital: $10,000; Properties capital: $100.

   None is $25,000. The screenshot's label for that number is needed; until then it should not be read as capital.

## 2. TradingView benchmark (69 trades)

The benchmark reproduces from the 150-day dataset, history starting 2026-10-19 00:00 UTC:

| | TradingView | Engine |
|---|---|---|
| Closed trades | 69 | 69 |
| Winners | 32 | 32 |
| Net P&L before fees | +$249.98 | +$249.99 (one-cent rounding) |
| Profit factor | 3.298 | 3.298 |
| Max drawdown | $21.95 | $21.95 |
| Listed trades (#47, #49, #57, #64, #69) | — | all 5 match on time, side, price, quantity and P&L |

What this does and does not establish:

- **Summary parity plus 5 individual trades.** That is not trade-by-trade parity for all 69: TradingView's full
  trade list was never exported. `src/cli/compare-tv.mjs` already compares a TradingView "List of trades" CSV
  against the engine field by field.
- **The result depends on where history starts.** With the same rules and earlier history (from Oct 13), the same
  window has 70 trades and +$242.37. Inside the 150-day run (history from June 12), the window holds 70 trades,
  +$262.78, PF 3.416, 68 of them identical. That's because a setup open on Oct 19 carries in from earlier history.
  So the 69-trade figure is TradingView's result for *its* loaded history, and longer runs are not expected to
  repeat it exactly.
- The four fill-property readings give identical results in this window (none of its trades is affected).

## 3. Corrected 150-day results: the exact original strategy

**Data.** Kraken SOLUSD 5m, 2026-06-12 00:00 to 2026-11-09 00:00 UTC, re-verified independently:
- 43,188 of 43,200 intervals; 0 duplicates, unordered, off-grid or invalid candles.
- 12 missing intervals (no Kraken trades), in 3 gaps: 2026-08-06 07:05 (2 candles), 2026-08-20 07:05 (1) and
  2026-10-30 02:25 (9).
- Every overlapping candle matches the committed benchmark fixture (5,670 of 5,670) and the 25-day reference file
  (7,191 of 7,191). The previous run also matched Kraken's own OHLC (485 candles).

**Gap rule.** A missing interval is no bar, as on TradingView's Kraken feed; nothing is filled in. ATR, pivots,
the 32-bar setup age and the trailing swings count bars, so across a gap they span more wall-clock time. No order
can fill in a gap because no trade happened. No trade was open across any of the 3 gaps.

**Warm-up.** Indicators need about 15 bars and the first pivots 11, so after the first hour of June 12 the run
is fully warmed.

### Model A: exact TradingView equivalent (both directions, fixed $10, no fees, no capital limit)

| | All | Longs | Shorts |
|---|---|---|---|
| Trades | **579** | 308 | 271 |
| Winning / break-even ($0) / losing | 217 / 94 / 268 | 124 / 49 / 135 | 93 / 45 / 133 |
| Gross profit | $2,130.71 | $1,228.97 | $901.74 |
| Gross loss | $1,980.47 | $998.00 | $982.47 |
| **Net before costs** | **+$150.24** | **+$230.97** | **−$80.73** |
| Profit factor | **1.076** | 1.231 | 0.918 |
| Max drawdown (closed trades) | $225.97 | $111.26 | $252.70 |
| Average per trade | +$0.26 | +$0.75 | −$0.30 |
| TP2 exits | 127 | 72 | 55 |
| Stop-loss exits | 121 | 60 | 61 |
| Trailing-stop exits | 261 | 137 | 124 |
| Break-even exits | 47 | 23 | 24 |
| Same-bar entry and exit | 23 | 16 | 7 |
| Traded notional (entry + exit) | $4,088,106 | $2,124,529 | $1,963,577 |

P&L by exit type: TP2 +$1,847.11; stop-loss −$1,196.67; trailing stop −$316.41 (122 of 261 trailing exits
lost money); same-bar −$179.81. 94 trades closed at exactly $0: 43 break-even exits and 51 trailing exits at the
entry price.

**The $100 example.** It isn't executable. Every one of the 579 entries is larger than $100: positions run from
about $1,500 (10th percentile) through $3,077 (median) to $15,061 (largest). TradingView simulates it only because
margin is 0. On $100 the theoretical equity goes **negative**: first on 2026-07-25 00:25 UTC, with a low of
−$53.75. It ends at $250.24. On $10,000 it never falls below $9,846 and ends at $10,150.24.

**Stability (original only, nothing selected):**
- First 60% (to 2026-09-10): 366 trades, −$94.66, PF 0.93.
- Last 40%: 213 trades, +$244.90, PF 1.39.
- By month: Jun +$1.73, Jul −$84.58, Aug +$27.35, Sep −$78.27, Oct +$176.05, Nov (to the 8th) +$107.96.

The October 19–November 7 benchmark falls in the strongest stretch of the five months, so it is not
representative.

### Model B: the same 579 trades with costs

Limit entry and TP2 pay the maker fee. Stops and trailing stops pay the taker fee, and their price is moved
against the trade by the slippage estimate. No trade is added, removed or re-timed.

| Venue (fees verified; slippage estimated) | Entry fees | Exit fees | Slippage | Total costs | **Net** | PF | Max DD | Avg/trade | Longs | Shorts |
|---|---|---|---|---|---|---|---|---|---|---|
| None (Model A) | 0 | 0 | 0 | 0 | +$150.24 | 1.076 | $225.97 | +$0.26 | +$230.97 | −$80.73 |
| Ndax 0.20% flat, 0.10% slip | $4,087.79 | $4,088.36 | $1,568.21 | $9,744.37 | **−$9,594.13** | 0.041 | $9,594 | −$16.57 | −$4,815 | −$4,779 |
| Ndax, 0.20% slip | $4,087.79 | $4,088.30 | $3,136.43 | $11,312.52 | −$11,162.28 | 0.036 | $11,162 | −$19.28 | −$5,613 | −$5,550 |
| Kraken Pro T1 0.40/0.80%, 0.03% slip | $8,175.59 | $14,449.62 | $470.46 | $23,095.67 | −$22,945.43 | 0.004 | $22,945 | −$39.63 | −$11,700 | −$11,245 |
| Kraken Pro T1, 0.10% slip | $8,175.59 | $14,449.45 | $1,568.21 | $24,193.26 | −$24,043.02 | 0.004 | $24,043 | −$41.53 | −$12,255 | −$11,788 |

- Ndax fees come from Ndax's published 0.20% schedule, applied to **Kraken SOLUSD prices**. These are not Ndax
  SOL/CAD executions: different book, CAD quote, unmeasured liquidity.
- Kraken fees are the published Tier 1 schedule.
- Slippage figures are estimates, not measurements.
- Under Ndax costs, 143 winning trades become losing trades.

**Different execution replay (separate, not the same trade list).** If a resting limit fills only when price
trades one tick through it, the strategy takes 543 trades and makes **−$114.87 before costs** (PF 0.944), and
−$9,044.67 after Ndax costs.

### Model C: executable on the current ALPHA PAPER ledger

The ledger is long-only and limited by balance: entry value plus fee must fit the balance, with no leverage.
The Worker caps orders at $5,000, Ndax's $5 minimum applies, and Ndax costs come out of the balance. Fixed $10
risk is kept. Refused entries are dropped as the live engine does.

| Start balance | Executed | Refused (short / capital / order limit) | Gross | Costs | Net | End balance |
|---|---|---|---|---|---|---|
| $10 | 0 | 624 (297 / 327 / 0) | $0 | $0 | $0 | $10 |
| $100 | 0 | 624 (297 / 327 / 0) | $0 | $0 | $0 | $100 |
| $10,000 | 268 longs | 329 (266 / 10 / 53) | +$122.81 | $3,492.23 | **−$3,369.42** | $6,630.58 |

Signal counts differ slightly from Model A because dropping a refused entry changes which later setups are
available.
- All 271 of Model A's shorts are unrepresentable on the current ledger.
- With $10 or $100, no long fits either: fixed $10 risk on a stop about 0.33% away needs about $3,000 of
  buying power.

## 4. Before and after costs: why

- **Per trade:** before costs the strategy earns **+$0.26 a trade on about $3,500 of position** (0.0037% of
  traded notional). After costs, it pays an average of $16.83 a trade at Ndax and $39.89 at Kraken Tier 1.
- **Root cause: the stops are smaller than the costs.** The initial stop sits a median **0.325%** from entry
  (10th–90th percentile: 0.16%–0.67%). An Ndax round trip is 0.40% plus 0.10% slippage on stop exits. So costs
  of one round trip exceed the whole planned risk of a typical trade: Ndax costs averaged 0.48% of the position,
  about 1.5R at the median stop, on every trade, win or lose.
- **Breakeven cost:** to break even, total round-trip costs would have to stay under about **0.007% of the
  position**. Ndax's realized costs (0.48%) are about 65× that and Kraken Tier 1's (1.13%) about 155× that.
- **Answer to the question asked:** yes, over these 150 days the exact original makes more profit than loss before
  costs, but only barely (PF 1.076), and all of it comes from longs. It is nowhere near enough to survive any
  realistic retail spot costs.

## 5. Long vs short

- **Longs:** +$230.97 gross (PF 1.23) over 308 trades.
- **Shorts:** −$80.73 gross (PF 0.92) over 271 trades, with the larger drawdown ($252.70).

So the earlier long-only research did not discard a profitable half: here the shorts *reduced* the gross result.
This is one market (SOL fell from about $104 to about $90 between Oct 19 and Nov 7; over the five months it went from
$66.86 to $86.44, ranging $63.72–$124.91), so the direction effect is not established as general.

## 6–7. Improvements, out-of-sample and walk-forward

**Not started** (Phase 6 comes after this baseline is reviewed). This baseline suggests the only plausible
direction: the edge per trade must grow roughly 100-fold relative to the position size. That means wider stops
(for example a higher timeframe, or a minimum stop distance) or far fewer, larger-R trades. Tuning filters on the
5m model can't close a 65× cost gap. The 576 earlier configurations used long-only, percent sizing and conservative
fills; they should be re-run on the corrected long/short, fixed-$10 baseline before any of them is considered.
The whole 150-day file has already influenced earlier research selection, so its last 40% is not a clean,
never-seen test set. New data after 2026-11-09 would be.

## 8. Problems found

| # | Problem | Evidence | Impact | Recommendation | Approval |
|---|---|---|---|---|---|
| 1 | The earlier 150-day study did not test the original strategy (long-only, 1% equity risk, no leverage, conservative fills). | Its own method notes; this run. | Its conclusion about *the original* is replaced by Models A–C here. The direction of the conclusion (unprofitable after costs) holds, for a different and stronger reason: stop size vs cost. | Use this baseline for any further research. | No |
| 2 | The "Limit order execution: Requested price" and "Order execution delay: One tick" Properties are not modelled as such; the engine uses TradingView's documented default emulator. | In the 69-trade window the four readings are identical. Over 150 days: "requested price" changes 4 trades (−$4.89); "one-tick exit delay" changes 20 same-bar stop exits (**−$238.55**, gross +$150.24 → −$88.31). `fill-property-diffs.json` lists each one. | The sign of the 150-day gross result depends on this. After costs it changes nothing (all readings lose heavily). | Export TradingView's List of trades for a range that includes, for example, the 2026-10-06 09:25 and 2026-10-12 21:40 long entries, and compare with `compare-tv.mjs`. Keep the documented default until then. | Yes, before changing the emulator |
| 3 | The research backtest helper's `longOnly` ledger option lets a refused trade through when it fills and exits inside one candle. | 7 shorts counted in a long-only run over 150 days. | The earlier research (`research.mjs`) included up to 7 same-bar shorts. This is small. The live engine is not affected (the Worker refuses the order). | `baseline.mjs` Model C handles it correctly. Fixing the shared helper in `backtest.mjs` is recommended. It was left unchanged here so the earlier research stays reproducible. | Small research-code fix; your call |
| 4 | The 69-trade benchmark depends on TradingView's history start (2026-10-19 00:00). | Earlier start gives 70 trades, +$242.37 in the same window. | Benchmark parity can't be checked against the long-history run directly. | Keep the benchmark test with its own history start (as committed). | No |
| 5 | The $25K figure is unexplained. | No computed quantity matches (section 1). | It is not a setting until identified. | Re-check the screenshot's label. | No |
| 6 | With $10 or $100 the strategy can't trade on the PAPER ledger at all; on TradingView with $100 its equity goes negative. | Model A path; Model C. | The $100 TradingView figure is theoretical only. | Report theoretical and executable results separately (already so in this report). | No |

## 9. Production recommendations (none implemented)

1. **Don't change the running strategy based on this data.** No improvement has been tested yet.
2. **Fee accounting on the PAPER ledger.** It is implemented on a development branch in a separate session and is
   not deployed. It makes the ledger show the cost effect described in section 4. Deploying it needs your
   authorization.
3. **Keep the funded PAPER ledger long-only with no leverage.** Show theoretical strategy P&L (the engine's own
   simulation, Model A) separately and clearly labelled, as the dashboard already does ("engine simulation, not
   verified").
   - A separate *theoretical* TradingView ledger is the simplest accurate way to show shorts and leverage.
   - Simulated shorts inside the funded ledger would need a collateral rule (for example 100% of notional
     reserved, plus fees and a borrow-rate assumption). Neither Ndax spot nor this project's scope offers short
     selling, so I don't recommend it now.
4. **Resolve Problem 2** with a TradingView trade-list export before any parity-dependent change.
5. **If research continues:** start Phase 6 with mechanisms that widen the stop relative to cost (timeframe,
   minimum stop distance), validated 60/40 plus walk-forward, with costs included from the start.

## 10. Tests

- Engine: `npm test` passes 111 of 111.
  - That includes the new `test/baseline.test.mjs` (10 tests): data integrity, per-fill cost maths, Model A =
    benchmark summary with both directions and fixed $10 stop losses, Model B keeps A's trades, the $100 path is
    reported honestly, Model C never executes a short.
  - The existing `parity.test.mjs` passes: the 69-trade summary and the 5 listed trades.
- Production state was not touched. Only read-only local files were used. No engine restart, no Worker call, no
  D1 access, no deployment.

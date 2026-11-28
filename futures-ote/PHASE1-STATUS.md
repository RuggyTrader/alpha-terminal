# ALPHA TERMINAL Phase 1: OTE + PD Array on MNQ, validation status (2026-11-27)

**Status:** the engine is built and tested, and it runs on genuine MNQ candles. **Blocked on data:** no legitimate free source of ≥ 12 months of 1-minute MNQ history exists without an account or a purchase. **No performance claim is made yet.**

Historical simulation only: no broker connection, no orders, no paid services. The crypto engine, the bots, S3, P1 and both collectors are untouched.

## Strategy source

* **Translated file:** `alpha-terminal/tradingview/ote_pd_array_strategy.pine` (committed in the ALPHA TERMINAL repo).
* **Identical trading logic:** `ote-auto-trader/work/pine/ote_pro_strat_be_trail.pine` (the only differences are webhook / alert strings).
* **Not used:** `OTE_PD_Array_Strategy_STDV.pine` adds standard-deviation confluence, which is not in the approved settings.
* **Approved settings** are the engine defaults (`ote_engine/strategy.py: Settings`):
  * swing 5, leg 3.5 ATR, expiry 32 bars;
  * limit entry @ 0.705, SL at the swing origin + 0.1 ATR, TP2 at +0.25;
  * confluence ≥ 1 with FVG / OB / RB (0.1 ATR, 1 ATR, 0.5 wick, 0.8 ATR, lookback 8), 70 zones;
  * longs and shorts, $10 risk;
  * break-even at 0.45; trailing from 0.05, swing 3, buffer 0.05 ATR;
  * no hours, weekend or sleep rules;
  * America/New_York.

## Engine (`futures-ote/ote_engine/`, Python 3.12)

| Module | What it does |
|---|---|
| `indicators.py` | Pine built-ins: `ta.atr` (RMA, SMA seed), `ta.pivothigh` / `ta.pivotlow` (confirmed `right` bars later), `ta.lowest` / `ta.highest`, `math.round_to_mintick` |
| `strategy.py` | The Pine script translated **in the script's own order of operations** at each bar close: PD-array mitigation → detection → position sync → structure → cancel broken / expired → plan + order → break-even / trailing. A TradingView-style broker emulator (see below). |
| `data.py` | CSV loader; validation (duplicates, ordering, OHLC sanity, tick grid, CME Globex session gaps, roll / adjustment jumps). Data is never filled or synthesized. |
| `report.py` | Every requested metric, including weeks with no trades; CSV / JSON exports (trades, 15-minute equity, config, results). |
| `run_backtests.py` | Test A and Test B variants (below) |

**Broker-emulator assumptions:**
* **Order timing:** orders placed, changed or cancelled at bar k's close are live from bar k+1. A stop change never applies retroactively.
* **Same-bar fills:** an entry and its bracket can fill in the same candle (counted separately).
* **Intrabar path:**
  * **TradingView rule:** if the high is closer to the open, open → high → low → close; otherwise open → low → high → close.
  * **Conservative alternative:** adverse move first.
* **Limits** fill at the limit price, or at the open if the bar gaps through.
* **Stops** fill at the stop price, or at the open on a gap, minus the slippage ticks.

**Unknown TradingView settings** (assumed at TradingView defaults; please confirm from your Strategy Tester → Properties):
* commission 0, slippage 0;
* bar magnifier off; "recalculate after order filled" off; "fill on bar close" off;
* limit-order price verification 0 ticks;
* initial capital 10,000 (from the script);
* the pivot tie rule (tested both ways).

**Fractional contracts.** TradingView's quantity = $10 ÷ (risk points × $2) is **fractional and non-executable** (Test A labels it).

## Tests: 10 / 10 passing (`pytest`)

* Pine built-ins against hand values.
* Limit / gap / stop / slippage fills.
* Same-bar entry + stop under both path models.
* No retroactive stop change.
* **No-lookahead truncation invariance:** a run on the first 4,000 bars gives exactly the same trades as the full run up to that point.
* Sizing modes and the risk budget.
* Ledger identities (net = gross − commission; equity = realized + open mark).
* Data-validation checks.

## Smoke run on genuine data: NOT evidence

**Data:** MarketParquet's free sample pack (no account), MNQ and NQ 1-minute, **2026-04-06 00:00 .. 04-10 16:59 ET** (6,540 MNQ bars, 0 duplicates, 0 bad OHLC, 0 missing session minutes).

**Limitations:**
* **Ratio-adjusted continuous prices: 100 % of the bars are off the 0.25 tick grid.**
* The Sunday evening session is not included.
* **One week only.**

| Run | Trades | Net | PF | Notes |
|---|---|---|---|---|
| A: TradingView-style (fractional, no costs) | 76 | −$58.94 | 0.81 | risk about $10 / trade (9.80–10.31) |
| A: conservative intrabar path | 76 | −$56.48 | 0.82 | |
| A: strict pivot tie rule | 74 | −$44.02 | 0.85 | |
| B: whole contracts, $10 budget | 2 | −$12.78 | 0 | **119 setups rejected**: 1 MNQ contract usually risks > $10 |
| B: fixed 1 contract, base costs | 76 | −$237.48 | 0.79 | risk per trade median $32, p90 $60.5, max $115 |
| B: fixed 1 contract, conservative | 77 | −$321.00 | 0.75 | |

**Base costs:** $0.74 per side, stop slip 1 tick. **Conservative:** $1.50 per side, 2 ticks, limit trade-through 1 tick, adverse-first path. These are assumptions, because no broker has been selected.

**These numbers say nothing about the strategy's edge:** they cover one week, with adjusted prices.

## Findings so far

1. **The $10 risk budget is not executable on MNQ.** With a 3.5-ATR leg, the stop distance is usually 4–50+ points ($8–100+ per contract). Whole-contract sizing rejected 98 % of setups in the sample week.
2. **TradingView's PF 3.964 almost certainly used fractional contracts and zero costs.** That cannot be reproduced with real contracts at $10 risk.
3. **The trade rate is high: about 15 trades a day** (76 in 5 days). Commissions at $1.48–3.00 per round trip matter a lot at fixed size.
4. **Early trailing (0.05 of the way to TP2) dominates exits.** About a third of trades exit by trailing near break-even before the BE trigger (0.45) is reached.

## Data (owner decision, 2026-11-28)

**QuantConnect Cloud** (free tier): MNQ 1-minute trade bars from QuantConnect's US Futures dataset, individual contracts, raw prices. The backtest runs inside QuantConnect and exports summary results only. See `QUANTCONNECT.md`.

**Not used:**
* **Databento:** the owner decided not to use it under any circumstances. The fetcher, setup guide and key handling were removed.
* **The other options considered earlier** (NinjaTrader replay export, MarketParquet, TradingView export): not used.

## Future prop-firm compatibility (not built; firm not chosen)

Needed in the engine:
* account-level equity tracking with **trailing (intraday or end-of-day) drawdown**;
* **daily loss limits** (hard stop and lock-out);
* **maximum contracts**;
* **consistency rules** (largest-day share);
* **mandatory flat times** (the Pine hours / sleep logic exists but is disabled in these settings);
* news / holiday blocks;
* payout rules.

No rules or pass rates will be assumed until a specific firm and account are selected.

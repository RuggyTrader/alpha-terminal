# Audit: can the existing Jupiter research engine trade liquidation events? (2026-11-25)

The audit was done before the event study. It covers:
* `engine/src/research/jupiter/` (backtest, ledger, risk, costs, adapter, paper-engine);
* the 19 Jupiter tests.

## What is sound and reusable

* **Cost and liquidation math (`costs.mjs`):** it follows the program's reference code and was checked against on-chain parameters on 2026-11-25:
  * 6 bps open/close fee;
  * linear price impact;
  * borrow on the full size at the collateral custody's rate;
  * liquidation at size ÷ 500, with all remaining collateral lost.
* **Risk manager (`risk.mjs`):**
  * minimum collateral $10 and minimum leverage 1.1×;
  * leverage cap;
  * fee and gas reservation before sizing;
  * duplicate guard;
  * no martingale;
  * shutdown closes everything.
* **Single-asset experiments are supported** by passing a config whose `assets` lists one asset: the sleeve then equals the whole equity.
* **Ledger (`ledger.mjs`):** isolated margin, with ledger identities checked on every run.
* **PAPER parity:** the PAPER engine and the backtester share `stepHour`, and a test proves they give identical results.
* **The $75 shutdown is modelled as a trigger, not a guarantee.** Overshoot below $75 occurs and is recorded.

## What does NOT support event-driven trading (would need an isolated extension)

1. **Hourly clock.** `stepHour` decides only at hour closes, and fills only at the next hour's open. A liquidation event at 14:23 would wait up to 60 minutes. Signals at non-hour timestamps are silently ignored, because `signalAt` is only queried at hour boundaries.
2. **Borrow accrual assumes one hour per call.** `intrabar()` adds `borrowPerHour` on every call. Feeding it 1-minute bars would **overcharge borrow by 60×**. An extension must pass the elapsed time.
3. **Keeper delay is a price markup, not a time delay.** It is modelled as bps of slippage on the next hourly open. For minute-scale events, the delay must be modelled as **time**: the fill price is the price at t + delay (for example 5–60 s, or several minutes when congested), plus slippage.
4. **Stops and liquidation are checked only on hourly extremes.** Event trades need minute-level (or finer) checks, plus the stop-failure and retry model at that resolution.
5. **Price data.** The PAPER engine ingests Binance 1-hour candles only. Liquidation events need minute data and a live liquidation feed, which has never been integrated.

## Decision

These gaps matter **only if** an event study shows a tradeable effect. Following the instruction not to build execution before establishing predictive value, the extension is **not built now**.

If an effect survives, the extension would be:
* a minute-clock step function;
* time-based keeper delay;
* elapsed-time borrow;
* minute stops and liquidation.

It would be built in isolation, with tests, and checked for parity against the hourly engine when run on hour-aligned events.

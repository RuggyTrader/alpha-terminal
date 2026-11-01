# TradingView → ALPHA TERMINAL (PAPER, dry run)

`ote_pd_array_strategy.pine` is the OTE + PD Array strategy. Its order-fill alerts are JSON fragments for the
existing ALPHA TERMINAL webhook. Strategy logic, entries, exits, TP/SL and sizing are unchanged.

| Pine event | `action` | `qty` |
|---|---|---|
| Long entry fills | `BUY` | futures: whole contracts (rounded down) · crypto / gold: 8 decimals |
| Short entry fills | `SELL` | same (the Worker rejects it: short selling is disabled) |
| TP2, stop, break-even stop or time exit fills | `CLOSE` | omitted (closes the whole position) |

## Instruments

Only these charts are accepted (`syminfo.ticker` → ALPHA TERMINAL symbol):

| Chart | Symbol | Reference price | Result today |
|---|---|---|---|
| `MES1!` or a dated MES contract | `MES` | none available | BUY/SELL rejected `MARKET_DATA_UNAVAILABLE` |
| `MNQ1!` or a dated MNQ contract | `MNQ` | none available | BUY/SELL rejected `MARKET_DATA_UNAVAILABLE` |
| `TVC:GOLD` | `GOLD` | none available | BUY/SELL rejected `MARKET_DATA_UNAVAILABLE` |
| `BTCUSD`, `ETHUSD`, `SOLUSD`, `HYPEUSD`, `KAITOUSD` (e.g. on Kraken) | same | Kraken public market data | full risk check |

There is no truthful price source for MES, MNQ or GOLD yet: Alpaca has no futures and its `GOLD` ticker is a
stock (Gold.com, Inc.), Kraken has no spot gold, and CME data needs a licensed feed. Those signals are recorded
and rejected with that reason; no price is estimated. Any other ticker (SPY, BTCUSDT, …) is `INVALID_SYMBOL`.

## One alert per chart

1. Add the strategy to the chart.
2. Create alert → **Condition:** `OTE + PD Array Strategy (Auto)` → **Order fills only**.
3. **Notifications:** Webhook URL `https://alpha-terminal-api.mattledger787.workers.dev/webhook/dry-run`
4. **Message** (replace `<WEBHOOK_SECRET>` with the Worker's secret, typed only in TradingView):

```
{"secret":"<WEBHOOK_SECRET>",{{strategy.order.alert_message}}}
```

TradingView sends, for example:

```json
{"secret":"<WEBHOOK_SECRET>","id":"OTE-SOLUSD-1-2026-11-02T14:31:05Z-BUY","symbol":"SOLUSD","timeframe":"1",
 "action":"BUY","strategy":"OTE Pro Strat","qty":0.5,"timestamp":"2026-11-02T14:31:05Z"}
```

Pine builds every field itself (`syminfo.ticker`, `timeframe.period`, and `timenow` formatted as UTC ISO-8601).
`{{strategy.order.alert_message}}` is the only placeholder: TradingView does not expand `{{ticker}}`-style
placeholders inside `alert_message`. `id` and `timestamp` are the time Pine placed or last updated the order, so a
TradingView retry of the same alert is recorded as `DUPLICATE`.

## Limits that apply (Worker risk settings)

* $5,000 per order, $10,000 per position, $25,000 total, 5 open positions, $2,000 daily loss (USD notional).
* `MAX_ORDER_QTY=10` counts futures contracts only; crypto and gold amounts are limited by the USD limits.
* With the default Pine sizing ($200 risk, $10,000 max position) many signals exceed $5,000 and are rejected with
  a truthful reason; lower "Max position value (USD)" in Pine to about 4,000 to stay inside the limits.
* `/webhook/dry-run` never contacts the broker: an accepted signal becomes a dry-run order intent in D1, not a
  position.

Tests: `cd worker && node --test test/instruments.test.mjs test/pine_pipeline.test.mjs` (the pipeline's risk
cases need PAPER keys in `worker/.dev.vars`).

# TradingView → ALPHA TERMINAL (PAPER, dry run)

`ote_pd_array_strategy.pine` is the OTE + PD Array strategy. Its order-fill alerts are JSON fragments for the
existing ALPHA TERMINAL webhook. Strategy logic, entries, exits, TP/SL and sizing are unchanged.

| Pine event | `action` | `qty` |
|---|---|---|
| Long entry fills | `BUY` | strategy size rounded down to whole shares |
| Short entry fills | `SELL` | same (the Worker rejects it: short selling is disabled) |
| TP2, stop, break-even stop or time exit fills | `CLOSE` | omitted (closes the whole position) |

## One alert

1. Add the strategy to the chart (an allowed symbol: SPY, QQQ, AAPL or NVDA).
2. Create alert → **Condition:** `OTE + PD Array Strategy (Auto)` → **Order fills only**.
3. **Notifications:** Webhook URL `https://alpha-terminal-api.mattledger787.workers.dev/webhook/dry-run`
4. **Message** (replace `<WEBHOOK_SECRET>` with the Worker's secret, typed only in TradingView):

```
{"secret":"<WEBHOOK_SECRET>",{{strategy.order.alert_message}}}
```

TradingView sends, for example:

```json
{"secret":"<WEBHOOK_SECRET>","id":"OTE-SPY-1-2026-11-02T14:31:05Z-BUY","symbol":"SPY","timeframe":"1",
 "action":"BUY","strategy":"OTE Pro Strat","qty":1,"timestamp":"2026-11-02T14:31:05Z"}
```

Pine builds every field itself (`syminfo.ticker`, `timeframe.period`, and `timenow` formatted as UTC ISO-8601).
`{{strategy.order.alert_message}}` is the only placeholder: TradingView does not expand `{{ticker}}`-style
placeholders inside `alert_message`. `id` and `timestamp` are the time Pine placed or last updated the order, so a
TradingView retry of the same alert is recorded as `DUPLICATE`.

## Limits that apply (Worker risk settings, unchanged)

* Whole shares only, at most 10 shares and $5,000 per order. With the default Pine sizing ($200 risk, $10,000
  max position) many signals will be rejected with a truthful reason; lower "Max position value (USD)" in Pine
  to stay inside the limits.
* `/webhook/dry-run` never contacts the broker: an accepted signal becomes a dry-run order intent in D1, not a
  position.

Test: `cd worker && node --test test/pine_pipeline.test.mjs` (needs PAPER keys in `worker/.dev.vars` for the
risk cases).

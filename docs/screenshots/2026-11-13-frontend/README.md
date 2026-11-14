# Frontend screenshots — 2026-11-13 (LOCAL DEMO, not production)

Integrated preview (`claude/frontend` + proposed Worker patch) on a local Worker with a fresh D1. Candles and prices are
**live public Kraken** data. Orders and engine reports are **DEMO** (labelled `DEMO-…`). Width 402 px.

| File | Shows |
|---|---|
| 01-pending-order-chart-dark | Pending LONG: limit, stop and target fitted on live SOL 1m candles |
| 02-pending-order-card-dark | Pending card: value, result at stop after fees, distance to limit, fees and net at target, recorded reason |
| 03-open-short-chart-btc-5m-dark | Open BTC 5m SHORT: entry marker on its own completed candle, stop, target |
| 04-completed-trade-chart-dark | Completed trade: planned entry, initial stop, stop → break-even, target, fill and exit markers |
| 05-trades-all-bots-completed-dark | Unfiltered Trades: every bot, one filter row, Pending / Open / Completed / Rejected |
| 06-trades-rejected-insufficient-capital-dark | Refusal with plain headline and the ledger's exact figures; code under Details |
| 07-trade-card-expanded-result-why-dark | Trade card: result, fees, net, sweep to MAIN, why entered, why exited |
| 08-trade-card-plan-and-actions-dark | Original plan vs actual; View chart, Full trade proof, Ask ALPHA |
| 09-ask-alpha-trade-and-fleet-questions-dark | Trade-attached assistant answering trade AND fleet questions |
| 10-performance-bot-lifetime-dark | Bot performance labelled lifetime (server summary of all trades) |
| 11-home-funded-dark | Home hero + funded card without repeated figures |
| 12-home-pipeline-activity-dark | Pipeline (stale DEMO reports marked STALE) and Activity |
| 13-bots-bitcoin-group-dark | Bots grouped by crypto with wallet, fees, net, to MAIN |
| 14-activity-authoritative-feed-dark | Activity page on the same feed as Home, with record links |
| 15-chart-market-data-offline-dark | Kraken outage before any data: chart unavailable, P&L hidden |
| 16-chart-refresh-failed-last-snapshot-dark | Outage after data: last snapshot kept, STALE, unrealized P&L hidden |
| 17-home-funded-light | Home, light theme |
| 18-completed-trade-chart-light | Completed-trade chart, light theme |

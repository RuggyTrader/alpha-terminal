# Release verification screenshots — 2026-11-13 (LOCAL DEMO, not production)

**Setup:**
- Branch `release/alpha-terminal-integration`, served by a local `wrangler dev` with a **fresh development D1** (all migrations).
- **Live public Kraken** candles and prices, through a local proxy.

**What is synthetic (all labelled):**
- Orders and engine reports: labelled `DEMO-…` / `ENG-SOLUSD-5-DEMO…`, sent through the Worker's own webhook routes.
- Fill and exit reference prices for the DEMO lifecycle, and one out-of-range price that triggers the affordability refusal: synthetic.
- The >200-trade check: 250 closed `TEST-BULK` rows seeded directly into the development database (net $0 each).

| File | Width · theme | Shows |
|---|---|---|
| 01-pending-planned-entry-chart-402-dark | 402 · dark | Pending LONG before any fill: planned limit, stop and target on live SOL 1m candles |
| 02-trades-all-bots-incl-alpha02-402-dark | 402 · dark | Unfiltered Trades: bot-ledger and ALPHA-02 legacy trades, each once; it refreshed without a reload |
| 03-alpha02-legacy-trade-chart-402-dark | 402 · dark | ALPHA-02 legacy trade chart (`?ledger=legacy&trade=1`): SOLUSD 5m, plan levels, fill marker |
| 04-activity-once-per-execution-402-dark | 402 · dark | Activity: one item per execution, refusal kept with the ledger's figures |
| 05-home-lifetime-and-equity-402-dark | 402 · dark | Home: lifetime aggregate, account equity at recorded prices with their age, cash + reserved, MAIN incl. sweep |
| 06-ask-alpha-trade-and-fleet-402-dark | 402 · dark | Assistant with a trade attached answering trade and fleet questions |
| 07-stale-market-last-snapshot-402-dark | 402 · dark | Kraken outage: last snapshot kept, STALE, unrealized P&L hidden |
| 08-open-short-chart-btc5m-360-light | 360 · light | Open BTC 5m SHORT: entry marker on its candle, stop, target |
| 09-bots-grouped-360-light | 360 · light | Four bots grouped under BITCOIN / SOLANA |
| 10-home-lifetime-254-trades-360-light | 360 · light | Home hero from the lifetime aggregate (254 trades) with no trade-history download |

The BITCOIN group's fee total and the lifetime gross/fees include the 250 seeded TEST rows (seeded directly, so not reflected in wallet balances).

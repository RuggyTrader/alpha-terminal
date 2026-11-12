# Multi-bot release candidate — 2026-11-12 (branch `v1.2.0-cloudflare`, NOT deployed)

Design: `docs/MULTI-BOT-ARCHITECTURE.md`. Research: `docs/BACKTEST-2026-11-12-FLEET.md`. Rules: `AGENTS.md`.

## Priority fixes

| # | Issue | Root cause | Fix (development) |
|---|---|---|---|
| 1 | Funded refusals at $10 | Fixed $10 sizing, because ENGINE_SIZING was never set | Production: N4 percent mode. Bots: dollar-risk sizing reduced to fit the bot's capital |
| 2 | `SHORT_NOT_ALLOWED` | The legacy ledger is long-only | Bot ledger with fully collateralised simulated shorts and shortfall handling |
| 3 | Home P&L $0 while the mirror has trades | The hero shows funded trades only (0 closed) | Home Performance selector: Funded PAPER / Strategy Mirror / By bot, never summed |
| 4 | Dashboard TIMEOUT | Alpaca subrequests and the Kraken Ticker had no timeout | `AbortSignal.timeout` 3.5 s (Alpaca) and 5 s (Kraken). The last good snapshot is kept and marked STALE with its time |
| 5 | Extra restrictions | — | None added. Shorts are no longer refused on the bot path. Remaining refusals are real constraints (capital, minimums, collateral, shortfall) |
| 6 | Activity vs Trade Signals | Activity mapped `processing` and `error` to "accepted" | One shared `signalState` mapping, stable alert ids, links to `/trades?signal=<id>`; bot orders appear in Activity |
| 7 | Duplicates | — | Unique keys on order `alert_id`, one OPEN position per bot, fill guard, sweep keys `SWEEP:<trade>:OUT/IN` |

## Cloudflare Free resource audit

These are estimates from the code paths. They are **not measured in production**.

| Resource | Free limit | Estimated use with 4 bots | Notes |
|---|---|---|---|
| Worker requests | 100,000/day | ≈ 7,000 engine requests (status, ledger and orders, once per candle per bot: 2 × 1m bots × 1,440 + 2 × 5m bots × 288, ×2) + dashboard polling (≈ 5,800/day per tab kept open all day) | Comfortable for one owner |
| Subrequests | 50 per invocation | Dashboard: ≤ 4 (3 Alpaca + 1 Kraken), now bounded. Candles: 1 (cached 15 s) | |
| CPU | 10 ms per invocation | Bot order or close: one D1 batch, no heavy compute | Re-check in W1 with `wrangler tail` |
| D1 rows written | 100,000/day | Per-candle status upsert ≈ 3,500/day plus fills and events | |
| D1 rows read | 5,000,000/day | `/api/dashboard/bots` aggregates over each bot's fills, which grows with history | Add a cursor or summary table if fills exceed ~10k |
| D1 storage | 5 GB | KB-scale | |

## Tests (this commit)

The results are listed in the commit message and the final report.

## Not built yet

- Pending-order, break-even and trailing notifications. They need a `trade_events.kind` CHECK change in a later additive migration.
- Trades and Performance `?bot=` / `?signal=` filters. The links exist, but the pages ignore the parameters.
- Trade proof pages for bot trades.
- A full UI duplicate-section audit beyond Home.
- Mobile screenshots of the new pages.
- Migration rehearsal on an export of production D1. `migrations.test.mjs` rehearses 0001→0007 on a schema-6 copy with data. A production export is sensitive and is taken only at the M1 gate, with approval.
- BTC 1m TradingView parity: see the backtest doc.

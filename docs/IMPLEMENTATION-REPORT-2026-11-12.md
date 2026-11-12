# Implementation report — 37 items (2026-11-12, branch `v1.2.0-cloudflare`; development only, NOTHING deployed)

**Status meanings:**
- **DONE** means built, and tested where testing applies.
- **PARTIAL** says what is missing.
- **BLOCKED** names the decision or input needed.
- **NOT DONE** is stated plainly.

The production state is unchanged: release `af924ffa4703`, schema 6, ALPHA-02 only.

| # | Item | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | Funded refusals from fixed $10 sizing | DONE | Dollar-risk sizing capped by capital; the remaining refusal fixed by reduce-to-fit (`bot_ledger.ts`, `capital.mjs`); regression tests in `fleet.test.mjs` and `multi_bot.test.mjs` |
| 2 | `SHORT_NOT_ALLOWED` → simulated shorts | DONE | Fully collateralised short model, shortfall recorded, entries paused |
| 3 | Home Verified P&L $0 with mirror trades | DONE | Performance selector; the hero and Funded tab now include bot-ledger trades (`fundedTrades.ts`, tested) |
| 4 | Dashboard TIMEOUT | DONE (local) | Upstream timeouts; optional Alpaca bounded to 1.5 s with its last snapshot labelled. Local latency: median 46 ms, p95 53 ms. Production numbers need R3 |
| 5 | No extra strategy restrictions | DONE | Original profiles unchanged; no fee filter; both directions active |
| 6 | Activity vs Trade Signals sync | DONE | Shared `signalState`, stable ids, links |
| 7 | App-wide sync and duplicates | DONE | Shared fleet store with ordered snapshots and invalidation; one funded set; duplicate audit (`UI-DUPLICATE-AUDIT-2026-11-12.md`) |
| 8 | Four bots with exact inputs | DONE | Profiles and hashes unchanged; SOL 5m TP2 +0.25 |
| 9 | Kraken data, ETH inactive | DONE | ALPHA-05/06 DISABLED |
| 10 | Independent wallets, equal split | DONE | Tested in the simulator and on D1 |
| 11 | Profit sweep to MAIN | DONE | Atomic, idempotent keys; proof page checks it |
| 12 | Ndax 0.20% per fill | DONE | Fee model id recorded on every fill |
| 13 | LONG/SHORT collateral and shortfall | DONE | — |
| 14 | Dollar-risk UI per bot | DONE | Versioned bot settings exchange |
| 15 | Bots control center | DONE | Screenshots: `LOCAL-TEST-bots-*` |
| 16 | Symbol-aware pipeline | DONE | Home bot pipeline (shared store) |
| 17 | Lightweight Charts | DONE | Chart levels come from the shared snapshot |
| 18 | ALPHA Assistant (deterministic, read-only, $0) | DONE | Reads the shared snapshot; tests in `bots.test.tsx` |
| 19 | Notifications: fills | DONE | Links to the bot trade proof |
| 20 | Notifications: pending, cancel, break-even, trailing | DONE | Derived from each bot's own reports with deterministic keys; per-device toggles; end-to-end test. Needs migration 0007, which includes a lossless `trade_events` rebuild |
| 21 | Trades bot and signal filters | DONE | `?bot=`, `?signal=`, bot chips; Worker and frontend tests |
| 22 | Performance bot filter | DONE | `?bot=` view with the ledger's own net |
| 23 | Bot trade proof pages | DONE | `/bots/trade/:id` with server arithmetic checks |
| 24 | Duplicate-section cleanup | DONE (Home) | Other pages reviewed and kept as their single owners (audit doc) |
| 25 | Mobile screenshots | DONE (LOCAL TEST data) | 20 files in `docs/screenshots/2026-11-12/`, 402 px, light and dark, no horizontal overflow |
| 26 | Worker TypeScript errors | DONE | 0 errors (3 earlier ones fixed) |
| 27 | TradingView parity, SOL 1m | BLOCKED | Converged result +$356.15 / PF 1.856 vs +$382.50 / 2.033. Needs the List of Trades CSV, the Properties tab and the exact window |
| 28 | TradingView parity, BTC 1m | BLOCKED | Converged result +$147.80 / PF 1.347 vs +$374.65 / 1.945. Same needs as #27; the DD% implies Properties differ from the Pine defaults |
| 29 | Funded tests $5…$1,000, per bot and combined | DONE | Tables §3–§4; every bot loses at 0.20% |
| 30 | Longer period | PARTIAL | SOL 5m 150 days done. BTC limited to 20 Oct–12 Nov (the trade-list download is slow); longer BTC needs your choice of source |
| 31 | Fee and profitability research | DONE | Economics, LONG/SHORT, break-even rates, sensitivity, slippage |
| 32 | Execution economics and venues | PARTIAL | Ndax and Kraken CA verified; Coinbase not verified (HTTP 403). No account created |
| 33 | RESEARCH variants | DONE | 10 variants × 4 markets, in-sample vs out-of-sample; none profitable at 0.20% out-of-sample |
| 34 | Migrations: additive, rehearsed | PARTIAL | 0007 rehearsed on synthetic schema-6 data and on local D1. It now includes one lossless rebuild of the derived `trade_events` table (FKs verified). A rehearsal on a production export needs your approval (R4) |
| 35 | Cloudflare Free audit | PARTIAL | Local measurements of statements and rows read; production CPU not measured |
| 36 | Security, regression tests, permanent rules | DONE | AGENTS.md rules 1–26; no secrets in code, logs or docs; the D1 meter is opt-in and off in production |
| 37 | Staged rollout | DONE (proposal) | R1–R6 in `MULTI-BOT-ARCHITECTURE.md`; R3 compatibility with schema 6 checked locally (`tools/schema6-compat.mjs`, 11/11) |

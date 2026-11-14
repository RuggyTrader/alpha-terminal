# ALPHA TERMINAL frontend integration — 2026-11-14

Frontend changes only. Requested backend baseline tested at `96e975357928704bc53e69fae6df1914622f446d` (`chatgpt/backend-engine`). Frontend preserves the existing `claude/frontend` work through `75d8737`, including all-bot stages, Activity feed, chart freshness and trade explanations. The integration used a separate local checkout, not production. During final publication, the backend owner advanced its branch to `5f93ea2cfdb5c8bfc03223286f51a7d68982bcb7`. A second combined verification used that commit without editing backend source.

## Result

- Account headlines consume `/api/dashboard/performance.data.lifetime`; bot headlines consume `/api/dashboard/bots` lifetime metrics. Recent history never substitutes for either aggregate.
- Wallets use authoritative equity, economic realized P&L and shortfall. Missing valuations display unavailable; aged or failed market refreshes display stale. Partial unrealized values are never summed into a false account total.
- Plain-language refusals cover BOT_PROFILE_MISMATCH, BOT_SHORTFALL and CONCURRENT_ORDER. Proof separates requested and filled quantity, including risk/capital reductions.
- Planned engine limit and actual funded PAPER reference execution remain separate. The engine uses candle data; the Worker records Kraken's reference on signal arrival. This is not a guaranteed exchange limit fill.
- Preserved all-bot Pending/Open/Completed/Rejected stages, market/timeframe/side filters, chart context and freshness handling, fit/reset/fullscreen controls, and Activity consistency. Shared history refresh retains scoped snapshots on errors and rejects late responses from old filters.
- Complete account curves are deliberately unavailable when the backend only supplies bounded recent rows. Lifetime headline metrics remain available independently. History range controls apply to the loaded history, not the lifetime aggregate.

## Verification

- Complete frontend suite in the combined checkout: **211/211 tests passed**, 12 test files.
- TypeScript `npx tsc --noEmit`: passed.
- Production `npm run build`: passed. Existing bundle-size warning remains: approximately 597 kB JS, 186 kB gzip.
- Local Worker + temporary D1 + Chromium browser checks and screenshots: see `browser-report.json`. Every screenshot carries a LOCAL TEST label. Synthetic orders use recorded Kraken fixture quotes and are not production trading results.
- Mobile viewport 402×874; desktop 1440×1000; light and dark themes. Browser assertions check horizontal overflow and uncaught runtime errors.
- Backend/engine source was not edited by this frontend task; the newer backend commit was merged only into the temporary integration branch. No deployment, production migration, capital transfer or production bot activation occurred. Worker/engine full test totals supplied with the backend handoff are not represented as reruns in this frontend task.

## Backend history findings and current status

1. **History lookup exceeds D1 bind budget.** With more than 50 closed bot rows, the story lookup binds entry and exit order IDs into one SQL query. Requests such as `/api/dashboard/bot-trades?limit=5000` fail with `D1_ERROR: too many SQL variables`. Frontend clamps requests to 50. The backend owner fixed this in `5f93ea2` using SQL page lookups and chunked payload requests.
2. **Legacy history SQL uses obsolete columns.** `/api/dashboard/bot-trades?bot=ALPHA-02&limit=50` returns zero rows even with a verified legacy close. The legacy query selects `qty`, `entry_price`, `exit_price`; actual columns are `entry_qty`, `entry_avg_price`, `exit_avg_price`. Its catch silently returns an empty list. Frontend temporarily joins genuine ALPHA_PAPER rows from the existing `/api/dashboard/trades?limit=50` endpoint, deduplicates them and retains numeric proof/chart IDs. The backend owner fixed the query in `5f93ea2`. When pagination metadata is supplied, the frontend trusts that repaired backend page and does not append fallback rows outside it.
3. **Older history needs pagination.** No cursor endpoint exists for traversing the full history under the safe query size. The UI explicitly labels bounded history and refuses to present it as a complete account curve. Add stable cursor pagination or an authoritative equity series before considering complete-history deployment verification finished.

The archived `browser-report-baseline.json` reproduces the first two failures against the requested `96e9753` baseline. The current `browser-report.json` records the follow-up against `5f93ea2`, including successful large-history and legacy-history API responses. The fixes were made by the backend owner on its own branch. Prior frontend handoff patches are historical proposals, not applied changes in this task.

## Reproduction

Use a temporary merge of this frontend branch and the latest backend commit above. Install dependencies in `frontend` and `worker`. In `frontend`, run `npm test -- --run`, `npx tsc --noEmit`, `npm run build`, then `BACKEND_COMMIT=<tested-backend-sha> node scripts/integration-check.mjs`. Requires Node 22+, a compatible Chromium executable (`CHROMIUM_PATH`, default `/usr/bin/chromium`) and optional JSON `CHROMIUM_ARGS`. This environment used a local headless Chromium binary with explicit en-CA locale. The browser script creates and cleans an isolated local database and local services; it does not target production.

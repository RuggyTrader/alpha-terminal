# Claude frontend handoff — 2026-11-13 (branch `claude/frontend`; development only, nothing deployed)

**Who owns what:**
- `claude/frontend` holds **frontend changes only** (`frontend/src`).
- The engine, strategy profiles, Worker, accounting and database belong to ChatGPT Work. The two patches in this folder are **proposals for review**. They are **not applied** on this branch.

**Base:** `14d7fe1` (ChatGPT `chatgpt/chart-context-safety`, reviewed and kept unchanged), which sits on top of `2214664`.

## 1. What is on `claude/frontend`

| Area | Change | Tests |
|---|---|---|
| Charts | ChatGPT's context guards kept. A `?trade=` link must belong to the chart's bot, market and timeframe. Levels are fitted by default. The badge says LOADING (not OFFLINE) while the first candles load. Pending orders show position value, distance to limit (% of mark), and fees and net at target. Open positions show initial stop, stop management (initial / break-even / trailing) and the result at stop after both fees. The candle-window text uses the real count (the Worker returns 500) | `bots.test.tsx` |
| Trades — all bots | The unfiltered page shows **Pending / Open / Completed / Rejected** for every bot, with one row of market / timeframe / direction toggles. Legacy ALPHA-02 and bot-ledger rows appear once each. Schema 6 keeps the old page | `trades-sync.test.tsx` A |
| Trades — refresh | One shared, cached store per filter. Responses are applied in order, and the last snapshot is kept and labelled on failure. It refetches when the fleet snapshot shows a fill, close or new pending order, with a 60 s visible-only fallback poll. Verified in a browser: a close appeared without leaving the page | `trades-sync.test.tsx` B |
| Lifetime vs page | Bot Performance takes **lifetime** figures from the Worker's fleet `paper` summary (all rows). The list says "Showing the latest N of M". A page is never used as lifetime | `trades-sync.test.tsx` C (250 trades, 200 loaded) |
| Home | The funded card no longer repeats the hero's four figures. **Funded totals become "unavailable, with the reason" when the bot-ledger history cannot be read completely**, instead of silently dropping every bot trade (see 3a). Refetches only on ledger change, not every 20 s | `trades-sync.test.tsx`, `bots.test.tsx` |
| Activity | `/activity` now uses the **same feed as Home** (`/api/dashboard/events`, latest 50) with source filters. Before this change it read only the legacy `activity_events` table, so "All activity →" showed a different, emptier list. The legacy log stays, collapsed | `terminal.test.tsx` |
| ALPHA Assistant | With a trade attached, fleet questions ("which bot is best", MAIN, Mirror vs funded, stale) go to the general assistant instead of returning the trade story. Header layout fixed. "1 trade" | `bots.test.tsx` |
| Rejections | A plain headline plus the ledger's recorded message with exact figures (it no longer says "unknown available"). The code and id are kept under Details | `trades-sync.test.tsx` |
| Layout | Page bottom padding clears the floating α button. No horizontal overflow on 9 pages at 360 px and 402 px | browser check |

**Frontend result:**
- 197/197 tests pass.
- `tsc` reports no errors.
- `vite build` succeeds. Vite warns that the main chunk is 588 KB; this is advisory only.

**Compatibility:** the frontend reads two **optional** fields that the Worker patch below adds: `legacy_id` and `page`. Without them it still works:
- legacy rows fall back to `trade_id`;
- no "latest N of M" note is shown;
- Home cannot detect truncation, but a failed request is still reported.

## 2. Proposed Worker patch — `worker-bot-trades-legacy-columns.patch` (for ChatGPT Work)

`worker/src/bot_trades.ts` (+18/−6) and `worker/test/multi_bot.test.mjs` (+39).

1. **Bug (confirmed):** the legacy ALPHA-02 query selects `qty, entry_price, exit_price`. The `trades` table has `entry_qty, entry_avg_price, exit_avg_price`. The query fails, and `.catch(() => [])` hides the failure, so **ALPHA-02's history is silently missing from `/bot-trades`** (the bot filter and the all-bot view).
   - The patch uses the real columns and removes the silent catch.
2. Adds `legacy_id` (`trades.id`) to legacy rows, so the chart and proof links resolve. Previously the chart received an alert id and called `Number()` on it, which gives NaN.
3. Adds `page: { limit, returned, total, truncated }`, so a page is never mistaken for full history.
4. New integration assertions: legacy rows have real values; no trade appears twice in the all-bot list; a >200-trade case.

**Worker suite with this patch, macOS, full run:** 291 tests, **290 pass, 1 fail, 0 skipped.**
- The failure is the new >200 test, caused by issue 3a below. It is not a patch regression.
- The `mirror_markets` tests that failed in the previous session's full run all passed.
- Worker typecheck: TypeScript 5.6 with `wrangler types`, strict, 0 errors.

## 3. Backend issues found (not fixed: backend-owned)

**a. `/api/dashboard/bot-trades` returns 500 above 50 trades (confirmed on a local Worker).**
- Error: `D1_ERROR: too many SQL variables`. Limits 40 and 50 return 200; 51 and 200 return 500.
- Cause: `botOrderPayloads` / `alertPayloads` in `worker/src/trade_story.ts` bind up to 200 ids (opening and closing id per trade) in one `IN (...)`. D1 allows 100 bound parameters.
- Effects:
  - Lists over 50 fail; the frontend now requests pages of 50.
  - **Home's funded totals** read up to 5,000 rows and used to drop every bot-ledger trade silently; the frontend now shows them as unavailable with the reason.
- Suggested fix: chunk the `IN` lists (≤ 90 ids per statement), or use a join.
- Longer term: a server-side funded aggregate (the frontend should not download the whole history to compute Home totals).

**b. Activity feed duplicates each action.** Every entry, close and refusal appears twice:
- a bot-order event: "OPEN SHORT filled (PAPER)", with order id and `DRY_RUN_ACCEPTED`;
- a trade event: "PAPER SHORT entered · Entry … · Stop … · Target …".

Suggest keeping the trade event and emitting the order event only for refusals.

**c. Refusal event text is technical.** Example: "DEMO-…-OPEN_LONG · INSUFFICIENT_BOT_CAPITAL: ALPHA-03 has $99.645374 …". A plain sentence with the code under details would match the Trades page.

**d.** The hero's "ENGINE NOT RUNNING" comes from the legacy single-engine status. With a fleet registry it may be clearer to summarise the fleet's own reports.

## 4. Proposed engine test patch — `engine-state-migration-test-platform.patch` (for ChatGPT Work)

`engine/test/state-migration.test.mjs`, test 10, one assertion.
- Steps 4, 5, 6 and 8 start the Windows launcher and are skipped on other platforms, so a macOS run records 4 `process_start` audit entries, not 6.
- The patch expects `WIN ? 6 : 4`. Windows keeps the full requirement.
- No engine source or profile changes.

**Engine suite on macOS with this patch:** 256 tests, **249 pass, 0 fail, 7 skipped** (Windows-only). Without it, the same run has 1 failure (this assertion).
- TradingView parity test: **4/4 pass.**
- Profiles and inputs hashes: unchanged.

## 5. Browser verification (local, DEMO)

**Setup:**
- Integrated preview: `claude/frontend` plus the Worker patch, a fresh local D1, `wrangler dev`.
- **Live public Kraken** candles and prices through a local proxy.
- DEMO orders and engine reports through the Worker's own routes. The only synthetic values are the DEMO fill/exit reference prices and one out-of-range price used to trigger the affordability refusal.

**Verified:**
- **Chart context:** switching SOL 1m → BTC 1m → BTC 5m → SOL 1m without a reload never showed the previous market. Each chart started empty and loaded only its own pair and timeframe.
- **Ownership:** a SOL trade opened on the ALPHA-03 chart is refused with an explanation.
- **Lifecycle:** pending → fill → break-even → take profit; a losing BTC short; an open BTC short; an insufficient-capital refusal.
  - The chart and Trades updated **without a reload**.
  - Markers sat only on their own completed candles.
- **Accounting on Home:**
  - total $999.90 = $1,000 − $0.02 closed net − $0.08 open entry fee;
  - MAIN $600.33 includes the $0.33 sweep;
  - BTC $199.56.
- **Stale handling:** a Kraken outage while a chart was open kept the last candles under "Market refresh failed — last snapshot" and STALE. **Unrealized P&L went from −$0.08 to N/A.**
- **Screenshots:** 18, in `docs/screenshots/2026-11-13-frontend/`, at 402 px, dark and light.
  - During capture the pane was hidden, so a capture-only style finished CSS animations immediately. App code is unchanged.

## 6. Not done / not verified

- Web Push delivery on a real iPhone (needs the deployed site and a device).
- Production measurements.
- The deployment itself (not authorised).
- No production data was read or written.

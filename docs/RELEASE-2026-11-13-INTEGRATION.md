# ALPHA TERMINAL — integrated release plan (2026-11-13)

**Status: prepared and verified locally. NOTHING has been deployed.** Every production step below needs the owner's separate approval.

| Item | Value |
|---|---|
| Branch | `release/alpha-terminal-integration` |
| Contains | `claude/frontend` `75d8737` + `chatgpt/backend-engine` `5f93ea2` (merge `7f1e42b`), then frontend integration `ac37544`, mobile fixes `16a6dfb`, and this document |
| Release commit | the branch tip that adds this file (docs and screenshots only after `16a6dfb`; the deployable code is identical to `16a6dfb`) |
| Production today | Worker version `1b51170c-4f9d-41c0-8284-fa8ab61eac81` (commit `af924ff`) · D1 schema **6** · engine release `af924ffa4703` (legacy ALPHA-02, SOLUSD 5m) |

## 1. What was integrated

**Merge.** Clean, with no conflicts.
- `worker/` and `engine/` are byte-identical to `chatgpt/backend-engine`.
- `frontend/` was byte-identical to `claude/frontend` before the integration commits.
- `engine/profiles/` is unchanged; the four original inputs hashes are asserted by `engine/test/fleet.test.mjs`.

**Frontend API integration (`ac37544`).**
- **Lifetime figures.**
  - Home's hero and Funded PAPER card use `GET /api/dashboard/performance` → `data.lifetime`, the Worker's complete aggregate over every closed legacy and bot-ledger trade.
  - The 5,000-row trade download Home used for headline totals is **removed**.
  - The figures refresh when the legacy count or any bot's ledger changes.
- **Performance page.**
  - "ALL" uses `lifetime`.
  - Date ranges, the equity curve and the trade list cover only the original ALPHA PAPER ledger (ALPHA-02). They are labelled with that coverage and never presented as lifetime.
  - Per-bot lifetime still comes from `/api/dashboard/bots`.
- **Capital card.**
  - Account equity from `totals.equity_usd`. When it is null (a missing mark), the card says "unavailable" with the reason, never $0.
  - Cash + reserved is shown separately.
  - `shortfall_usd` is shown when non-zero.
  - Open-position mark age is shown, and labelled STALE after 5 minutes.
- **Trade proof.** Filled vs requested quantity, with the ledger's recorded reduction reason (stop risk or available capital).
- **Refusal explanations.** Plain language for `BOT_PROFILE_MISMATCH`, `BOT_SHORTFALL` and `CONCURRENT_ORDER`.
- **Execution model.** The planned limit is distinguished from the PAPER reference-price fill on the chart's pending order, the trade card plan and the proof page.

## 2. Verification (local, macOS, Node 22.23.5)

| Suite / check | Result |
|---|---|
| Frontend `vitest` | **201 / 201** |
| Frontend `tsc --noEmit` | clean |
| Frontend production build | OK (Vite warns about one 588 KB chunk, advisory only) |
| Worker `npm test` (with `frontend/dist` built) | **302 / 302** on the merged code; the two final reruns gave **301 / 302**. Each time the failure was `spawnSync npx ETIMEDOUT` in the setup of `funded_sizing.test.mjs`: its 90 s limit for `wrangler d1 migrations apply --local` was exceeded, on a different case each run. That file passed **9 / 9** when run alone with the same code. This is an intermittent local test-harness timeout, not an assertion failure. Re-run on the deployment machine before release (section 3, step 2). |
| Engine `npm test` | 258 tests: **251 passed, 0 failed, 7 skipped** (Windows-only launcher tests) |
| TradingView parity (`tv-parity.test.mjs`) | **4 / 4** |
| Schema-6 compatibility (`tools/schema6-compat.mjs`) | **11 / 11** |
| `wrangler deploy --dry-run` | OK: 326 KiB, 77 KiB gzipped; nothing uploaded |

**Browser check.** Local `wrangler dev`, a fresh development D1, live Kraken data, DEMO orders. Screenshots are in `docs/screenshots/2026-11-13-release/`.

- **Bots and charts.**
  - All four bots are shown, grouped SOLANA and BITCOIN, each chart on its own market and timeframe: SOLUSD 1m, SOLUSD 5m, XBTUSD 1m, XBTUSD 5m.
  - Planned limit, stop and target are shown before the fill.
  - Fill and exit markers sit only on their own candles.
- **ALPHA-02 legacy trades.**
  - They are present in the all-bot history.
  - The chart link `?ledger=legacy&trade=1` and the proof link `/trades/1` both resolve to the same trade.
- **Trade history.**
  - The all-bot history is complete and deduplicated: 4 cards for 4 trades.
  - Trades refreshed automatically: Pending 1 → 0, Completed 2 → 4, Rejected 0 → 1, with no reload.
- **Activity.** One item per execution; the refusal is shown with the ledger's figures; no raw accepted-order duplicates.
- **Lifetime with more than 200 trades.**
  - Home and Performance show 254 lifetime trades.
  - ALPHA-04 shows 250 lifetime trades with "Showing the latest 50 of 251".
  - Limits 50, 51, 100 and 200 all return 200.
- **Home requests.** No `bot-trades` request at all; the largest response is 5 KB.
- **Reconciliation, to the micro-dollar.**
  - Cash + reserved $999.928637 = $1,000 + $0.010537 lifetime closed net − $0.0819 open entry fee = the sum of the wallets.
  - Equity $999.911357 = book + unrealized − shortfall (0).
  - The ledger's consistency check reports OK.
- **MAIN sweep counted once.** MAIN $600.33406 = $600 + $0.33406 swept. That sweep is inside the lifetime net, not added again.
- **Stale prices.** A Kraken outage keeps the last snapshot, labels it STALE and hides unrealized P&L.
- **ALPHA Assistant.** It answers trade questions with the attached trade's records, and fleet questions (best bot, MAIN) with fleet data.
- **Layout.** No horizontal overflow on 15 pages at 360 px; 402 px dark and 360 px light checked.

## 3. Release A — website + compatible backend (recommended first)

**What it changes:** Worker code plus the frontend assets, at the release commit.

**What it does not change:**
- **Database:** no migration. Production stays on schema 6.
- **Engine:** no engine change.
- **Funds and bots:** no capital transfers and no bot activation.
- **Configuration:** the same `wrangler.jsonc` as production. The same D1 binding `40741873-…` and the same 11 variables, including `ENABLE_TRADING=false` and `PAPER_COST_PROFILE=none`. `worker/wrangler.jsonc` is unchanged since `af924ff`, and `deploy_config.test.mjs` passes.

**Delivered on today's production (schema 6, legacy engine):**
- **Home:** lifetime aggregate from the Worker, with no history download.
- **Capital:** account equity, shortfall and mark age (legacy wallets).
- **Trade cards:** trade cards, proof story summaries and "Ask ALPHA about this trade" for the legacy ledger.
- **Charts:** a chart for every bot (markets from the frontend's bot table), completed-trade charts with exact-candle markers, cross-market safety and stale-price handling.
- **Activity:** one item per legacy execution, refusals kept.
- **Plain-language refusals:** for every refusal.
- **Reliability:** bounded dashboard requests, no duplicate polling, and the stale-snapshot behaviour.

**Inert on schema 6 (shown as such, never as errors):**
- the bot ledger;
- the all-bot Trades view (the legacy Trades page is shown instead);
- per-bot wallets and lifetime;
- bot orders.

These need migration 0007 (Release B).

**Needs newer engine telemetry:**

| Feature | Needs |
|---|---|
| "Why it entered / exited" for **new** trades | The engine release with plan and exit recording (`engine/src/tradeplan.mjs`, "Stage 2b"). Today's engine does not send it, so those trades say "not recorded". Nothing is invented. |
| Planned entry, stop and target on the chart **before** a fill; the live Pipeline per bot | The bot registry (migration 0007) and the fleet engine's `strategy_state` reports. On schema 6 the chart shows market data and completed trades only. |
| Filled-vs-requested reasons, `BOT_*` refusals | Bot-ledger orders (migration 0007 and the fleet engine). |

### Deployment steps (each needs approval; nothing below has been run)

From a clean checkout of the release commit, on the owner's machine with the Cloudflare login:

**1. Read-only pre-flight. Abort on any surprise.**
```
cd worker
npx wrangler deployments list                         # expect 1b51170c-4f9d-41c0-8284-fa8ab61eac81 at 100%
npx wrangler d1 migrations list alpha-terminal-db --remote   # expect "No migrations to apply" (0001–0006)
node node_modules/wrangler/bin/wrangler.js d1 execute alpha-terminal-db --remote --command "SELECT key, value FROM app_meta WHERE key='schema_version'"   # expect 6
npx wrangler d1 time-travel info alpha-terminal-db     # record the current bookmark (read-only)
```
Then record the dashboard's wallet totals, the trade count and any open positions.

**2. Build and test.**
```
cd frontend && npm ci && npm test && npm run build && cd ../worker && npm ci && npm test && npx wrangler deploy --dry-run
```
Expect 302/302. If `funded_sizing.test.mjs` fails with `spawnSync npx ETIMEDOUT`, re-run that file alone (`node --test test/funded_sizing.test.mjs`). Proceed only when it passes.

**3. Upload without switching traffic.**
```
npx wrangler versions upload --message "ALPHA TERMINAL release integration (UI + compatible backend, schema 6)"
```
Note the new version id and its preview URL. The preview uses the **production D1 binding**, so only read and browse there; the engine keeps posting to the production URL.

**4. Preview checks.** Sign in, then check:
- Home: lifetime, equity, Activity;
- Trades and a legacy proof;
- a chart for each bot;
- Performance;
- `/api/dashboard/performance` returns `lifetime`.

**5. Switch traffic [APPROVAL].**
```
npx wrangler versions deploy <new-version-id>@100% --yes --message "release integration"
```

**6. Production verification checklist (read-only).**
- [ ] The dashboard loads; the engine heartbeat is still ONLINE; no new 5xx in `wrangler tail` for 10 minutes.
- [ ] `schema_version` is still 6; the `d1_migrations` count is unchanged.
- [ ] The wallet totals, trade count and open positions equal the pre-flight record. Nothing financial moved.
- [ ] Home's lifetime net equals the previous verified total (legacy trades only); "Partial" is not shown.
- [ ] Account equity shows a value, or "unavailable" with a reason if a position has no mark. Never $0 by mistake.
- [ ] Each Activity execution appears once; refusals are still listed.
- [ ] Legacy trade proof pages open; charts open on SOLUSD 5m for ALPHA-02.
- [ ] The next engine candle is accepted; a new signal (if any) appears in Trades and Activity.

**Recovery.** A code rollback only; the database is untouched by this release:
```
npx wrangler versions deploy 1b51170c-4f9d-41c0-8284-fa8ab61eac81@100% --yes --message "rollback to Stage N5"
```
Never restore D1 for this release: nothing was written to its schema. Time Travel is for data-loss incidents only, with separate approval.

## 4. Release B — financial database and fleet (separate approvals, NOT part of Release A)

**Scope:**
- Migration **0007** (bot registry, bot wallets and positions/fills/orders, the `trade_events` rebuild that widens a CHECK constraint, and `bot_id` columns on legacy tables).
- Bot-ledger short accounting and fee settlement.
- Allocation from MAIN.
- Activation of ALPHA-01, 03 and 04.
- The fleet engine with plan telemetry.

Each step follows the stages R1–R6 in `docs/MULTI-BOT-ARCHITECTURE.md`.

**Requirements before any step:**
1. **Backup.** A Time Travel bookmark, plus a full `wrangler d1 export --remote` stored privately. Exports are private and never committed.
2. **Rehearsal on a private copy.**
   - Import the export into a local D1.
   - Apply 0007 and run `tools/schema6-compat.mjs`-style checks on the migrated copy.
   - Reconcile every wallet (available + reserved = funding + realized − fees − shortfall; the sum equals total funding).
   - Confirm ALPHA-02's history, legacy wallets and Mirror rows are unchanged.
   - Confirm `trade_events` row ids and values are preserved by the rebuild.
3. **The engine release is pinned and checksummed** (the existing pinned-release process), with trading decisions byte-identical to `af924ffa4703` apart from plan metadata.
4. **Owner approval for each of:**
   - the migration;
   - the engine switch;
   - each allocation;
   - each bot activation.

**Recovery for Release B:**
- **Code** rolls back to the Release A version; Release A's Worker reads schema 7.
- **The 0007 migration** is additive. Never delete its tables or history.
- **A D1 restore** only with a data-loss analysis and separate approval.

## 5. Remaining limitations

- **Production-only verification.** Production CPU, latency and D1 usage, real-iPhone push delivery and the Windows engine launcher are unverified. All checks here were local.
- **Activity window.** Activity shows the latest 50 events and has no paging beyond that.
- **Legacy-only views.** On the Performance page, the date ranges, curve and list cover the original ledger only. They are labelled as such; a combined per-trade curve would need a new backend endpoint.
- **Mark age and stale status.** The mark age on Home is computed from recorded mark timestamps. Legacy positions also carry the Worker's own `mark_status`.
- **Bundle size.** The frontend bundle is 588 KB (a code-splitting opportunity, not a defect).
- **Profitability.** The original strategies remain unprofitable at the Ndax-equivalent 0.20% per-fill benchmark (`docs/PARITY-2026-11-13.md`). This release changes presentation and reliability, not strategy results.

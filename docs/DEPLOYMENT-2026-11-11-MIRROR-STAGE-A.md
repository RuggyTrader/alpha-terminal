# Strategy Mirror Stage A — production D1 migration 0005 (2026-11-11)

**Outcome: completed and verified.** Migration `0005_strategy_mirror.sql` was applied to the production D1 database
`alpha-terminal-db`. It ran from commit `0db082fbd0449bf47ac610e74055916c72282412` (clean checkout, equal to
`origin/v1.2.0-cloudflare`) and followed `STRATEGY-MIRROR-ROLLOUT-PLAN.md` Stage A, approved by the owner.

**Results:**
- Schema 4 → 5.
- Three new mirror tables, empty.
- **Every pre-existing table and schema definition unchanged.**
- The engine and Worker kept operating normally.

**Not done (later stages, separate approvals):** no Worker deploy, no engine restart or release change, mirror not
enabled (`ENGINE_MIRROR` absent = off), no fee or trading change, no database restore.

## Timeline (UTC)

| Time | Step | Result |
|---|---|---|
| 00:53:55 | **A1 preflight** (read-only) | Passed: values in the next table |
| 00:55:31 | Baseline fingerprint | SHA-256 of every row of all 15 tables (engine heartbeat key excluded) and of all 25 schema definitions |
| 00:55:42 | **A2 Time Travel bookmark** | `0000002e-000002d8-00005120-2677e95fc3d931fe55a22e5a40cbd311` |
| 00:55:42 | **A2 full export** | `%USERPROFILE%\AlphaTerminal\backups\d1-before-0005-2026-11-11T00-55-42Z.sql`, 47,469 bytes, SHA-256 `5f34ccba2d48aec864a96e53ca9a69b0aab03c14be4aceb6df1cfa03062e9bad` (stored next to it). **Verified:** 15 `CREATE TABLE`, and the `INSERT` count of every table equals the baseline. Private: contains PAPER history and session records |
| 00:55:46 | Side effect of the export | One engine heartbeat (`/webhook/engine-status`) answered HTTP 500; the next, at 00:56:06, was OK. **Explained:** Cloudflare's D1 documentation says "A running export will block other database requests." Only the heartbeat row was involved; no candle, signal or ledger read was affected |
| 00:56:26–28 | **A3 apply** | `wrangler d1 migrations apply alpha-terminal-db --remote` listed **only** `0005_strategy_mirror.sql`; 7 commands executed; ✅, exit 0. `d1_migrations` records it at 00:56:27 |
| 00:57:15 | **A4 validation** | Passed: see below |
| 01:00:05–46 | Engine on schema 5 | Candle processed on time; ledger check OK at 01:00:46; no error |

## Preflight (A1)

| Check | Result |
|---|---|
| Checkout | `0db082f`, clean, equal to the remote branch |
| Pinned engine | release `6b70cc97c579`, files and launcher verified, PID 11900 running; `state-check` ok |
| Engine state | inputs hash `c826d785d58a4a39`, risk $10; last candle 00:45 (later 00:50), 1,289 candles; resets 0; 42 signals, 0 duplicate ids, 0 pending; no position. (42 = 39 earlier + 3 from the 2026-11-10 outage, all expired, none sent) |
| Worker | `e941387e-0942-4320-b0dd-454235095c4b` at 100% |
| Worker variables | `ENABLE_TRADING=false`, `PAPER_COST_PROFILE=none`, `SHORT_SELLING_ENABLED=false`, `MAX_ORDER_QTY=10`, `MAX_ORDER_NOTIONAL=5000`, `MAX_FUTURES_ORDER_NOTIONAL=75000`, `MAX_POSITION_EXPOSURE=10000`, `MAX_TOTAL_EXPOSURE=25000`, `MAX_OPEN_POSITIONS=5`, `DAILY_LOSS_LIMIT=2000`; D1 binding `DB` |
| `/health` | ok, PAPER, database connected, `enable_trading:false` |
| Pending migrations | exactly one: `0005_strategy_mirror.sql` |
| D1 usage (24 h) | 5,053 read and 1,302 write queries; 6,622 rows read, 1,348 rows written; 200,704 bytes; 15 tables |
| Ledger | schema 4; 3 entries, 0 FEE; 0 fills, 0 trades, 0 open positions; alerts 10, orders 4, risk decisions 8 |
| Wallets | MAIN $90.00, SOLUSD $10.00, BTCUSD/ETHUSD/HYPEUSD/KAITOUSD $0. For every wallet: available = sum of its entries = funding + realized − fees; reserved 0 |
| Risk setting | SOLUSD v1, $10, not compounding, APPLIED |

## Post-migration validation (A4)

| Check | Result |
|---|---|
| Schema version | **5** (was 4) |
| Counts, wallet reconciliation, risk setting | **identical** to the baseline |
| Pre-existing tables (row-level SHA-256) | **all 14 identical**: activity_events, alerts, app_meta (heartbeat key excluded), auth_sessions, backtest_results, engine_state, orders, paper_fills, paper_positions, portfolio_entries, portfolio_wallets, risk_decisions, strategy_settings, trades |
| `d1_migrations` | 4 → 5 rows (the 0005 record, applied 2026-11-11 00:56:27), as expected |
| Pre-existing schema definitions | **25 → 25, identical** (excluding the new mirror objects) |
| New objects | `mirror_accounts`, `mirror_entries`, `mirror_trades`, `idx_mirror_trades_account_exit`, `idx_mirror_entries_seq` (+ their automatic unique indexes); **0 rows** in all three tables |
| `migrations list` | "No migrations to apply" |
| Worker | still `e941387e` at 100% (it ignores the new tables); `/health` ok, `enable_trading:false` |
| Engine | 01:00:05 candle processed on time (1,291 candles), resets 0, 0 pending, 0 duplicates; ledger check **OK** at 01:00:46; `lastError` null; no mirror file (mirror off) |

Not checked here: the owner's dashboard view (needs the passphrase). The funded figures it shows come from the
unchanged tables above.

## Recovery

Nothing needs undoing:
- 0005 is additive;
- the deployed Worker and the rollback Worker run on schema 5 (rehearsed in `worker/test/mirror_rollout.test.mjs`).

**Do not restore D1.** The bookmark and export above are for a separately approved disaster scenario only; a restore
discards every later record.

## Lesson for later exports

A D1 export blocks other database requests while it runs. Start exports right after a candle has been processed (as
here), and expect up to one failed engine heartbeat. The plan's Stage A now says so.

## Next

**Stage B (Worker deploy) awaits its own approval.** See `STRATEGY-MIRROR-ROLLOUT-PLAN.md`.

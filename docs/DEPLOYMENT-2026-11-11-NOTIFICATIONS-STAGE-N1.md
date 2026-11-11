# Notifications Stage N1 — production D1 migration 0006 (2026-11-11)

**Outcome: completed and verified.** Migration `0006_events_and_push.sql` was applied to the production D1 database
`alpha-terminal-db` at **05:20:24 UTC**. It ran from approved commit `ffb66bd691bbd10a35f9c0d06365f139b82f5594` and
followed `HOME-NOTIFICATIONS-THEME.md` section 7, Stage N1, approved by the owner.

**Results:**
- Schema 5 → 6.
- Five new tables, of which four are empty; `event_cursors` holds its 3 initial cursor rows.
- **Every pre-existing table and schema definition unchanged**, apart from the expected changes listed below.
- Engine and Worker kept operating normally.

**Not done (later stages, separate approvals):**
- no Worker deploy (still `4d3ddcb6-08a3-472d-8f99-81ff8b317ae2`);
- no engine restart or setting change (`ENGINE_MIRROR_EVENTS` absent = off);
- no VAPID keys; no push activation;
- no funded, risk or cost change;
- no Multi-Crypto V2 deployment;
- no database restore.

## Source

- **Checkout:** a clean, detached worktree of `ffb66bd` (0 local changes), checked out **without line-ending
  conversion**. Windows `core.autocrlf` had first produced a CRLF copy that differed from the commit; it was replaced
  before use.
- **Migration SHA-256:** `da06726f9505e9c83a70d0bce9aca875670271299ff3abe78bb8addd1b1e38d4`, byte-identical to the git
  blob of the approved commit (`cmp`). Migrations 0001–0005 are byte-identical too.
- **Later commits not used:** the branch head also carries Multi-Crypto V2 documentation (`0e4f6b6`), which was not
  used. No migration differs between `ffb66bd` and the branch head.

## Timeline (UTC)

| Time | Step | Result |
|---|---|---|
| 05:16:52 | **Preflight** (read-only) | Passed; values below |
| 05:18:31 | Baseline snapshot | Counts, wallet reconciliation, risk, mirror sequence and journal, SHA-256 of every row of all 18 tables (engine heartbeat key excluded), 30 schema objects |
| 05:18:40 | Stage D monitoring session informed | Told the migration window and the possible export side effect, so its evidence accounts for it |
| 05:20:05 | 05:15 candle processed | Backup starts immediately after |
| 05:20:05 | **Time Travel bookmark** | `0000002f-000002ce-00005120-e1b0a0f3fe5301b6a9a81078fdc0a084` |
| 05:20:07–09 | **Full export** | `%USERPROFILE%\AlphaTerminal\backups\d1-before-0006-2026-11-11T05-20-05Z.sql`, 68,577 bytes, SHA-256 `90152ba8bea5f429d71428d881420dbbdd2bb241adf9d34dbc390ab4b6085c35` (stored next to it). Private: outside git; contains PAPER history and session records |
| 05:20:09 | **Export verified** | Loaded into a scratch SQLite file: `integrity_check` ok; 18 `CREATE TABLE`; 5 migrations; every table's row count equals the baseline; wallet totals $100.00 available, $0 reserved; risk $10 APPLIED |
| 05:20:23–25 | **Apply** | `wrangler d1 migrations apply alpha-terminal-db --remote` listed **only** `0006_events_and_push.sql`; 11 commands executed; ✅, exit 0. `d1_migrations` records it at 05:20:24 |
| 05:21:29 | **Post-migration snapshot and comparison** | Passed; see below |
| 05:25:05–46 | Engine on schema 6 | Candle processed on time; mirror heartbeat delivered; ledger check OK; no error |

**No heartbeat failure this time.** Stage A saw one HTTP 500 during its export; the engine log has no new
`HTTP 500` (the only one is Stage A's, at 00:55:46).

## Preflight

| Check | Result |
|---|---|
| Engine | Release `0db082fbd044` (commit `0db082f…`), files verified, previous `6b70cc97c579`; PID 15952 running; mirror on |
| Engine state | Inputs hash `c826d785d58a4a39`, risk $10 (settings v1); last candle 05:10, 1,342 candles; resets 0; 43 signals, ids unique, 0 pending; no position (status: ORDER PLACED – waiting fill); ledger check OK 05:17:09; `lastError` null; 7 live entries refused earlier by the PAPER ledger |
| Mirror state | Account `MIRROR-SOLUSD-5m-c826d785d58a4a39`, activated 03:41:08; seq 7, delivered 7, 0 pending; 739 candles; resets 0, interruptions 0, observation gaps 0; no open position; no error |
| Worker | `4d3ddcb6-08a3-472d-8f99-81ff8b317ae2` at 100% |
| Worker variables | `ENABLE_TRADING=false`, `PAPER_COST_PROFILE=none`, `SHORT_SELLING_ENABLED=false`, `MAX_ORDER_QTY=10`, `MAX_ORDER_NOTIONAL=5000`, `MAX_FUTURES_ORDER_NOTIONAL=75000`, `MAX_POSITION_EXPOSURE=10000`, `MAX_TOTAL_EXPOSURE=25000`, `MAX_OPEN_POSITIONS=5`, `DAILY_LOSS_LIMIT=2000`; D1 binding `DB`; no VAPID variables |
| `/health` | ok, PAPER, database connected, `enable_trading:false` |
| Pending migrations | exactly one: `0006_events_and_push.sql` |
| Ledger | schema 5; 3 entries, 0 FEE; 0 fills, 0 trades, 0 open positions; alerts 11, orders 4, risk decisions 9 |
| Wallets | All 6 reconcile (available = sum of entries; available + reserved = funding + realized − fees); total $100.00 (MAIN $90, SOLUSD $10) |
| Risk setting | SOLUSD v1, $10, not compounding, APPLIED |
| Mirror in D1 | 1 account; 7 trades, seq 1–7 contiguous; last contiguous 7 = max seen 7 = engine last 7; 0 conflicts; journal 7 × REALIZED_GROSS_PNL = $31.603816 = trades gross |

## Post-migration verification

| Check | Result |
|---|---|
| Schema version | **6** (was 5) |
| `migrations list` | "No migrations to apply" |
| New tables | `mirror_open_events` 0, `trade_events` 0, `push_subscriptions` 0, `push_deliveries` 0 rows; `event_cursors` 3 rows; plus index `idx_push_deliveries_pending` |
| **Event cursors** | `paper_fills = 0` (= MAX(id), no fills exist); `mirror_trades = 7` (= MAX(id)); `mirror_open_events = 0`. Existing records can never become notifications |
| Pre-existing tables (SHA-256 per row) | **16 of 18 identical**: activity_events, alerts, app_meta (heartbeat and schema version excluded), auth_sessions, backtest_results, engine_state, mirror_entries, mirror_trades, orders, paper_fills, paper_positions, portfolio_entries, portfolio_wallets, risk_decisions, strategy_settings, trades |
| Expected changes | `d1_migrations` 5 → 6 (only the 0006 row added; none modified). `mirror_accounts`: its one row advanced with the engine's 05:15 candle report (last candle 05:10 → 05:15, 739 → 740 candles). This is legitimate live activity; its trades, journal and sequence are unchanged |
| Pre-existing schema definitions | **all unchanged**; only the 6 new objects added |
| Counts, wallet reconciliation, risk setting | **identical** to the baseline; 0 FEE entries; 0 duplicate trades (mirror 7 = 7) |
| Mirror sequence / journal | contiguous 1–7; journal $31.603816 = trades gross |
| Worker | still `4d3ddcb6` (not redeployed); it ignores the new tables; `/health` ok, `enable_trading:false`; it accepted the mirror's 05:25 heartbeat |
| Engine | 05:25:05 candle processed on time (1,344 candles), resets 0, 0 pending; ledger check **OK** at 05:25:46; `lastError` null; mirror seq 7, delivered 7, last sent 05:25:05, no gaps; release `0db082fbd044`, PID 15952 (not restarted) |
| Risk / trading / costs | $10 fixed; trading disabled; costs `none` |

Not checked here: the owner's dashboard view, which needs the passphrase. The funded figures it shows come from the
unchanged tables above.

## Errors or interruptions

None:
- The export completed in about 2 s without a failed heartbeat.
- The only procedural note is the line-ending conversion of the first checkout, which was caught by the byte check and
  corrected before anything was applied.

## Recovery

Nothing needs undoing:
- 0006 is additive.
- The deployed Worker `4d3ddcb6` and the new Worker both run on schema 6 (rehearsed in
  `worker/test/migrations.test.mjs` and `worker/test/mirror_rollout.test.mjs`).

**Do not restore D1.** The bookmark and export above are for a separately approved disaster scenario only; a restore
discards every later record.

## Next

**Stage N2 (VAPID keys) is recommended and awaits its own approval.** Production is healthy on schema 6. N2 only adds
configuration; nothing sends a notification until Stage N3 deploys the new Worker. See `HOME-NOTIFICATIONS-THEME.md`
section 7.

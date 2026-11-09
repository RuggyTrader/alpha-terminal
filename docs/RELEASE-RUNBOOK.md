# ALPHA TERMINAL release runbook: execution costs, fee-compatible rollback, pinned engine

**Status: prepared and tested in development only. Nothing in this runbook has been executed against production.**
Every production step needs the owner's separate approval. The approval gates are marked **[APPROVAL]**.

PAPER only throughout. No step enables live trading, touches a broker, or changes the strategy, its TradingView
settings, the fixed $10 risk, the long/short switches, or the PAPER balances.

## 0. Key terms

| Term | Meaning |
|---|---|
| **Code rollback** | Switching the Worker or the engine back to an earlier *program*. The database and its history are kept. This is the routine recovery path. |
| **Database restore** | Rewinding the D1 database to an earlier point in time (D1 Time Travel). **Every PAPER trade, fee, transfer and alert recorded after that point is lost.** Never a routine rollback; needs separate approval and a data-loss analysis (section 8). |
| **Fee-compatible rollback Worker** | Branch `rollback/worker-fee-compat` (`c5bb67e`): the production Worker `cde07af` plus a small patch that understands migration 0004 and recorded fees, and charges no new fee. |
| **Pinned engine release** | The engine's runtime files copied from one exact commit into `<ROOT>\releases\<commit12>`, with a checksum manifest. It is not affected by later development commits. |

Production today:
- Worker version `2cd0119d`, from commit `cde07af` (`docs/DEPLOYMENT-2026-11-08.md`); schema 3.
- Engine running as PID 16048 since 2026-11-09 13:33 −05:00, **from the development checkout** (scheduled task
  `ALPHA TERMINAL Engine` → `outputs\alpha-terminal\engine\deploy\run-windows-production.ps1`).

## 1. Identify what runs now (read-only)

```
cd worker
npx wrangler deployments list            # active Worker version id and its upload time
npx wrangler versions list               # recent versions (for a rollback target)
npx wrangler d1 execute alpha-terminal-db --remote --command "SELECT key, value FROM app_meta"   # schema_version
```

For the engine, check PID, start time and task action:

```
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? CommandLine -like '*run.mjs*' | Select ProcessId, CreationDate, CommandLine"
powershell -NoProfile -File engine\deploy\windows-task.ps1 status
```

The running engine's exact code is **not recorded**. It loaded whatever the working tree held at 13:33. The last
engine commit before then is `943eaea`. The engine runtime changes since then are all off by default:
- `limitThroughTicks` and `ENGINE_LIMIT_THROUGH_TICKS` (both default 0);
- `trendEma` (default 0) and `minStopPct` (default 0);
- the `liquidity` hint, which the production Worker ignores (shown in the `rollback_release` rehearsal).

From the first pinned release onwards, the launcher logs the exact commit at every start.

## 1a. Read-only production checks (2026-11-09 22:14–22:35 UTC)

| Check | Result | How |
|---|---|---|
| Engine running normally | **Yes.** PID 16048 (since 13:33 −05:00); one candle processed every 5 minutes, latest 22:05 UTC processed at 22:10; `state-check`: ok, 969 candles, 0 resets, 39 signals, 0 duplicates, 0 pending | `state-check --dir engine\data\production`, `engine.log` (read only) |
| Engine state folder | `engine\data\production` (`ENGINE_DATA_DIR=data/production`, relative) | `engine\.env` (value only) |
| Open PAPER positions | **None.** Engine state: no position. Ledger: 0 fills, 0 trades, $0 reserved in every wallet (positions are only created with a fill). A direct `COUNT(*)` query timed out; see the note below | D1 `SELECT` |
| Balances reconcile | **Yes.** MAIN $90.00, SOLUSD $10.00, others $0; each wallet's available and reserved equal its entry history; realized $0; funding $100 | D1 `SELECT` (`changed_db: false`, `rows_written: 0`) |
| Worker version | `2cd0119d-0336-431e-98c9-2163ed4f2b29` (`cde07af`), deployed 2026-11-09 03:16 UTC | `wrangler deployments list` |
| Database schema | **3**: `d1_migrations` = 0001, 0002, 0003 | D1 `SELECT` |
| D1 Time Travel | **Available.** Current bookmark returned. Retention depends on the plan; check before deploying | `wrangler d1 time-travel info` (read-only) |
| Database export | **Available.** Schema-only export succeeded (15 tables, no data rows) | `wrangler d1 export --remote --no-data` |
| Scheduled task | **Still points to the development checkout** (`…lpha-terminal\engine\deployun-windows-production.ps1`, working directory `…lpha-terminal\engine`) | `Export-ScheduledTask` (read-only) |

Note: after the first successful query, `wrangler d1 execute --remote` hung on every later attempt (timeouts at
150–300 s), while `time-travel info` and `export` worked. Nothing was changed by any attempt. Re-run the section 2
pre-flight queries on the day of deployment.

## 2. Pre-flight (all read-only) — abort if any check fails

1. **Engine healthy.** The dashboard shows Engine ONLINE with a recent heartbeat, and `engine.log` has no repeated errors.
2. **No open SOLUSD PAPER position.** Dashboard → Portfolio shows SOLUSD reserved $0.00, or:
   `npx wrangler d1 execute alpha-terminal-db --remote --command "SELECT COUNT(*) FROM paper_positions WHERE status='OPEN'"` → `0`.
   *Why:* a position open across the change closes with only its exit fee. That is safe (the rehearsal covers
   it), but its trade shows a cost record for one side only.
3. **Ledger consistent.** Dashboard → Settings/Portfolio consistency is OK. Record the totals:
   - available, reserved, realized, net funding, for each wallet;
   - the number of rows in `portfolio_entries`, `paper_fills` and `trades`.
4. **Schema is 3** (`app_meta.schema_version = '3'`).
5. **Record versions.** Note the active Worker version id (step 1). It is the "before" record, not a rollback
   target once fees exist.
6. **Record a D1 restore point** (free, read-only):
   ```
   npx wrangler d1 time-travel info alpha-terminal-db --timestamp=<now, ISO 8601>
   ```
   Save the returned bookmark and its time in the deployment record. Check the account's Time Travel retention
   window (shorter on the free plan) and complete the deployment well inside it.

## 3. Migration 0004 **[APPROVAL]**

```
cd worker
npx wrangler d1 migrations apply alpha-terminal-db --remote
```

- Applies only `0004_paper_execution_costs.sql`. It rebuilds `portfolio_entries` (same ids, keys and amounts) to
  allow `FEE`, and adds cost columns with neutral defaults.
- Never run the file by hand with `d1 execute --file`.
- The current Worker (`cde07af`) keeps working on schema 4 with no fees, so a delay between steps 3 and 4 is safe
  (rehearsal §2).

**Post-migration validation:**
- `schema_version = 4`;
- the row counts and wallet totals from pre-flight are unchanged;
- dashboard consistency OK;
- `SELECT COUNT(*) FROM portfolio_entries WHERE kind='FEE'` → `0`.

**Abort → no action needed:** if the migration fails, D1 rolls the statement batch back. Confirm `schema_version = 3`
and unchanged totals, and stop.

## 4. Deploy the fee-aware Worker with costs DISABLED **[APPROVAL]**

1. **Pre-stage the rollback Worker as an uploaded, not deployed, version** (so an emergency switch is one command):
   ```
   git worktree add ../alpha-rollback c5bb67e          # or any clean checkout of that commit
   cd ../alpha-rollback/frontend && npm ci && npm run build
   cd ../worker && npx wrangler versions upload --message "fee-compatible rollback c5bb67e"
   ```
   Record its version id as **ROLLBACK_VERSION**.
2. **Deploy the development release with costs off** (from a clean checkout of the approved commit):
   ```
   cd frontend && npm ci && npm run build
   cd ../worker && npx wrangler deploy --var PAPER_COST_PROFILE:none
   ```
3. **Validate:**
   - `GET /health` reports PAPER with trading disabled;
   - dashboard consistency OK;
   - Settings → Execution costs shows **No execution costs**, plus the fill-pricing disclosure;
   - wallet totals unchanged;
   - the next engine signal is accepted, and its fill has `fee_micro = 0` and `cost_profile = 'none'`.

## 5. Activate Ndax estimated costs — separate approval **[APPROVAL]**

- Only after step 4 has run cleanly for an agreed period:
  ```
  npx wrangler deploy --var PAPER_COST_PROFILE:ndax
  ```
- The Ndax profile applies Ndax's published 0.20% fee to **Kraken SOLUSD prices**, plus a 0.10% slippage
  **estimate**. It is not Ndax SOL/CAD execution evidence.
- **Verify one full PAPER lifecycle:**
  - a FEE entry for each fill (`FEE:<client order id>`);
  - the trade's gross, slippage, fees and net;
  - the wallet moves by the net amount;
  - consistency OK, with no duplicate fill or fee.
- **Monitor** for a period:
  - duplicate fills (`SELECT client_order_id, COUNT(*) FROM paper_fills GROUP BY 1 HAVING COUNT(*) > 1` → none);
  - unexpected fees (FEE count = number of fills with `fee_micro > 0`);
  - consistency OK;
  - balance identity: available + reserved = funding + realized − fees.

## 6. Emergency Worker rollback (code only; database kept)

| Situation | Action |
|---|---|
| Costs behave unexpectedly, the Worker is otherwise fine | `npx wrangler deploy --var PAPER_COST_PROFILE:none` (fees already recorded stay; no new fees) |
| The new Worker is faulty | `npx wrangler versions deploy <ROLLBACK_VERSION>@100% -y` (the fee-compatible rollback Worker) |
| No fee has been recorded yet (`FEE` count = 0) | Either of the above. The old version `2cd0119d` is also acceptable, because its consistency check is still exact with no fees |

**Never** redeploy `cde07af` / `2cd0119d` once any FEE exists. Its consistency check has no fee term and reports
"book balance differs from funding + realized P&L" permanently (`cost_audit.test.mjs` §4).

**Post-rollback checks:**
- `consistency.ok` is true;
- Settings shows "DISABLED FOR NEW FILLS" (rollback Worker);
- the FEE count and wallet fees are unchanged from before the rollback;
- the next fills carry no fee;
- duplicate checks as in step 5.

**Roll-forward** is the step 4 or 5 deploy again. The rehearsal shows the books stay exact through rollback and
roll-forward:

| Stage | Available | Reserved | Realized | Fees (FEE rows) | Consistency |
|---|---|---|---|---|---|
| Before rollback | 180.74262 | 18.866 | 0.044651 | 0.436031 (6) | ok |
| Rollback Worker started | 180.74262 | 18.866 | 0.044651 | 0.436031 (6) | ok |
| After trading on the rollback Worker | 200.16062 | 0 | 0.596651 | 0.436031 (6) | ok |
| Roll-forward, after a new fee trade | 200.249776 | 0 | 0.761601 | 0.511825 (8) | ok |

(Funding $200 in every row. Test data on a throwaway local D1: `worker/test/rollback_release.test.mjs`.)

## 7. Pinned production engine **[APPROVAL]** for steps 7.4–7.7

### 7.0 Principle: one state folder, moved once, never copied into a second live place

The engine's saved state lives in one folder:
- `state-SOLUSD-5m.json`: last processed candle, strategy state, outbox of signals, website risk setting;
- `audit-SOLUSD-5m.jsonl`;
- the lock file;
- the logs.

That folder is moved **once** to a shared location outside every git checkout. **Both** setups then point at it:

| Setup | How it finds the state | Value |
|---|---|---|
| Current (development checkout, `run-windows-production.ps1`) | `ENGINE_DATA_DIR` in `engine\.env`, **relative** to the engine folder | written by `migrate-state` |
| Pinned (`<ROOT>\bin\run-release.ps1`) | `ENGINE_DATA_DIR` in `<ROOT>\config\engine.env`, **absolute** | written by `migrate-state` |

So whichever setup starts next (pinned release, an older release, or the original engine) resumes the **same,
latest** state. There is never a stale copy to fall back to, and the engine's lock file in that one folder refuses a
second engine from either setup.

- **Why relative for the current setup.** `run-windows-production.ps1` computes
  `[IO.Path]::GetFullPath((Join-Path <engine> <ENGINE_DATA_DIR>))`. Given an absolute path, that expression **throws**
  ("The given path's format is not supported"), and the supervisor would not start. `migrate-state` therefore writes
  a relative path and checks it with the supervisor's own expression.
- **Today** the live value is `data/production`, i.e. `<checkout>\engine\data\production`.

Safety rules built into the tool (each covered by `engine/test/state-migration.test.mjs`):
- `migrate-state` and `revert-state` refuse while any engine holds the lock on either folder.
- `migrate-state` keeps a checksum-verified backup in `<ROOT>\backups\state-<time>` and copies the state
  byte for byte, verifying it. It renames the old folder `…\production.migrated-<time>`, never deleting it, so
  nothing can resume it by mistake. On any failure, every step already done is undone.
- `validate`, and therefore the launcher, refuse to start:
  - when the state folder is inside a git work tree (a `git clean -x` could delete it);
  - when it is empty (unless the config says `ENGINE_FRESH_START_OK=yes` on purpose);
  - when the release's strategy settings differ from the saved state's (the engine would discard the state and
    start a fresh warm-up).
- A faulty release cannot damage the state. The test's crashing release left it byte-identical.

### 7.1 Prepare and validate (safe any time; touches only `<ROOT>`)

```
set ROOT=%LOCALAPPDATA%\AlphaTerminal\engine-prod
set STATE=%LOCALAPPDATA%\AlphaTerminal\engine-state
node engine\deploy\release.mjs prepare --repo . --ref <full 40-char commit SHA or release tag> --root %ROOT%
node engine\deploy\release.mjs install-launcher --repo . --ref <same commit> --root %ROOT%
node engine\deploy\release.mjs task-xml --root %ROOT% --node "C:\Program Files\nodejs\node.exe"
node engine\deploy\release.mjs status --root %ROOT%
```

- `task-xml` only *reads* the installed task (Export-ScheduledTask). It writes two files:
  - `%ROOT%\task\original.xml`: today's task exactly, written once and never overwritten;
  - `%ROOT%\task\pinned.xml`: identical except the action's arguments and working directory.
- It registers nothing.
- *(A PowerShell script that registers a task is deleted by Microsoft Defender on this PC as potentially unwanted
  software; XML definitions are not.)*

### 7.2 Configuration (one time)

Create `%ROOT%\config\engine.env` **by hand** as a copy of the live `engine\.env`. It holds the webhook secret, which
the tool never copies or prints. Leave `ENGINE_DATA_DIR` out; `migrate-state` sets it.

### 7.3 Pre-migration checks (read-only) — abort if any fails

1. `node engine\deploy\release.mjs state-check --dir engine\data\production` must show:
   - `ok: true`, `duplicate_signal_ids: 0`, `pending_signals: 0`, `open_position: null`;
   - a `lastCandle` no older than 10 minutes;
   - `engine.running: true` (the live engine).
2. The ledger has no open SOLUSD position (section 2, check 2) and is consistent.
3. `release.mjs validate --root %ROOT% --release <commit12>` reports **only** "no saved engine state" (expected
   before migration). Nothing else may be reported.
4. Record a D1 Time Travel bookmark (section 2, check 6).

### 7.4 Stop the engine and move the state **[APPROVAL]**

1. Wait until shortly after a 5-minute candle has been processed (`engine.log`: "processed 1 candle(s) up to …"),
   so the stop happens between polls.
2. Stop the task and engine: `powershell -NoProfile -File engine\deploy\windows-task.ps1 stop`. Confirm no
   `run.mjs` process remains, and `state-check` shows `engine.running: false`.
3. Move the state:
   ```
   node engine\deploy\release.mjs migrate-state --root %ROOT% --old-engine <checkout>\engine --state %STATE%
   ```
4. Verify:
   - `state-check --dir %STATE%` shows the **same** `lastCandle`, `candlesProcessed` and signal count as in 7.3;
   - `engine\.env` now has `ENGINE_DATA_DIR=<relative path>`;
   - `%ROOT%\config\engine.env` has `ENGINE_DATA_DIR=%STATE%`;
   - and:
     ```
     node engine\deploy\release.mjs validate --root %ROOT% --release <commit12> --expect-profile solusd-5m --expect-risk 10
     ```
     prints `ok: true` and `state.resumable: true`.

**Abort here (before any task change):** `release.mjs revert-state --root %ROOT%` puts the latest state back in
`engine\data\production` and restores the original `.env` value. Then `windows-task.ps1 install -NoStart` (or sign
out and in) restarts the original setup exactly as before.

### 7.5 First pinned start (one poll), then switch the task **[APPROVAL]**

```
node engine\deploy\release.mjs activate --root %ROOT% --release <commit12> --expect-profile solusd-5m --expect-risk 10
powershell -NoProfile -ExecutionPolicy Bypass -File %ROOT%\bin\run-release.ps1 -Root %ROOT% -Node "C:\Program Files\nodejs\node.exe" -Once
node engine\deploy\release.mjs state-check --dir %STATE%
```

- **Expected:**
  - `supervisor.log` shows "active release <id> commit <sha> … risk $10; state %STATE%";
  - `candlesProcessed` grew by exactly the candles that closed while stopped, and `lastCandle` is the latest closed
    candle;
  - `warmedUpAt` and `resets` are unchanged (no fresh warm-up);
  - the signal count has not dropped, and there are still 0 duplicates.
- **Then switch the task** to the pinned definition:
  ```
  schtasks /Create /TN "ALPHA TERMINAL Engine" /XML "%ROOT%\task\pinned.xml" /F
  schtasks /Run /TN "ALPHA TERMINAL Engine"
  ```
- **Only the task's action changes:**

  | | Today | After |
  |---|---|---|
  | Action | `conhost --headless powershell … -File <checkout>\engine\deploy\run-windows-production.ps1 -Node node.exe` | `conhost --headless powershell … -File <ROOT>\bin\run-release.ps1 -Root <ROOT> -Node node.exe` |
  | Working directory | `<checkout>\engine` | `<ROOT>` |
  | Triggers, settings, principal | unchanged | unchanged |

### 7.6 Post-migration checks

- Dashboard heartbeat resumes.
- `engine.log` (now `%ROOT%\logs\engine.log`) shows one candle per 5 minutes.
- No signal is re-sent: the Worker answers `DUPLICATE` to any repeat, and the alert count does not jump.
- `state-check` after the next candle shows `+1` candle.
- Ledger consistency OK.

### 7.7 Rollback (choose the smallest that fixes the problem)

| Problem | Action | State |
|---|---|---|
| A new engine release misbehaves | `release.mjs rollback --root %ROOT%`, then restart the task | shared folder, latest |
| The pinned launcher itself misbehaves | `schtasks /Create /TN "ALPHA TERMINAL Engine" /XML "%ROOT%\task\original.xml" /F`, then `schtasks /Run …` (original supervisor; its `.env` already points at the shared folder) | shared folder, latest |
| Abandon the whole migration | stop the task; `release.mjs revert-state --root %ROOT%`; restore `original.xml` as above | moved back to `engine\data\production`, latest |

- Always stop the running engine first (task stop and no `run.mjs` process). The tools refuse while it runs.
- After any rollback, run the 7.6 checks.
- A database restore is never part of an engine rollback (section 8).

### 7.8 Backups kept

- `<ROOT>\backups\state-<time>`: the state at migration.
- `<ROOT>\backups\state-before-revert-<time>`: the state at revert.
- `<ROOT>\backups\old-engine-env-<time>` and `config-env-<time>`: both settings files, which contain the secret, so
  keep `<ROOT>` private.
- The renamed `…\production.migrated-<time>` folder.

Delete these only after the new setup has run cleanly for an agreed period.

## 8. Database restoration (exceptional; separate approval)

Restoring D1 to a Time Travel bookmark **deletes everything recorded after it**:
- PAPER fills, trades and FEE entries;
- transfers, alerts and risk decisions;
- risk-setting changes.

Before any restore:
1. Export the current database (`npx wrangler d1 export alpha-terminal-db --remote --output=pre-restore.sql`).
2. List what would be lost (rows after the bookmark time in `paper_fills`, `trades`, `portfolio_entries`, `alerts`).
3. Get the owner's explicit approval for exactly that loss.

A failed *migration* rolls back by itself (step 3), and a faulty *Worker* is handled by code rollback (step 6).
Neither needs a restore.

## 9. Abort conditions (stop and roll back the step in progress)

- Any pre-flight check fails, or a SOLUSD position is open.
- `consistency.ok` is false at any point.
- Any FEE entry appears while `PAPER_COST_PROFILE=none`.
- A duplicate fill or duplicate FEE, or a fee count different from the fills with a fee.
- Wallet totals change across the migration or a deploy with no trade in between.
- The engine heartbeat stops, signals are rejected with codes not seen before the change, or the launcher reports a
  release that does not verify.
- The Time Travel bookmark was not recorded.
- Engine switch: `state-check` shows a different `lastCandle`/`candlesProcessed` than recorded before the move, any
  `duplicate_signal_ids` > 0, `resets` grew, or `validate` reports `state.resumable: false`.
- Engine switch: any tool refuses with "an engine … is running" (stop it first; never force).

## 10. Final reconciliation (after each production step)

For each wallet:
- available + reserved = net funding + realized − fees;
- available = Σ entries; reserved = Σ open positions' reserve; fees = −Σ FEE entries.

Then:
- trades' `fees_usd` total = Σ fills' `fee_micro` for closed positions;
- trade proof net = sells − buys − fees, for the latest trade;
- record the totals in the deployment record next to the pre-flight values.

## Evidence (development)

| Test | Covers |
|---|---|
| `worker/test/rollback_release.test.mjs` | production data → 0004 (interrupted rollout) → Ndax fees → rollback Worker → roll-forward; duplicates, restarts, partial exits, positions across the migration, unmigrated schema 3. 11/11 |
| `worker/test/cost_audit.test.mjs` | migration row-by-row, fee invariants, concurrency; why `cde07af` is not a fee-safe rollback |
| rollback branch `npm test` | 148/148 (production suite + fee compatibility), deterministic Kraken stand-in |
| `engine/test/release.test.mjs` | pinned release: refs, manifest, tamper, dev commit isolation, config validation (absolute / outside releases / outside git / not empty), profile/$10 risk, activate/rollback, self-test that must process real candles, duplicate engine refused, launcher restart loads the pinned release, `task-xml` from the real task read-only (only the action differs; task unchanged). 12/12 |
| `engine/test/state-migration.test.mjs` | original engine with saved state → migrate-state → pinned release processes new candles → faulty release (state byte-identical) → incompatible release refused → release rollback → original setup on the same state → one engine only across both setups → full revert carries the latest state back; exactly 20 new candles per step, one warm-up, no duplicated signal, one audit log. 10/10 |

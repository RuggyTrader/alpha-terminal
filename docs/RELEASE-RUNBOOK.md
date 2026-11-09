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

## 7. Pinned production engine **[APPROVAL]** for steps 7.4–7.6

**Layout** (proposed root `%LOCALAPPDATA%\AlphaTerminal\engine-prod`, outside every git checkout):

```
<ROOT>\releases\<commit12>\   engine runtime files + RELEASE.json (SHA-256 per file); never edited in place
<ROOT>\config\engine.env      settings and secrets (copied once from engine\.env; never in a release)
<ROOT>\data\                  state, audit log, lock (ENGINE_DATA_DIR is forced here)
<ROOT>\logs\                  engine.log, supervisor.log
<ROOT>\bin\                   run-release.ps1 + release.mjs, installed from an exact commit
<ROOT>\current, previous      active and previous release ids
<ROOT>\history.log            prepare / activate / rollback record
```

A release holds only the import closure of `src/cli/run.mjs` and `src/cli/sync-setup.mjs`, plus `package.json` and
`profiles/*.env`. It never contains tests, fixtures, research tools, reports, parity files or data. Files come
from git objects, so uncommitted edits can never enter a release.

### 7.1 Prepare and validate (safe to run any time; touches only `<ROOT>`)

```
set ROOT=%LOCALAPPDATA%\AlphaTerminal\engine-prod
node engine\deploy\release.mjs prepare --repo . --ref <full 40-char commit SHA or release tag> --root %ROOT%
node engine\deploy\release.mjs install-launcher --repo . --ref <same commit> --root %ROOT%
```

- `prepare` refuses branch names, `HEAD`, short SHAs, revision expressions, and names that are both a tag and a
  branch.
- Repeating it is a verified no-op. A tampered release is refused.

### 7.2 Configuration (one time)

Copy the live `engine\.env` to `%ROOT%\config\engine.env` *by hand*. It holds the webhook secret, so the tool
never copies or prints it. `ENGINE_DATA_DIR` in that file is ignored: the launcher forces `%ROOT%\data`.

### 7.3 Verify

```
node engine\deploy\release.mjs validate --root %ROOT% --release <commit12> --expect-profile solusd-5m --expect-risk 10
node engine\deploy\release.mjs selftest --root %ROOT% --release <commit12>
node engine\deploy\release.mjs status --root %ROOT%
powershell -NoProfile -File engine\deploy\windows-task-release.ps1 show -Root %ROOT%
```

- `validate` checks every checksum and loads the configuration with **the release's own code**. It confirms the
  profile (`solusd-5m`), the effective risk ($10, fixed), longs and shorts enabled, and the data directory.
- `selftest` runs one engine poll from the release with a throwaway data folder, sync forced off and no secret.
  Neither the live state nor the Worker is touched.

### 7.4 One-time state hand-over **[APPROVAL]**

The engine's saved state (`state-SOLUSD-5m.json`, `audit-SOLUSD-5m.jsonl`, outbox) must move once from
`engine\data` to `%ROOT%\data` while **no engine runs**. Otherwise the pinned engine would re-warm from scratch,
and its ledger reconciliation would see any difference.

1. Confirm no SOLUSD position is open (pre-flight 2), and note the last processed candle in `engine.log`.
2. Stop the current task and engine:
   `powershell -NoProfile -File engine\deploy\windows-task.ps1 stop`.
   Confirm no `run.mjs` process remains.
3. Copy `engine\data\*` to `%ROOT%\data\`. Keep the original folder untouched as the backup.

### 7.5 Activate and switch the task **[APPROVAL]**

```
node engine\deploy\release.mjs activate --root %ROOT% --release <commit12> --expect-profile solusd-5m --expect-risk 10
powershell -NoProfile -ExecutionPolicy Bypass -File engine\deploy\windows-task-release.ps1 install -Root %ROOT%
```

The task keeps its name, triggers (sign-in, plus a 3-minute fallback) and conhost `--headless` launch. Only its
action changes:

| | Today | After migration |
|---|---|---|
| Action | `conhost --headless powershell -File <dev checkout>\engine\deploy\run-windows-production.ps1 -Node node.exe` | `conhost --headless powershell -File <ROOT>\bin\run-release.ps1 -Root <ROOT> -Node node.exe` |
| Working directory | `<dev checkout>\engine` | `<ROOT>` |
| Code that runs | whatever the dev checkout holds at sign-in | the verified `<ROOT>\current` release only |
| Duplicate guard | mutex per data folder + engine lock | mutex per root + engine lock (unchanged mechanism) |

Start it (`Start-ScheduledTask -TaskName "ALPHA TERMINAL Engine"`) or sign out and in. Then check:
- `supervisor.log` shows "active release <id> commit <sha> … verified; profile solusd-5m, risk $10";
- the engine resumes from the copied state, with no re-sent signals (duplicates are refused by the Worker anyway);
- the dashboard shows the heartbeat.

### 7.6 Engine release updates and rollback

- **Update:** `prepare` a new commit, then `validate`, `selftest`, `activate`, and a deliberate restart of the
  task. Nothing changes until that restart, and development commits never change `<ROOT>`.
- **Rollback:** `release.mjs rollback --root %ROOT%` (it switches `current` to `previous` after verifying it),
  then restart the task. `<ROOT>\data`, the configuration and the logs are untouched.
- **Back to the old setup** (abort of 7.5): reinstall the old task with
  `engine\deploy\windows-task.ps1 install -NoStart` while the pinned engine is stopped. The original
  `engine\data` was left as the backup in 7.4.

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
| `engine/test/release.test.mjs` | pinned release: refs, manifest, tamper, dev commit isolation, config validation, profile/$10 risk, activate/rollback with state preserved, self-test, duplicate engine refused, launcher restart loads the pinned release, real task unchanged. 12/12 |

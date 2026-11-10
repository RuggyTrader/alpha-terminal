# Engine migration attempt, 2026-11-09 — ROLLED BACK (no data lost)

**Outcome: the pinned-engine migration was attempted with owner approval and rolled back. Root cause found the same night (section 4).** ALPHA TERMINAL runs
exactly as before:
- original scheduled task, byte-identical to the exported original;
- original supervisor and engine in the development checkout, on `engine\data\production`.

The latest state was preserved throughout. No candle was skipped or processed twice, and no signal was sent,
duplicated or lost. The Worker, D1, balances, strategy and risk are unchanged.

Times are UTC. Secrets are not recorded here.

## 1. Preflight (all read-only; every critical check passed)

| Check | Result |
|---|---|
| Engine | exactly one engine (PID 16048, since 18:33:03) and one supervisor (PID 10592); every 5-minute candle since 18:00 processed once (61 contiguous, no gaps, no duplicates); 84 logged errors, all Kraken fetch timeouts during the 21:37–21:39 outage, none since; no restarts since 18:33 |
| Saved state (pre-stop, 23:09) | `state-check` ok; last candle 23:00, 980 candles, 39 signals, 0 duplicates, 0 pending, no position, risk $10 (website setting v1), settings hash `c826d785d58a4a39`, warm-up 2026-11-09T01:28:50Z, 0 resets |
| D1 (read-only, run twice, identical, `changed_db: false`) | schema 3 (migrations 0001–0003; the 0004 fee column absent); 0 open positions, 0 reserved; 0 fills, 0 trades; MAIN $90.00 and SOLUSD $10.00, each reconciled with its entry history (funding = balance, realized $0); no unexpected entry kinds; risk SOLUSD $10 v1 APPLIED |
| Worker | `2cd0119d-0336-431e-98c9-2163ed4f2b29` (`cde07af`) at 100%; ENABLE_TRADING false; limits $5,000 per order / $10,000 per position / $25,000 total / 5 positions / $2,000 daily loss; short selling off; no cost profile; `/health` ok |
| Strategy compatibility | release commit `d29ac8f86f9ba93ab0de3abf444ce7728625b9e4` vs `943eaea` (the last engine commit before the running engine started): identical production inputs, identical settings hash (= saved state), identical 150-day replay (579 trades, 308 long / 271 short, +$150.24) and 69-trade benchmark (+$249.99), trade for trade. Runtime differences are default-off options plus the `liquidity` signal field, which the production Worker ignores |
| Recovery readiness | task export works; disk 136 GB free; antivirus: Reason Cybersecurity active, definitions current; Windows Defender passive (normal with a third-party AV) |

**D1 query note.** `npx wrangler d1 execute --remote` hung on some queries. The cause is the Windows `npx` wrapper
(`cmd.exe`) mangling quoted SQL: wrangler never started. Running `node node_modules\wrangler\bin\wrangler.js d1
execute …` works reliably. Use that form in the runbook.

## 2. Preparation (outside the git checkout; nothing switched)

- Root `%LOCALAPPDATA%\AlphaTerminal\engine-prod`:
  - release `d29ac8f86f9b`, 13 runtime files with a verified SHA-256 manifest, from git objects;
  - launcher (`run-release.ps1` and `release.mjs`) from the same commit, verified.
- `config\engine.env`: a copy of `engine\.env` (8 keys, identical except the data-folder line), not printed.
- `task\original.xml` = the installed task (verified identical). `task\pinned.xml` differs only in the action's
  arguments and working directory; triggers, settings and principal are identical.
- `validate`: profile `solusd-5m`, risk $10, longs and shorts on, fixed sizing, sync on to the production Worker,
  secret set, settings hash `c826d785d58a4a39`. Before migration the only problem was "no saved engine state", as
  expected.
- Self-test of a byte-identical copy of the release in a throwaway root (sync off, no secret): 720 live Kraken
  candles processed up to 23:00; release unchanged.

## 3. Timeline

| Time | Step | Result |
|---|---|---|
| 23:10:05 | the original engine processes the 23:05 candle (strategy status: limit order resting, no position) | safe stopping point |
| 23:10:32 | `windows-task.ps1 stop` | 0 engines, 0 supervisors; lock released; final state: last candle 23:05, 981 candles, 39 signals |
| 23:13:34 | `migrate-state` to `%LOCALAPPDATA%\AlphaTerminal\engine-state` | checksums identical to the post-stop record (shared folder and backup); both setups resolve the shared folder; old folder renamed; settings resumable |
| 23:14:04 | activate the release; launcher `-Once` (production config, sync on) | verified commit `d29ac8f…`; `resumed: true`; ledger check OK; heartbeat OK; no new candle (the 23:10 candle had not closed) |
| 23:14:31 | `schtasks /Create /XML pinned.xml`, then `Start-ScheduledTask` | registered (only the action differs), but **the task failed to start: `0x8007010B` (ERROR_DIRECTORY)**. No supervisor ran. Retried at 23:15:35: same error |
| 23:15:20 | the task's exact action run by hand (`conhost --headless … run-release.ps1 -Once`) | worked: processed the 23:10 candle once; `resumed: true`; heartbeat OK |
| 23:16:00 | runbook 7.7 (Situation B): `schtasks /Create /XML original.xml`, start | task identical to the original; the original supervisor started an engine (PID 1076) on the shared folder (lock written there) |
| 23:16–23:21 | **the original engine hung after writing its lock**: no log line, no start record, ~0 CPU, and the 23:15 candle (due 23:20:05) was not processed. The log files were not locked (an append-open test succeeded) | recovery on the new location failed |
| 23:21:42 | `windows-task.ps1 stop` | 0 engines; shared state unchanged since 23:15:21 (the latest valid state) |
| 23:21:52 | runbook 7.7 (Situation C): `revert-state` | latest state moved back to `engine\data\production`; `.env` restored to `ENGINE_DATA_DIR=data/production` |
| 23:22:07 | start the original task | engine PID 5832; `resumed: true`; processed the 23:15 candle once; ledger check OK; heartbeat OK |
| 23:25:05 | next candle | 23:20 processed on schedule |

**Continuity (audit log):** candles 22:50, 22:55, 23:00, 23:05, 23:10, 23:15 and 23:20, each processed exactly
once (0 gaps, 0 duplicates). Final state: 984 candles, 0 resets, warm-up unchanged, 39 signals, 0 duplicates, risk
$10, settings hash unchanged.

**D1 after rollback (read-only):** identical to preflight. Schema 3; MAIN $90, SOLUSD $10; 0 positions, fills or
trades; alerts 10 and orders 4, unchanged, so no signal was sent during the window. Worker `2cd0119d` unchanged.

## 4. Why it failed — CONFIRMED by an isolated test (2026-11-10 00:00–00:07 UTC)

**Cause: Windows file-system redirection for packaged apps, not the antivirus.**

- The Claude desktop app, which ran every tool command, is a packaged (MSIX) app (`Claude_pzs8sxrjxfjjc`).
- Files its processes write under `%LOCALAPPDATA%` are redirected into
  `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\…`. Those processes see them at the normal path.
- Processes started by **Task Scheduler** run outside the app and see the *real* `%LOCALAPPDATA%`, where
  `AlphaTerminal\engine-prod` did not exist.
- The redirected copies are confirmed: 45 files for `AlphaTerminal` and 21 for the test root.

That explains both failures:
1. **Pinned task, `0x8007010B` ("directory name is invalid").** For Task Scheduler the working directory did not
   exist.
2. **"Hung" original engine (PID 1076).** It was not hung. Its relative `ENGINE_DATA_DIR` resolved to the *real*
   `%LOCALAPPDATA%\AlphaTerminal\engine-state`, which was empty. It created that folder and ran a **fresh warm-up**
   there, while the tools were looking at the redirected copy that held the real state.

**What the stray engine did** (its files, copied read-only via a temporary task):
- `resumed: false`; it warmed up from Kraken's last 720 candles;
- 28 derived signals, all `historical` (**never sent**); one live candle (23:15) with no signal;
- one ledger check (OK), one heartbeat to the Worker, and a re-applied risk setting ($10 → $10).

D1 confirms that nothing reached the ledger (alerts 10 and orders 4, unchanged). The real production state was never
touched by it: it stayed in the redirected folder, was moved back by `revert-state`, and was resumed by the original
engine.

**Isolation test** (temporary trigger-less task "ALPHA TERMINAL isolation test", test roots, sync off, no secret;
production untouched throughout; the task was removed afterwards):

| Test | Root | Result under Task Scheduler |
|---|---|---|
| T1 | `%LOCALAPPDATA%\AlphaTerminal-test` | `0x8007010B`, launcher never ran (reproduces failure 1) |
| T1b | same, task working folder = profile | exit 0, but the script was never found (no log) |
| T2 | `%USERPROFILE%\AlphaTerminal-test` | **OK**: launcher verified the release; engine processed 720 candles |
| T3 | `%USERPROFILE%\Documents\AlphaTerminal-test` | **OK**: same |

(The first T1–T3 run was invalid: PowerShell had stripped the quotes from the test task's arguments. It was re-run
with the arguments verified before registering. T2 and T3 also needed their release activated before they could pass.)

## 5. What is left on disk (kept on purpose; nothing deleted)

| Path | What it is | Note |
|---|---|---|
| redirected `%LOCALAPPDATA%\AlphaTerminal\engine-prod\` (physically `…\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\AlphaTerminal\`) | release, launcher, task XMLs, logs, backups, records | `config\engine.env` and `backups\old-engine-env-*` / `config-env-*` contain the webhook secret: keep private, and delete when no longer needed (owner's decision). Unusable by Task Scheduler; the launcher also refuses it now |
| real `%LOCALAPPDATA%\AlphaTerminal\engine-state\` | the stray warm-up state of PID 1076 | stale; never resume it |
| redirected `…\engine-state.reverted-…`, `…\backups\state-*` | the real state as of 23:10 and 23:15 | stale; evidence only |
| `engine\data\production.migrated-2026-11-09T23-13-34-237Z` (dev checkout, git-ignored) | pre-migration folder (state as of 23:10) | stale; never rename it back over `production` |
| `%USERPROFILE%\AlphaTerminal-test\`, `%USERPROFILE%\Documents\AlphaTerminal-test\`, redirected `%LOCALAPPDATA%\AlphaTerminal-test\` | isolation-test roots (no secrets) | safe to delete after review |

## 6. Fix and next step

- **Fixed in development** (`engine/deploy/release.mjs`): `prepare`, `install-launcher`, `migrate-state`, `task-xml`
  and `validate` refuse a root or state folder under `%LOCALAPPDATA%` or `%APPDATA%`. The runbook default is now
  `%USERPROFILE%\AlphaTerminal\engine-prod` and `…\engine-state`. Section 7.3 now requires a Task Scheduler
  rehearsal with a temporary, trigger-less task before production is stopped.
- **Next migration attempt** (needs approval): the same procedure with root and state under
  `%USERPROFILE%\AlphaTerminal`, preceded by the 7.3 rehearsal. Everything else worked as designed on 2026-11-09:
  release, tooling, state preservation, compatibility and rollback.

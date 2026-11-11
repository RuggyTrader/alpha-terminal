# Strategy Mirror Stage C — new pinned engine release, mirror activated (2026-11-11)

**Outcome: succeeded; no rollback.**
- **Active release:** `0db082fbd044` = commit `0db082fbd0449bf47ac610e74055916c72282412`.
- **Configuration:** one new line, `ENGINE_MIRROR=on`.
- **Restart:** one controlled restart at 03:40:26–03:41:08 UTC.
- **Funded track:** resumed its saved state exactly (no warm-up, no reset) and processes every candle as before.
- **Strategy Mirror:** activated at **2026-11-11T03:41:08.916Z** with its own state file, and delivers to the Worker.

**Not done:**
- no Worker deploy, no D1 migration;
- no change to balances, the strategy, the $10 risk, limits, fees or trading;
- no forced signal or trade.

Stage D (extended monitoring) awaits its own approval.

## 1. Preflight (02:55–02:57 UTC)

| Check | Result |
|---|---|
| Engine | release `6b70cc97c579` verified, running (supervisor 2220 → engine 11900, one chain from the scheduled task); last candle 02:50, 1,314 candles; warmed up 2026-11-09T01:28:50Z; resets 0; 42 signals, 0 duplicates, 0 pending; no position; a resting strategy order ("ORDER PLACED – waiting fill"); ledger check OK; no mirror file; no `ENGINE_MIRROR` setting |
| Worker | `4d3ddcb6-08a3-472d-8f99-81ff8b317ae2` at 100%; `/health` ok, PAPER, `enable_trading:false` |
| D1 | schema 5; all 18 tables byte-identical to the Stage B post-deploy fingerprint; mirror tables 0/0/0 |
| Ledger | 3 entries, 0 FEE, 0 fills, 0 trades, 0 open positions; MAIN $90.00, SOLUSD $10.00, others $0; every wallet reconciles; risk SOLUSD v1 $10 APPLIED |
| Configuration | profile `solusd-5m`, sync on to the production Worker, poll 20 s, late bars 2, shared state folder `%USERPROFILE%\AlphaTerminal\engine-state` |
| PC on | the PC is usually powered off at night (UTC 01–07). The owner confirmed it would stay on for the restart and verification window |

## 2. State preserved

Backup folder: `%USERPROFILE%\AlphaTerminal\backups\stage-c-before-2026-11-11T02-57-25Z\`. It has a `SHA256SUMS` file
and is private, because `config/engine.env` holds the webhook secret.

| File | SHA-256 |
|---|---|
| `engine-state/state-SOLUSD-5m.json` (live state at 02:57; last candle 02:50, 1,314 candles) | `05e3dff35c5ac48221a9b427daa06a780b69e50470216ad9dbf4e4ef839923e8` |
| `engine-state/audit-SOLUSD-5m.jsonl` | `b3f639476a59c4d0226f3d55cc6c5451511fe779f6f51779c01c392dd9ce8b58` |
| `engine-prod/config/engine.env` (before the change) | `a23b0e6cff44b1df5edde7f827d22afa605e0e4ccca0b55b32f1dd6e74fb4988` |
| `engine-prod/current` (`6b70cc97c579`) | `c483a9d589be9e554fb4d5545699c73f94983d5f10351563777ed4db2a102d7b` |
| `engine-prod/history.log`, `state-migration.json`, `task/original.xml`, `task/pinned.xml`, both `RELEASE.json` manifests | in `SHA256SUMS` |

A further copy of the state at the moment the old engine stopped (03:40:53; last candle 03:35, 1,323 candles) is
`state-SOLUSD-5m.at-stop-03-40-53Z.json` in the same folder.

The authoritative state was never replaced: the new release resumed the same file.

## 3. Release `0db082fbd044`

- **Prepared** with `release.mjs prepare --ref 0db082fbd0449bf47ac610e74055916c72282412`: 14 files from git objects,
  checksum manifest.
- **Both manifests verify** (`6b70cc97c579` and `0db082fbd044`).
- **Compared file by file with `6b70cc97c579`:**
  - **identical SHA-256:** `ote.mjs`, `broker.mjs`, `indicators.mjs`, `sizing.mjs`, `kraken.mjs`, `sync_check.mjs`,
    `cli/run.mjs`, `cli/sync-setup.mjs`, `profiles/solusd-5m.env`, `profiles/paper-test.env`, `package.json`;
  - **changed:** `config.mjs` (the `ENGINE_MIRROR` setting), `runner.mjs` (mirror integration);
  - **new:** `mirror.mjs`.

  The strategy, its LONG/SHORT logic, its inputs and the fixed $10 risk are unchanged.
- **`validate`** (before the config change): ok; profile `solusd-5m`, risk $10, long and short on, fixed sizing,
  inputs hash `c826d785d58a4a39`, production Worker endpoint, `state.resumable: true`, `mirror: false`.
- **`selftest`** (throwaway state, sync off, nothing sent): ok; 720 real Kraken candles processed; the same strategy
  status as the live engine; release unchanged.
- **The launcher was not reinstalled.** `run-release.ps1` is identical in both commits. The installed launcher starting
  the new release is the path rehearsed in `engine/test/mirror-release.test.mjs` part 2.

## 4. Activation and the controlled restart

1. `engine.env`: appended `ENGINE_MIRROR=on`. The diff against the backup is exactly that one line.
2. `validate`: `ok: true`, `mirror: true`, `state.resumable: true`, inputs `c826d785d58a4a39`, risk 10, Worker
   endpoint unchanged, no problems, no warnings.
3. `selftest` with the mirror on: ok; a throwaway mirror was created and activated after 720 warm-up candles.
4. **03:40:26** (21 s after the 03:40 candle was processed): `activate --release 0db082fbd044`, so `current` =
   `0db082fbd044`, previous `6b70cc97c579`.
5. **03:40:27** `schtasks /End /TN "ALPHA TERMINAL Engine"`. **Finding:** this ended only the task's top process
   (conhost). The supervisor (PowerShell 2220), cmd 11824 and engine 11900 kept running.
   - **03:40:50:** stopped that supervisor tree (`taskkill /PID 2220 /T /F`).
   - Confirmed no supervisor or engine process remained; `status`: engine not running, lock released.
   - Recorded the state at stop.
6. **03:41:08** `schtasks /Run /TN "ALPHA TERMINAL Engine"`. The task definition, triggers and account are unchanged.
   - **Exactly one chain:** conhost 21696 → PowerShell 26120 (supervisor) → cmd 20960 → node **15952** (engine).
   - `supervisor.log`: "active release 0db082fbd044 commit 0db082fb… verified; profile solusd-5m, risk $10; state …
     (last candle 2026-11-11T03:35:00Z)".

## 5. Funded track continuity

| | At stop (03:40:53) | After restart (03:41:46) | After 2 candles (03:52:53) |
|---|---|---|---|
| `startedAt` / `warmedUpAt` | 2026-11-09T01:28:50.662Z | **same** | **same** |
| Resets | 0 | 0 | 0 |
| Last candle / candles processed | 03:35 / 1,323 | 03:35 / 1,323 (resumed; nothing re-processed) | **03:45 / 1,325** |
| Signals / duplicate ids / pending | 42 / 0 / 0 | 42 / 0 / 0 | 42 / 0 / 0 |
| Strategy status | ORDER PLACED – waiting fill | same (resting order kept) | same |
| Ledger check | OK | OK 03:41:30 | OK 03:52:49 |
| Risk setting | v1 $10 | v1 $10 | v1 $10 |

- **Audit:**
  - `process_start` (pid 15952, **resumed: true**);
  - `mirror_created`;
  - `mirror_activated` (720 warm-up candles, 6 warm-up trades);
  - `ledger_check` OK, heartbeat ok;
  - then one `candle` entry at 03:45:05 and one at 03:50:05.
  - No error, reset or warm-up of the funded track.
- **Candles on time:** 03:40 candle at 03:45:05.212, 03:45 candle at 03:50:05.219.
- **D1 funded tables:** every funded table is byte-identical to the preflight at 03:53:25:
  - counts, wallet reconciliation and the risk setting identical;
  - MAIN $90.00, SOLUSD $10.00;
  - 0 FEE, 0 fills, 0 trades.
  - Only the mirror tables changed.

## 6. Strategy Mirror activation

| Item | Result |
|---|---|
| State file | `%USERPROFILE%\AlphaTerminal\engine-state\mirror-SOLUSD-5m.json` (separate from `state-SOLUSD-5m.json`) |
| Account | `MIRROR-SOLUSD-5m-c826d785d58a4a39`; release `0db082fbd044`; risk $10; reporting baseline $10,000; comparison cost model `ndax` (never charged) |
| Activation | **2026-11-11T03:41:08.916Z**, recorded once (one `mirror_activated` audit entry; the Worker's `activated_at` is the same) |
| Warm-up replay | 720 Kraken candles (2026-11-08 ~15:40 to 11-11 03:35); **6 trades, all `historical`**: 1 LONG, 5 SHORT; gross **+$29.36**; modelled net (Ndax comparison) −$36.24; no reference price (not live) |
| Live / catch-up | **0 / 0**: no trade completed in the 2 live candles observed. No live trade was forced; the first one is still to come |
| Live candles | 03:40 and 03:45, processed on time (`late: false`); mirror candle count 722 |
| Delivery | 6 records stored; Worker sequence `last_contiguous_seq = max_seq_seen = engine_last_seq = 6`; missing 0; conflicts 0; engine outbox empty (no pending, no refused) |
| Reconciliation | 6 journal entries, total **29.363978** = the trades' gross 29.363978 |
| Resets / interruptions / observation gaps | 0 / 0 / none |
| Independence | the funded track holds no position and dropped nothing during these candles; mirror records changed no funded row (above) |

The 6 historical trades (seq 1–6) include 4 of the strategy's own entries that the funded track could not take:
2026-11-09 12:35 and 14:15 SELL, and 2026-11-10 05:45 and 07:30 SELL. Those were expired after the outages or refused.
The mirror now shows their hypothetical outcome, as designed:
- trailing stop +$2.83;
- stop loss −$10.06;
- TP2 +$14.88;
- TP2 +$14.56.

**Duplicate delivery** was not exercised in production: no retry was needed. The protection is unchanged from the
tested build (`worker/test/mirror.test.mjs`, `mirror_rollout.test.mjs`).

## 7. Cloudflare (production evidence)

A read-only `wrangler tail` ran from 03:42 to 03:52 UTC.

| Route | Requests | Status | Outcome | CPU time (max) | Exceptions |
|---|---|---|---|---|---|
| `POST /webhook/engine-status` | 31 | 200 | ok | 3 ms | 0 |
| `POST /webhook/engine-ledger` | 31 | 200 | ok | 2 ms | 0 |
| `POST /webhook/engine-mirror` | **2** (03:45:04, 03:50:04: one per candle) | 200 | ok | **3 ms** (wall ~122 ms) | 0 |

- The mirror adds about one request per candle, as designed; no retries; no authentication errors.
- **CPU is far below the 10 ms Workers Free limit.**
- The warm-up delivery (6 records) fitted in one request, within the 25-record cap. Its `d1_queries` is ≤ 9 by
  construction (the bound is tested).
- **D1 (24 h, at 03:53):**
  - 5,516 read and 1,358 write queries;
  - 7,230 rows read, 1,404 rows written;
  - size 245,760 bytes.
  - Far inside the free quotas (5 M rows read and 100 k rows written per day).

## 8. Errors, warnings, rollbacks

- No engine, Worker or D1 error.
- No rollback.
- **One procedural finding:** `schtasks /End` does not stop the release supervisor's child processes; they had to be
  stopped explicitly. The runbook now says so (`STRATEGY-MIRROR-ROLLOUT-PLAN.md` Stage C step 4, and the recovery
  table).

**Rollback, if ever needed** (not used):
- **Funded engine:** `release.mjs rollback --root R` (back to `6b70cc97c579`), then end the task, stop the supervisor
  tree, and start the task. The old release resumes the same state and ignores the mirror file.
- **Mirror only:** set `ENGINE_MIRROR=off` and restart the same way. Keep `mirror-SOLUSD-5m.json`.
- **Never** delete the mirror file or restore D1.

## 9. Recommendation

**Stage C succeeded. Stage D (monitoring) is recommended:**
- the first legitimate live hypothetical trade;
- continued funded independence;
- observation gaps on nights the PC is off;
- daily D1 usage;
- an external TradingView CSV comparison when available.

# Strategy Mirror V1 — production rollout plan (prepared 2026-11-10; NOT executed)

**Every stage is a separate owner approval.** Nothing below has been run against production.

Production today:
- engine release `6b70cc97c579` (no mirror code);
- Worker `e941387e` (= `8b188c8`) at 100%;
- D1 schema 4;
- `PAPER_COST_PROFILE=none`, `ENABLE_TRADING=false`.

Each stage was rehearsed on isolated copies; the evidence is in `STRATEGY-MIRROR-READINESS-AUDIT-2026-11-10.md`.

The rollout changes no funded balance, strategy input, the $10 risk, cost profile, trading flag or task definition.
**Never restore D1 as a recovery step**: a Time Travel restore discards every later record and needs its own
approval and data-loss analysis.

**Notation:**
- `W` = `node node_modules\wrangler\bin\wrangler.js` run from `worker\` of a clean checkout of the approved commit;
- `R` = `%USERPROFILE%\AlphaTerminal\engine-prod`;
- `S` = `%USERPROFILE%\AlphaTerminal\engine-state`;
- `T` = `node R\bin\release.mjs`.

**Timing:** start each stage right after a candle has been processed (`engine.log` shows `processed 1 candle`), at a
time when the PC stays on. The PC is powered off most nights between about 01:00 and 07:00 UTC; see the audit.

---

## Stage A — Database (migration 0005) [APPROVAL A]

**A1. Fresh preflight (read-only).** Abort if anything differs from the last report in a way normal trading does not
explain.

```
T status --root R                      (release 6b70cc97c579 verified, engine running)
T state-check --dir S                  (0 pending signals, 0 duplicate ids)
W deployments status                   (e941387e-0942-4320-b0dd-454235095c4b at 100%)
W d1 migrations list alpha-terminal-db --remote     (exactly one pending: 0005_strategy_mirror.sql)
W d1 info alpha-terminal-db --json     (record size and 24-hour reads/writes)
W d1 execute alpha-terminal-db --remote --json --command "<COUNTS>"
```

`<COUNTS>`:

```
SELECT (SELECT value FROM app_meta WHERE key='schema_version') AS schema_version,
  (SELECT COUNT(*) FROM portfolio_entries) AS entries,
  (SELECT COUNT(*) FROM portfolio_entries WHERE kind='FEE') AS fee_entries,
  (SELECT COUNT(*) FROM paper_fills) AS fills, (SELECT COUNT(*) FROM trades) AS trades,
  (SELECT COUNT(*) FROM paper_positions WHERE status='OPEN') AS open_positions,
  (SELECT COUNT(*) FROM alerts) AS alerts, (SELECT COUNT(*) FROM orders) AS orders,
  (SELECT COUNT(*) FROM risk_decisions) AS risk_decisions,
  (SELECT group_concat(wallet||':'||available_micro||'/'||reserved_micro||'/'||realized_pnl_micro||'/'||net_funding_micro||'/'||fees_micro, ' ')
     FROM (SELECT * FROM portfolio_wallets ORDER BY wallet)) AS wallets
```

Expected: schema 4, 0 FEE entries, MAIN 90000000 and SOLUSD 10000000 available, other wallets 0.

**A2. Recovery point.**

```
W d1 time-travel info alpha-terminal-db                        (record the bookmark and its time)
W d1 export alpha-terminal-db --remote --output=%USERPROFILE%\AlphaTerminal\backups\d1-before-0005-<UTC>.sql
```

Verify the export: for each funded table, the number of `INSERT INTO "<table>"` lines equals its `<COUNTS>` value.
The file contains PAPER history and the session table: keep it private and never commit it.

**A3. Apply.**

```
W d1 migrations apply alpha-terminal-db --remote               (lists 0005 only; auto-confirmed when non-interactive)
```

**A4. Post-migration validation (read-only).**
- `<COUNTS>` is identical to A1, except `schema_version` = 5.
- `SELECT name FROM sqlite_master WHERE name LIKE 'mirror_%'` lists `mirror_accounts`, `mirror_entries`,
  `mirror_trades` (empty).
- `/health` is ok.
- The next candle: `engine.log` normal, `state-check` +1 candle.

The deployed Worker ignores the new tables (rehearsed).

**Abort and recovery (A).**

| Situation | Action |
|---|---|
| Preflight differs | stop; nothing done |
| Export incomplete or unreadable | stop before A3 |
| `migrations apply` errors | D1 rolls the migration back; confirm `<COUNTS>` = A1 (schema 4); stop and report |
| Anything after A3 | nothing to undo for the funded system: 0005 is additive and both earlier Workers run on schema 5 (rehearsed). Do **not** restore D1. Removing the empty tables would be a separate, approved migration |

---

## Stage B — Worker [APPROVAL B]

**B1. Confirm the rollback targets exist (read-only).**
- `W versions view e941387e-0942-4320-b0dd-454235095c4b`: today's Worker; first rollback target, rehearsed on
  schema 5.
- `W versions view 39b41f96-111f-442c-98f3-ccf68699fdeb`: the fee-compatible `c5bb67e`, second target, rehearsed on
  schema 5.

**B2. Deploy** from a clean checkout of the approved commit:

```
cd frontend && npm ci && npm run build
cd ..\worker && W deploy --message "ALPHA TERMINAL <commit12> Strategy Mirror V1 Worker (hypothetical mirror ingestion; PAPER_COST_PROFILE=none)"
```

- Do not pass `--var`.
- The printed bindings must equal today's exactly: `DB`, `ENABLE_TRADING "false"`, the 9 limits, and
  `PAPER_COST_PROFILE "none"`. **No new variable.**
- Record the new version id.

**B3. Verify.**
- `/health` shows PAPER, `enable_trading:false`, database connected.
- `deployments status` shows the new version at 100%.
- Without a session: `/api/dashboard` and `/api/dashboard/mirror` → 401.
- Wrong secret: `/webhook/dry-run`, `/webhook/engine-mirror` → 401 (`broker_request_sent:false`).
- `<COUNTS>` is unchanged.
- At the next candle, the engine (still `6b70cc97c579`, no mirror) heartbeat and ledger check are OK.
- **Owner (needs the passphrase):**
  - the dashboard loads;
  - Settings → Execution costs = "No execution costs";
  - Engine → Strategy Mirror shows "has not reported yet".

**Abort and recovery (B).** Use either command:

```
W versions deploy e941387e-0942-4320-b0dd-454235095c4b@100% --yes --message "rollback to e941387e (pre-mirror)"
W versions deploy 39b41f96-111f-442c-98f3-ccf68699fdeb@100% --yes --message "rollback to fee-compatible c5bb67e"
```

Both run on schema 5 with mirror rows; the funded books stay identical (rehearsed). Without a mirror route, a
mirror-enabled engine keeps its records pending. Nothing is lost. No D1 restore.

---

## Stage C — Engine [APPROVAL C]

**C1. Prepare and verify the immutable release** (from the approved commit; nothing is activated yet):

```
node engine\deploy\release.mjs prepare --repo . --ref <full 40-char SHA> --root R
node engine\deploy\release.mjs install-launcher --repo . --ref <same SHA> --root R
T validate --root R --release <commit12> --expect-profile solusd-5m --expect-risk 10
T selftest --root R --release <commit12>          (one poll with throwaway state; production state untouched)
```

`validate` must show:
- `ok: true` and `state.resumable: true` (the shared state in `S` is resumed, not re-warmed);
- the same `inputsHash` `c826d785d58a4a39`, risk 10, profile `solusd-5m`, sync on;
- `mirror: false` while the config does not yet say `ENGINE_MIRROR=on`.

**C2. Enable the mirror and perform one controlled restart.**
1. Add one line to `R\config\engine.env`: `ENGINE_MIRROR=on`. Change nothing else.
2. `T validate --root R --release <commit12> --expect-profile solusd-5m --expect-risk 10` now shows `mirror: true`,
   `ok: true`, `state.resumable: true`.
3. Right after a candle: `T activate --root R --release <commit12> --expect-profile solusd-5m --expect-risk 10`.
4. Restart the task (its definition is unchanged):
   `schtasks /End /TN "ALPHA TERMINAL Engine"`, confirm with `T status --root R` that the engine stopped, then
   `schtasks /Run /TN "ALPHA TERMINAL Engine"`.

The supervisor verifies the active release before starting it.

(Alternative, if preferred: two restarts. First activate with `ENGINE_MIRROR=off` and confirm the funded track; then
enable the mirror.)

**C3. Verify** (first poll and the next 2 candles):
- `supervisor.log`: active release `<commit12>` verified, risk $10.
- `state-check --dir S`:
  - `candlesProcessed` grew only by the candles that closed while stopped;
  - `warmedUpAt` and `resets` unchanged;
  - signals not fewer, 0 duplicates.
- `S\mirror-SOLUSD-5m.json` exists.
- The audit has exactly one `mirror_created` and one `mirror_activated` (`warmup_candles` ≈ 720).
- Later candles are processed normally; nothing new is sent to `/webhook/dry-run` beyond normal strategy signals.
- Dashboard → Strategy Mirror:
  - health OK, `activated_at` set;
  - the warm-up trades are under **Historical**, none under Live;
  - reconciliation OK.

**Abort and recovery (C).**

| Situation | Action | Data |
|---|---|---|
| `validate` or `selftest` fails | stop before `activate`; remove the config line | unchanged |
| Funded track misbehaves after the restart | `T rollback --root R`, then `schtasks /End` + `/Run`. `6b70cc97c579` starts with a warning ("this release has no Strategy Mirror"), resumes the shared state and ignores the mirror file (rehearsed: funded state byte-identical to a no-upgrade control) | funded state continues |
| Only the mirror misbehaves | set `ENGINE_MIRROR=off`, `schtasks /End` + `/Run`. The funded track is unchanged; the mirror file stays for later | mirror paused |
| Mirror re-enabled later | it resumes from its file; candles it missed are processed late (`catch_up`, disclosed as an observation gap); ids and sequence continue; nothing is recorded twice (rehearsed) | — |

**Never delete `S\mirror-SOLUSD-5m.json`.** A new file would bring a new activation time, which the Worker refuses
for the same account (`ACTIVATION_CONFLICT`).

---

## Stage D — Monitoring [APPROVAL D: duration and reporting]

- **Every few hours, then daily:** mirror health OK, sequence contiguous (`last_contiguous_seq` = `max_seq_seen` =
  the engine's `last_seq`), reconciliation OK, 0 conflicts, no pending backlog.
- **Funded independence:**
  - `<COUNTS>` changes only through normal funded activity;
  - 0 FEE rows;
  - `state-check` shows no unexpected `entry_dropped` beyond normal refusals;
  - the funded state is never reset because of the mirror.
- **First legitimate live hypothetical trade:** confirm on its proof page that:
  - its candles are those of `engine.log`/audit;
  - its prices are the strategy's (limit/stop/TP2);
  - its classification is `live`;
  - the reference price is separate;
  - the journal matches;
  - the funded track's answer for the same signal was its normal one (for example `NO_POSITION` for a short).
- **Coverage:** report actual monitored hours and every observation gap. The PC is off most nights, so those hours
  are catch-up, not live.
- **D1 usage:** `W d1 info alpha-terminal-db --json` daily. Expected: rows written ≲ 6,000/day and rows read ≲ 250,000/day,
  against free quotas of 100,000 and 5,000,000.
- **External parity:** when the owner supplies a TradingView "List of trades" CSV export for a common window, compare it
  trade by trade (`engine/src/cli/compare-tv.mjs`). Until then, external parity is partial (summary plus 5 listed
  trades).

Stop conditions:
- any conflict;
- a sequence gap that does not close;
- reconciliation not OK;
- a funded-track change that the mirror could have caused.

Then set `ENGINE_MIRROR=off` (Stage C recovery) and report.

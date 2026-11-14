# ALPHA TERMINAL: final release and production rollout plan (2026-11-14)

**Status:** nothing in this plan has been executed in production. **Every stage needs the owner's explicit approval**, given separately.

**Evidence:** `docs/diagnosis/PRODUCTION-DIAGNOSIS-2026-11-14.md`.

## Release branch

- **Branch:** `release/alpha-terminal-final`, built from `origin/release/alpha-terminal-integration` (`63068dd`, which already contains `2214664`).
- **Merged in:** `origin/claude/frontend` (`d365cc4`, `6d44342`).
- **Conflicts:** backend and Worker files resolve to the integration side.
- **No force-push; no branch rewritten.**

## Stage 0: engine host (owner action, today)

The engine stops whenever the PC boots without anyone logging on. To fix it, open Task Scheduler and edit the task **ALPHA TERMINAL Engine**:

1. **General:** select "Run whether user is logged on or not". Windows asks for your password; you type it. I never see or store it.
2. **Triggers:** add **"At startup"**. Keep the logon trigger.
3. **Conditions:** untick "Start the task only if the computer is on AC power".

Also set Power & sleep to **Never sleep** while the engine is the only host.

- **Check:** reboot and *don't* log on. A minute later, `engine.log` shows new candles.
- **Duplicate protection:** the supervisor lock prevents a second instance.

## Stage 1: compatible Worker and frontend

- **What:** Worker and frontend from the release branch.
- **Schema:** schema 6 stays. No migration.
- **Engine:** no change.
- **Pre-checks:**
  - `npm test` in `engine/`, `worker/` and `frontend/`;
  - `worker/tools/schema6-compat.mjs` must pass 11/11.
- **Delivers:**
  - the new UI, trade cards, charts and the assistant;
  - the fix for the misleading "ENGINE NOT RUNNING" label, which reflected the Alpaca broker route's kill switch;
  - bot-ledger features shown as "not installed".
- **Rollback:** `wrangler rollback 1b51170c-4f9d-41c0-8284-fa8ab61eac81`.

## Stage 2: migration rehearsal (private)

1. Export production D1 to a **private local file**. This needs approval; the export holds trade history and is never committed.
2. Apply migration `0007_bots.sql` to the copy.
3. Verify: row counts are identical; every `trade_events` row is preserved; `PRAGMA foreign_key_check` is clean.
4. Run the Stage 1 Worker against the migrated copy.

## Stage 3: production migration 0007

1. A time-travel bookmark is taken first (`wrangler d1 time-travel info`).
2. Apply migration 0007. It is additive except for one lossless `trade_events` rebuild.
3. **Rollback:** restore D1 to the bookmark. This needs a separate decision, because it also discards any later writes.

## Stage 4: engine release (fleet runner, explicit actions, plan recording)

- **What:** the engine is pinned by commit and SHA-256 checksums, installed side by side under `engine-prod\releases\`, and switched by the supervisor's `current` pointer.
- **Rollback:** point `current` back to `af924ffa4703`.

**Stage S1: ALPHA-02 on the bot ledger.**
- Real PAPER LONG and SHORT orders.
- SHORTs are fully collateralised, simulated in the internal ledger. **The broker is never shorted.**
- Explicit OPEN_LONG / OPEN_SHORT / CLOSE actions.
- Reduce-to-fit shows requested vs actual quantity and risk.
- The legacy path is disabled for ALPHA-02 in the same step, so there is never a duplicate route.

## Stage 5: fleet activation (owner, one bot at a time)

- The owner allocates capital to each bot wallet.
- ALPHA-01, ALPHA-03 and ALPHA-04 are activated one at a time.
- No capital transfer happens without the owner's instruction.

## Not included (stated, not hidden)

- Partial exits: the Pine strategy has none.
- Moving the engine to an always-on host: separate approval.
- Real-money execution: never.

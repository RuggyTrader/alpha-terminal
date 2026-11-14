# ALPHA TERMINAL: production rollout (prepared 2026-11-14)

**Nothing below has been executed in production. Every stage needs its own explicit owner approval.**

**References:**
- Branch: `release/alpha-terminal-final`.
- Evidence: `docs/diagnosis/PRODUCTION-DIAGNOSIS-2026-11-14.md` and `docs/recovery/RECOVERY-REPORT-2026-11-14.md`.

**Production today:**

| Component | Version |
|---|---|
| Worker | `1b51170c` (commit `af924ff`) |
| D1 schema | 6 |
| Engine | release `af924ffa4703`, single bot ALPHA-02, legacy long-only ledger |

## Windows engine host (MATT_PC)

**Observed 14 Nov 2026, about 23:20 UTC (read-only):** the task **ALPHA TERMINAL Engine** was re-registered on **14 Nov at 17:54 local**. I did not make this change; please confirm it was yours. It now has:

| Setting | Value | Meets the requirement |
|---|---|---|
| Triggers | **At startup** (30 s delay) **and** at log on | starts when Windows starts |
| Security option | `S4U`: "Run whether user is logged on or not", no stored password | runs without a logon |
| Program | `C:\WINDOWS\System32\conhost.exe` | correct executable |
| Arguments | `--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File <engine-prod>\bin\run-release.ps1 -Root <engine-prod> -Node "C:\Program Files\nodejs\node.exe"` | correct |
| Start in | `%USERPROFILE%\AlphaTerminal\engine-prod` | correct working directory |
| Environment | read by the engine from `engine-prod\config\engine.env`; the task holds no secret | correct |
| Restart on failure | every 1 min, up to 999 times; no time limit; start when available | recovers from a process failure |
| Multiple instances | Parallel, made safe by a supervisor named mutex and the engine lock file in `engine-state` | one engine only (duplicates exit, logged "another supervisor already runs the engine … this one exits") |
| Power | the host is a **desktop** (no battery), so there are no battery safeguards to preserve | — |

**What the engine does after any restart (already in the engine):**
- **State:** reloads its saved state (`engine-state\state-*.json`, written atomically after every step). It is never reset.
- **Catch-up:** catches up on missed candles from Kraken.
- **Stale entries:** never sends an entry or a new pending order more than 2 candles late (`SIGNAL_EXPIRED`). Exits are always delivered.
- **Retries:** re-sends undelivered items with the same ids. The ledger answers `DUPLICATE`, so nothing executes twice.
- **Reconciliation:** compares its position and live pending order with the PAPER ledger after every poll (`ledger_check`).
- **Heartbeat:** reports a heartbeat with its last completed candle every poll.

**Owner steps:**
1. **Confirm** that the 17:54 change was yours.
2. **Verify startup without a logon.** Restart the PC and do **not** sign in. After 5 minutes, check on your phone:
   - **Today (before Stage A):** the old site's "last candle" age.
   - **After Stage A:** **Home → Strategy engine** shows *Online — scanning* (or *Pending order* / *Position open*), with a last candle under 10 minutes old.

   Then sign in and check:
   - the last lines of `%USERPROFILE%\AlphaTerminal\engine-prod\logs\supervisor.log`: a `started … active release … verified` line from the boot time;
   - the last lines of `engine.log`: `processed 1 candle(s)` lines resuming within minutes of boot.
3. **Keep the PC on and awake:** Settings → System → Power → Screen and sleep → **"When plugged in, put my device to sleep after: Never"**.
   - **The engine cannot run while this PC is off, asleep or restarting.** No trades happen in that time.
   - On the next start it catches up, but entries that are too late are not sent.
   - Moving the engine to an always-on host is a separate decision that needs your approval.
4. **Do not re-apply** `engine-prod\task\original.xml` or `pinned.xml`. Both predate the startup change, and applying either would remove the startup trigger. `release.mjs task-xml` now refuses to write a definition that drops it.

## Stage A: compatible website and Worker (no migration, no engine change)

**Pre-checks (local):**
```
npm --prefix frontend test -- --run
npm --prefix frontend run build
npm --prefix engine test
npm --prefix worker test
node worker/tools/schema6-compat.mjs
```

**Deploy (owner approval):** from `worker/`, run `npx wrangler deploy`. This serves `frontend/dist`.

**Verify in production:**
- `/` loads the new bundle hash, recorded at build.
- **Home → Strategy engine** shows ALPHA-02's real heartbeat state, not the Alpaca route.
- Trade #1 is still listed under **Trades → Completed** and in **Results**.
- `/api/dashboard/bot-orders` answers `installed: false`.
- **Settings** has the six sections.

**Rollback:**
```
npx wrangler rollback 1b51170c-4f9d-41c0-8284-fa8ab61eac81
```

**What changes on schema 6:**
- The engine-status fix.
- The new navigation and the six-section Settings.
- Research moved out of the main pages.
- Trade cards, charts and refusals.

Bot-ledger features stay inert and are labelled. **No SHORT can execute yet: ALPHA-02 is still on the legacy long-only ledger.**

## Stage B: schema 7 (migration 0007)

**B1: rehearsal.**
- **Done locally** on a representative fixture: `node worker/tools/migration-rehearsal.mjs`, **31 of 31 checks pass** (`docs/recovery/migration-rehearsal-2026-11-14.json`).
- **Optional, recommended, needs owner approval:** the same steps on a **private copy** of production:
  ```
  npx wrangler d1 export alpha-terminal-db --remote --output "%USERPROFILE%\AlphaTerminal\private\d1-2026-11-xx.sql"
  ```
  Keep the export **outside the repository**. It contains trade history and is never committed. Import it into a local D1 with `wrangler d1 execute --local --file`, apply `0007_bots.sql`, and repeat the rehearsal's integrity checks.

**B2: backup point (owner approval).**
```
npx wrangler d1 time-travel info alpha-terminal-db
```
Record the bookmark it prints.

**B3: apply (owner approval).**
```
npx wrangler d1 migrations apply alpha-terminal-db --remote
```
Production has `0001`–`0006` recorded, so this applies only `0007`.

**B4: verify.**
- `SELECT value FROM app_meta WHERE key='schema_version'` returns `7`.
- Row counts of `trades`, `alerts`, `paper_fills`, `trade_events` and `portfolio_entries` are unchanged.
- Trade #1 and all 22 `trade_events` rows are still served.
- `/api/dashboard/bot-orders` returns `installed: true`.

**Rollback:**
```
npx wrangler d1 time-travel restore alpha-terminal-db --bookmark <B2 bookmark>
```
This is a separate decision: it discards anything written after the bookmark. The Stage A Worker works on schema 6 and 7.

## Stage C: pinned engine release, and ALPHA-02 to the bot ledger (LONG + SHORT)

**C1: prepare and verify (approval).**
```
node engine/deploy/release.mjs prepare --repo <checkout> --ref <final commit> --root %USERPROFILE%\AlphaTerminal\engine-prod
node engine/deploy/release.mjs selftest --root ... --release <id>
```
This writes a SHA-256 manifest. Nothing is started.

**C2: switch ALPHA-02 (S1, approval). Only while ALPHA-02 is flat.**
1. In the app: **Bots → ALPHA 02 → Settings → passphrase → "Move to the bot ledger (LONG + SHORT)"**. This calls `POST /api/paper/bot-ledger`. It is refused while a legacy position is open. From then on the legacy route refuses ALPHA-02 (`BOT_LEDGER_PATH`), so there is never a second route.
2. In `engine-prod\config\engine.env`, add:
   ```
   ENGINE_BOTS=ALPHA-02
   ENGINE_LEDGER_ALPHA_02=bot
   ```
   ALPHA-02 keeps its profile (`c826d785d58a4a39`), its ids, its state and its SOLUSD wallet. Its sizing becomes dollar risk, $10 by default, with simulated, fully collateralised SHORTs.
3. Activate and restart:
   ```
   node engine/deploy/release.mjs activate --root ... --release <id> --expect-profile solusd-5m
   ```
   Then **restart the PC**, which also proves the startup trigger. Activation only takes effect at the next engine start, and the supervisor mutex and the engine lock keep it to **one engine only**. Do not start a second engine by hand.

**C3: verify.**
- Startup without a logon (as above).
- Fresh candles processed.
- `ledger_check: OK`.
- The next setup appears as a durable **pending order** (Trades → Pending), with its chart levels and shading.
- A SHORT setup is placed as `PLACE_LIMIT` SHORT instead of being refused `SHORT_NOT_ALLOWED`.

**Rollback:**
1. `node engine/deploy/release.mjs rollback --root ...`
2. Remove the two engine settings.
3. Note that the Worker switch is one-way. To return ALPHA-02 to the legacy route, set `bots.ledger_api='legacy'` while it is flat, as a separate owner decision.

## Stage D: further bots (one at a time, owner approval each)

For each of ALPHA-01 (SOL 1m), ALPHA-03 (BTC 1m) and ALPHA-04 (BTC 5m):
1. **Activate:** set `bots.status='ACTIVE'` for that bot only.
2. **Allocate** from MAIN on **Bots → Allocate**. The owner chooses the amount; it is split equally within the group.
3. Add the bot to `ENGINE_BOTS` and restart the engine.
4. **Verify:**
   - its heartbeat;
   - its profile hash (ALPHA-01 `0932a1a0cfac03f9`, ALPHA-03 `d828caa44611ad73`, ALPHA-04 `a6336dad6ffaed70`);
   - its destination is the bot ledger;
   - its dollar risk.

## Stage E: acceptance on the iPhone

- Confirm Home, Bots, Trades, Activity, Results and Settings, and the charts, on the owner's iPhone.
- Observe genuine scanning, then the first genuine pending → filled → closed lifecycle.
- Compare the result on the Trades and Results pages with the proof page.

## Approvals required (in order)

1. Stage A deploy.
2. Private D1 export (optional).
3. Stage B migration.
4. Stage C engine release and the ALPHA-02 ledger switch.
5. Each Stage D bot activation and its capital allocation.
6. Any engine-host move.

**Never:** real-money execution, use of the Alpaca route by the strategies, or changes to the strategy profiles or fee model.

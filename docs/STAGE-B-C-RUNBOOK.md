# Stage B (schema 7) and Stage C (ALPHA-02 LONG + SHORT): exact runbook (prepared 2026-11-15)

**Production today:**

| Component | Version |
|---|---|
| Worker | `f8e31d52-39a1-4ed5-af4d-a9ba15371ee3` (Stage A, commit `a28b0e0`) |
| D1 schema | 6 |
| Engine | release `af924ffa4703`, ALPHA-02 only, legacy long-only ledger |

**Source for B and C:** commit **`0a1bc32951f01dd2138f3090b92a36c743f7a0dc`** on `release/alpha-terminal-final`.
- The Worker, frontend and engine code are identical to the deployed `a28b0e0`.
- Only migration 0007 is fixed (see B0), plus its regression test and the rehearsal tooling.

Each stage needs its own approval. **Nothing here has been run in production.**

## B0. What the private production-copy rehearsal found (owner-approved export)

**The export:** `wrangler d1 export --remote`, taken 2026-11-15 06:13 UTC. It is stored outside the repository at `%USERPROFILE%\AlphaTerminal\private\`.
- It contains session records.
- **Keep it private.** Delete it after Stage B if you wish.

**First run: 0007 as originally written FAILED on the real data.**
- **Cause:** D1 enforces foreign keys. Production has 18 `push_deliveries` rows pointing at `trade_events`, and 0007 rebuilds `trade_events`.
- **The earlier fixture rehearsals had no delivery rows**, so they could not catch it.
- **Fix:** the deliveries are set aside and restored unchanged (same ids and values) around the rebuild.
- **Regression test:** foreign keys ON with 18 deliveries. It fails without the fix.

**Second run, with the fix: 44 / 44 checks pass** (`docs/recovery/private-rehearsal-2026-11-15.json`). The rehearsal used the deployed Worker build.

| Area | Result |
|---|---|
| Migration ledger | Exactly one pending migration (`0007_bots.sql`); 0001–0006 recorded |
| Records | Every row and value of every table **unchanged** (pre-existing columns) |
| Row counts | 20 activity events, 18 alerts, 6 orders, 16 risk decisions, 2 fills, 1 trade, 6 wallets, 6 portfolio entries, 22 trade events, 18 push deliveries, 2 push subscriptions, Mirror rows, settings |
| `app_meta` | Unchanged except `schema_version`, which moves 6 → 7 |
| Integrity | FK check clean; schema 7 |
| Bots | ALPHA-01 `0932a1a0cfac03f9`, ALPHA-02 `c826d785d58a4a39` (ACTIVE, legacy, SOLUSD wallet), ALPHA-03 `d828caa44611ad73`, ALPHA-04 `a6336dad6ffaed70` |
| New wallets | Empty: no capital created |
| New tables | Durable pending orders and the one-PENDING-per-bot index created |
| Worker answers | Trade list, lifetime performance, account totals and signal counts **identical** before and after; trade #1 and every refusal still served |
| On the copy only | ALPHA-02 switched while flat; the legacy route then refuses it (`BOT_LEDGER_PATH`) |
| SHORT on the copy | Requested 33.3 SOL ($10 risk), accepted 0.14212034 (fits the $9.97 wallet), filled at limit 70.00, closed at target 69.40: gross +$0.085272, fees $0.039623, net +$0.045649, swept to MAIN |
| LONG on the copy | Limit 69.50 → stop 69.20: gross −$0.042943, fees $0.039708, net −$0.082651 |
| Reconciliation | SOLUSD wallet 9.968321 → 9.885670 = before + Σnet − Σswept; MAIN 90.000000 → 90.045649 = before + Σswept; nothing reserved; 4 fills, one fee each |

The copy is deleted after each run, and production was not contacted after the export.

## B. Production migration (approval: "Stage B")

1. **Check conditions** (I can check these read-only):
   - ALPHA-02 has no open position (`paper_positions` OPEN = 0);
   - the engine heartbeat is under 10 minutes old;
   - 0007 is the only pending migration.
2. **Window:** start just after a 5-minute heartbeat, e.g. at `hh:m1`–`hh:m3`.
   - The engine is the only background writer (the Worker has no scheduled jobs). D1 applies the file as one transaction, so a concurrent heartbeat lands before or after it.
   - The engine does **not** need to stop for Stage B. The deployed Worker serves both schema 6 and 7.
3. **Backup point:**
   ```
   npx wrangler d1 time-travel info alpha-terminal-db
   ```
   Record the bookmark printed.
4. **Apply**, from a clean checkout of `0a1bc32…`, in `worker/`:
   ```
   npx wrangler d1 migrations list alpha-terminal-db --remote
   ```
   This must show only `0007_bots.sql`. Then:
   ```
   npx wrangler d1 migrations apply alpha-terminal-db --remote
   ```
5. **Verify:**
   - `schema_version` = 7;
   - the same row counts as before the migration, plus any genuine new engine records;
   - trade #1 unchanged;
   - FK check clean;
   - the bots table and hashes as above;
   - `/api/dashboard/bot-orders` returns `installed: true`;
   - **Bots** shows SOLANA (ALPHA-01 proposed, ALPHA-02 active) and BITCOIN (ALPHA-03 and ALPHA-04 proposed);
   - the legacy engine's next heartbeat is accepted.
6. **Rollback:** the Worker needs none. A database restore to the bookmark is a **separate decision**, because it discards anything written after the bookmark; it is never a routine step.

## C. ALPHA-02 to the bot ledger: LONG and SHORT (approval: "Stage C")

**Prepared and verified on 2026-11-15** (nothing activated):
- Release **`0a1bc32951f0`** prepared in `engine-prod\releases\`: 25 files with a SHA-256 manifest.
- `validate`: OK. Profile `solusd-5m`, hash `c826d785d58a4a39`; the existing state is resumable (last candle 06:10 UTC, 2506 candles).
- `selftest`: OK, with sync off and a temporary folder. 720 real Kraken candles processed.
- Fleet + bot-ledger mode on a **copy** of the production state (`ENGINE_BOTS=ALPHA-02`, `ENGINE_LEDGER_ALPHA_02=bot`, sync off):
  - starts with dollar sizing $10, simulated SHORT enabled, 0.20% fee;
  - resumes the same state files (`state-SOLUSD-5m.json`, `mirror-SOLUSD-5m.json`) without a warm-up.
- The active release is still `af924ffa4703`.

**Cutover. One engine and one route at all times. The old engine is stopped before the route switches.**

1. **Conditions:**
   - Stage B is verified;
   - ALPHA-02 has no open position (Worker ledger, and engine `position: null`);
   - the engine status is *not* "ORDER PLACED – waiting fill". If it is, wait until the strategy cancels the order or it fills and later closes; a pending order never moves across the switch.
2. **Stop the old engine.** In Task Scheduler, right-click *ALPHA TERMINAL Engine* → **End**. Then I confirm that no `node … src\cli\run.mjs` and no `run-release.ps1` supervisor process remains, and stop any leftover by its pid. Nothing can submit an order from here on.
3. **Back up the engine state:** copy `%USERPROFILE%\AlphaTerminal\engine-state` to `engine-state-backup-<UTC time>`. The original stays in place and is never reset.
4. **Switch the Worker route.** In the app: **Bots → ALPHA 02 → Settings → passphrase → "Move to the bot ledger (LONG + SHORT)"**.
   - It is refused if a legacy position is open.
   - From then on the legacy route refuses ALPHA-02.
5. **Engine configuration.** Append to `engine-prod\config\engine.env` (existing lines untouched; no secret is read or printed):
   ```
   ENGINE_BOTS=ALPHA-02
   ENGINE_LEDGER_ALPHA_02=bot
   ```
6. **Activate the pinned release:**
   ```
   node <checkout>\engine\deploy\release.mjs activate --root %USERPROFILE%\AlphaTerminal\engine-prod --release 0a1bc32951f0 --expect-profile solusd-5m
   ```
   Optionally also run `install-launcher` (same ref), so `bin\release.mjs` carries the startup-trigger guard.
7. **Start.** In Task Scheduler: right-click → **Run**. This is the first launch under the saved **S4U** setting ("run whether logged on or not"), so it also tests that setting short of a reboot.
8. **Verify:**
   - exactly one engine process;
   - `supervisor.log` shows the release `0a1bc32951f0` verified;
   - `engine.log` shows `[fleet] … ALPHA-02` and new candles;
   - D1 heartbeat `engine_status:ALPHA-02` is fresh, with `ledger_check: OK`;
   - the website shows **Strategy engine: ALPHA 02 — Online — scanning**;
   - the next setup appears as a durable pending order (Trades → Pending; the chart shows its levels).

   SHORT setups are no longer refused `SHORT_NOT_ALLOWED`.
9. **Later, with you present:** restart the PC **without signing in** to complete the startup-without-logon test.

**Rollback (separate decision):**
1. Stop the engine as in step 2.
2. Run `release.mjs rollback --root …` (back to `af924ffa4703`).
3. Remove the two configuration lines.
4. While ALPHA-02 is flat, set `bots.ledger_api='legacy'` for ALPHA-02 (owner-approved SQL).
5. Start the engine.

**What does NOT change:**
- the strategy profile and Pine logic (flat-only entries; no new signals);
- no other bot is activated;
- no capital is moved;
- no real money and no Alpaca.

## Sizing and fees after the switch: please confirm before Stage C

| | Today (legacy ledger) | After the switch (bot ledger) |
|---|---|---|
| Direction | LONG only; SHORT setups refused | LONG and SHORT. A SHORT posts 100% collateral from ALPHA-02's own wallet; no borrowing, no margin |
| Sizing | 1% of equity, at most $10 risk, capped by buying power | **$10 dollar risk** per trade: quantity = $10 ÷ stop distance, then **reduced to fit** the wallet. Refused only if even 0.05 SOL / $0.50 is unaffordable |
| Wallet | SOLUSD wallet, $9.968321 | The same SOLUSD wallet (ALPHA-02's own) |
| Fees | None (cost profile `none`) | **Ndax-equivalent 0.20% of notional on every fill** (entry and exit), charged to ALPHA-02's wallet |
| Profit | Stays in the strategy wallet | Positive net profit of each trade is **swept to MAIN** at the close; losses stay in ALPHA-02's wallet |
| Fill price | Kraken reference price when the signal arrives | **Simulated limit fill** on the completed Kraken candle: never worse than the limit; no exchange queue or partial fill modelled |

**Practical effect at today's capital:**
- With $9.97, every position is capped by capital at about 0.14 SOL, not by the $10 risk.
- Real risk per trade is a few cents.
- Round-trip fees are about $0.04, comparable to a typical win. The rehearsal SHORT made +$0.085 gross and +$0.046 net.
- To let the $10 risk rule take effect, ALPHA-02 needs more allocated capital. **That is a separate owner decision. Nothing is moved without it.**

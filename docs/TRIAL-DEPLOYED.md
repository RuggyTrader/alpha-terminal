# BTC trend forward trial: production deployment record (2026-11-16)

## What was deployed

| Item | Value |
|---|---|
| Source commit | `951e561e6f4cdafa0da2a101d1b833415c735f10` (branch `feature/btc-trend-trial`, merged into `release/alpha-terminal-final`) |
| Worker version | `60bbcf3c-4f64-4d58-b6cc-a999e2c3a749`, 100%, 02:00:51 UTC |
| Website bundle | `index-DkNcVxAF.js` |
| Schedule | `* * * * *`, registered with `wrangler triggers deploy` at 02:00:51 UTC |
| Migration | `0008_trial.sql`, applied 02:00:21 UTC (10 statements) |
| Engine | unchanged (release `02b37590a8d8`, four bots) |

## Before deployment

**Regression:** complete suites on a clean checkout of `951e561`, run in isolation:
- Worker 352/352;
- engine 274/274;
- website 233/233.

**The seven earlier failures:**
- **Cause:** orphaned local test servers (from an interrupted earlier suite run) still held test ports 8821, 8822 and 8837. The tests talked to those stale servers, which had a different random passphrase. Login returned 401, so the bots had no capital and never traded.
- **Not a code defect:** the previously passing commit `d22850d` failed identically after the stop.
- **Fix:** every Worker test now refuses to run against a server it did not start (`worker/test/lib/port-guard.mjs`). No assertion was weakened.
- **Re-checked:** the affected files passed 3 times out of 3, and the full suite passed.

**Database checks:**
- Binding: `DB` → `alpha-terminal-db` (`40741873-0a98-4b23-b4e2-19ac8acec80c`).
- Migration status: only `0008_trial.sql` pending.

**Backup:**
- Private export `C:\Users\hujhj\AlphaTerminal\backups\d1-prod-before-0008-20261116T003938Z.sql` (outside git).
- Restore bookmark immediately before the migration: `0000004c-000020ee-00005125-890ea3c59ebd829caf0f593d0638c1b4`.

**Export quirk:** the export cannot be replayed as-is. Since migration 0007, `push_deliveries` rows (which reference `trade_events`) come before the `trade_events` table. A reordered copy (`.restore.sql`, identical statements) loads correctly.

**Rehearsal** on that production copy with `wrangler d1 migrations apply`: **PASS**.
- Only `0008` was applied.
- All existing table and index definitions and every row's content hash were unchanged.
- 8 `trial_*` objects were added.

## After deployment (verified in production)

**Portfolio unchanged:**

| Figure | Before | After |
|---|---|---|
| Funding | $100.000000 | $100.000000 |
| Book (cash + positions) | $99.646918 | $99.646918 |
| Legacy trades | 1 | 1 |
| Bot positions | 4 | 4 |
| Bot orders | 8 | 8 |
| Pending-order rows | 21 | 21 |
| Portfolio entries | 34 | 34 |
| Tables | 33 | 39 (+6 `trial_*`) |
| Bots | all four ACTIVE, original settings hashes | unchanged |

**Trial account:** `TRIAL-BTC-MA50`, **PROPOSED (inactive)**, $100.000000, frozen settings stored. No events and no orders.

**Scheduled runs observed live** (`wrangler tail`):

| Time (UTC) | Outcome | CPU | Wall time |
|---|---|---|---|
| 02:08:04 | ok | 3 ms | 483 ms |
| 02:09:04 | ok | 1 ms | 212 ms |
| 02:10:04 | ok | 1 ms | 203 ms |

There were no exceptions. The schedule started about 7 minutes after registration.

**Bots:** fresh heartbeats with ledger checks OK. All 104 requests in the captured windows were OK.

## Usage and free-plan limits

**Limits** (Cloudflare documentation, 15–16 Nov 2026):
- **Workers Free:** 100,000 requests per day, 10 ms CPU per invocation, 50 D1 queries per invocation, 5 cron triggers per account.
- **D1 Free:** 5,000,000 rows read and 100,000 rows written per day.

| Measure | Measured | Limit |
|---|---|---|
| Worker requests from the four bots | about 20 per minute ≈ 28,800 per day | 100,000 per day (with the schedule, about 30,200 per day; the documentation does not say whether scheduled runs count) |
| Scheduled invocations | 1,440 per day | — |
| CPU per scheduled run (idle trial) | 1–3 ms | 10 ms |
| CPU per bot request | median 10 ms, 95th percentile 19 ms, max 23 ms; **all completed OK** | 10 ms |
| D1 queries per run | idle 2 reads; in a position about 9 per daily close; catch-up limited to 3 closes per run | 50 |
| D1 rows (24 h) | 781,622 read, 8,692 written | 5M / 100K |
| Market data | trial idle: 0 requests; active: ≤ 1 Kraken request per minute while a position or order needs watching, otherwise 1 per day | — |
| Failed requests in the captures | 0 | — |

**CPU over the published limit:** existing bot requests sometimes use more than the published 10 ms (up to 23 ms) and still complete. If Cloudflare enforced 10 ms strictly, some of them would fail (error 1102). This predates the trial; to be watched.

**Isolation:**
- Scheduled runs are separate invocations from bot requests. A trial error cannot fail a bot request.
- The trial's database load is a small fraction of the total.
- No paid service was added.

## Owner activation (one time)

1. Open the website → **Results**.
2. Find the panel **"Forward trial · BTC 50-day trend"** (a separate research account; not part of your portfolio).
3. Enter your passphrase in that panel and press **Start the trial**.

After that the trial runs every minute in Cloudflare without the PC. Its first decision is at the next daily close (00:00 UTC).

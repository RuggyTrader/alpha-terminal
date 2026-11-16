# Worker CPU on the free plan: measurement and candidate fix (2026-11-16)

## Measurement (production, version `17bdb611`, read-only)

**Method:** `wrangler tail --format json` for 5.3 minutes, 2026-11-16 03:20–03:25 UTC. The log gives Cloudflare's own `cpuTime` and `wallTime` for each invocation.

| Request type | n | CPU p50 / p95 / max (ms) | Wall p50 / p95 / max (ms) | Over 10 ms CPU | Outcome |
|---|---|---|---|---|---|
| `POST /webhook/bot-ledger` | 52 | 3 / 5 / 7 | 177 / 217 / 326 | 0 | all ok |
| `POST /webhook/engine-status` | 51 | 8 / 13 / 15 | 470 / 608 / 636 | 10 | all ok |
| `POST /webhook/engine-mirror` | 16 | 8 / 15 / 15 | 470 / 669 / 669 | 6 | all ok |
| scheduled (trial, every minute) | 6 | 2 / 4 / 4 | 330 / 911 / 911 | 0 | all ok |

## What this shows

1. **It is genuine CPU, not wall time.**
   - Wall time (170–900 ms) is almost entirely waiting for D1, and waiting does not count as CPU.
   - The 10 ms limit applies to `cpuTime`. Heartbeat and mirror requests exceed it in about one call in four.
2. **Cloudflare did not terminate any request.** All 125 outcomes were `ok`, and the earlier 24-hour sample (max 23 ms) had no errors either. Cloudflare does not document how much over 10 ms it tolerates. Relying on that tolerance is a risk, not a guarantee.
3. **Request bodies are not the cause.** Bodies are 131 B – 2.8 KB, and CPU does not grow with size.
4. **The cause is `processEvents`.**
   - Only `engine-status` and `engine-mirror` (and the legacy dry-run webhook) call `afterwards()`, which runs `processEvents` (trade-event sync and push delivery) in `waitUntil` **on every call**.
   - The work done in `waitUntil` counts in the invocation's CPU.
   - Each run issues about 12–20 D1 statements, even when nothing is new. One of them is a relabelling `UPDATE` over the latest 200 trade events, in a batch that runs every time.
   - With about 14 such requests per minute, this is also most of the measured ~836k D1 rows read per day.
   - `bot-ledger`, which does not call it, stays at 3 ms.

## Candidate fix (branch `candidate/events-precheck`; not deployed)

**`eventWorkPending()`: one read-only query before `processEvents`.** It answers "would the sync or the delivery change anything?":
- a source table (paper fills, mirror opens / closes, bot fills) is ahead of its cursor;
- a mirror event awaits its bot label;
- with push configured and a device enabled:
  - an event is not yet planned;
  - the planning cursor is missing;
  - a delivery is pending or being sent.

**When the answer is no,** the full routine would only read and write nothing, so it is skipped. **Otherwise, or if the check itself fails,** the full routine runs exactly as before.

**Unchanged:**
- trading logic, the ledger, fills, positions, strict fill timing and the trial;
- notification timing;
- the routine itself when there is work.

**Evidence** (`worker/test/events_push.test.mjs`, 4 new tests):
- The new and previous routines run side by side on identical databases through 18 steps: device enabled, funded round trip, mirror entry and close, bot entry and exit, bot relabel, push failure with pending retry, device disabled, and idle periods.
  - The tables are identical after every step.
  - Each skipped run costs a single query.
- Interrupted sends (`sending`), a missing planning cursor and a failing check all run the full routine.
- Mutation check: four deliberate defects in the check (never work / always work / a wrong source / ignoring `sending`) are each caught.

**Expected effect:** heartbeat and mirror requests drop to about `bot-ledger`'s cost (3–7 ms) whenever no event is pending, and D1 reads fall by most of the event-sync share. Not yet measured in production.

**Deployment:** needs the owner's approval. It can go out with the strict-fill enforcement deploy (rollout step 5), measured again with the same tail method before and after.

## Production result (deployed 2026-11-16T18:27:31Z, version `8f628303`, commit `228e6da`)

**Method:** `wrangler tail`, measuring Cloudflare's `cpuTime` (not wall time).
- **Before:** version `f50e897a`, 06:19–06:28 UTC, 260 invocations.
- **After:** version `8f628303`, 18:27–18:37 UTC, 224 invocations.
- The first 90 s after each deploy are excluded from the warm figures.

| Heartbeat + mirror requests | Before | After |
|---|---|---|
| Requests (warm) | 79 | 100 |
| CPU median / p95 | 7 / 11 ms | **4 / 7 ms** |
| Over 10 ms CPU | 5 (6.3%) | **2 (2%)** |
| Wall median | 509 ms | **209 ms** |
| Sync skipped (wall < 260 ms proxy) | 0 of 100 | **100 of 117** |
| Terminated | 0 | 0 |

**Remaining requests over 10 ms after the deploy:**
- 3 in the first 25 s (fresh isolates);
- one heartbeat at 26 ms (wall 943 ms) and one at 18 ms, consistent with a real sync or cold isolate;
- `bot-ledger`: 2 at 11–12 ms.

**D1 statements avoided:** about 12–20 per skipped request, so roughly 1,200–2,000 per 10 minutes at the observed rate. This is an estimate from the proxy, not a direct statement count.

**Remaining bottleneck (not addressed in this release):**
- Dashboard reads while the app is open: `GET /api/dashboard` (12 / 19 ms median / p95, 15 of 19 over 10 ms) and `GET /api/dashboard/bots` (13 / 14 ms, 12 of 12 over 10 ms), in the before sample.
- Nobody had the app open during the after sample, so these were not re-measured.

# Autonomous development report (session of 2026-11-16, 19:54 → 20:20 UTC)

Evidence-based record of what was done.

- **"Deployed"** means read back from production.
- **"Candidate"** means tested on a branch, not deployed.
- **Everything is PAPER-only.**

## 1. Verified production state (read back 20:16–20:17 UTC)

| Item | Value |
|---|---|
| Worker | **`00da3a6c-6d1b-440f-b8bd-7a211f36ebc3`** (deployed 20:16:49 UTC, commit `2674412`); previous `8f628303-cce1-4554-833d-e0fed581105e` |
| Engine release | `b17cce0b46d8` (unchanged this session); scheduled task Running |
| Frontend asset | `index-DHL-7AfT.js` (unchanged command center) |
| Strict fill | engine on; Worker enforcement **off** |

**Bot states:**

| Bot | State |
|---|---|
| SOL Flare (ALPHA-01) | engine pause ON; Worker pause **OFF** (needs the owner's passphrase) |
| BTC Hash (ALPHA-03) | engine pause ON; Worker pause **OFF** (needs the owner's passphrase) |
| SOL Orbit (ALPHA-02) | trading (PAPER) |
| BTC Atlas (ALPHA-04) | trading (PAPER) |

**Ledger (authoritative, read-only):**
- Funding is exactly $100.000.
- Equity is $99.4505 and realized net is −$0.5495.
- No open position.
- One pending order (BTC Atlas), matching the engine.
- Fills are unique.

## 2. Completed work

| # | Workstream | Result | Where | Deployed? |
|---|---|---|---|---|
| 1 | Pause verification | Engine pause active; paused bots sent **no** order since 19:06:30; their two accepted orders were cancelled with a recorded reason; no unprotected position; SOL Orbit / BTC Atlas unaffected | production read-only | — |
| 1b | **Health and pause-agreement monitor** `tools/ops/health.mjs` | Per bot it reports separately: engine running, connected, data fresh, ledger synced, entries (engine / Worker), exits managed. It also flags pause disagreement and order or position mismatch. Reads only 3 non-secret keys from `engine.env` | `mission/2026-11-16` `2a3a124` | tool (runs locally) |
| 2 | **Research round 7** (5 new families, 38 configurations, untouched markets) | Nothing passes. **T1 LONG** (Donchian 55/20, 4h) and **M1 LONG** (30-day momentum) are **INCONCLUSIVE**: positive in development, validation and 8 untouched markets, and at 0.40% + 0.10%, but concentrated in a few trends. Breadth and 99.5% CI fail; T1's drawdowns are too large. Mean reversion, squeeze and every SHORT FAILED | `research/round4` `255a351` (pre-registration) → `e35e44a` | research only |
| 2b | **Tested research backtester** | Next-open fills, stop-first ambiguity, gap fills, fees on every fill, no lookahead, capped sizing, Kraken minimums | `engine/src/research/r7/`, 8 tests | — |
| 3 | **Candidate registry** | 23 candidates (rounds 1–7). Fixed statuses with no "proven"; comparison ordered by evidence. **0 ELIGIBLE, 3 INCONCLUSIVE, 20 FAILED** | `docs/research/registry/` `175cd66`, 3 tests | — |
| 4 | **Engine fault-injection suite** (9 scenarios) | **Found a defect in the deployed engine** (§4). Fix prepared | `mission/2026-11-16` `6a30602` | **candidate (needs authorization)** |
| 5a | **`/api/dashboard/bots`: fixed 12 statements** (1 + one D1 batch) instead of ~9 per bot | Equivalence test proves identical output, and catches order and funding mutations; 12 statements whatever the bot count | `2674412` | **DEPLOYED** (`00da3a6c`) |
| 5b | **Activity history index** (migration 0009) | Older page: ~N/2 rows + sort → 30 rows (local model at 5k / 20k / 100k events). Additive-only test | `candidate/activity-index` `907230c` | candidate (not needed until ~5k events) |
| 6 | **Assistant** | New answers: which bots are paused (both layers), reliability (status + ledger reconciliation + issues), fee drag (profitable before fees), research summary (labelled historical, cites reports), data freshness. The dashboard also shows an engine-paused bot as PAUSED (needs the Worker `clean()` change) | `57c8d03`, 5 + 2 tests | candidate |
| 7 | **Security review** | §5 | — | — |
| 8 | **Release checklist** | `docs/RELEASE-CHECKLIST.md` | `57c8d03` | — |
| 9 | **Strict-fill interim readiness** | §6 | — | — |

## 3. Tests (this session)

| Suite | Result |
|---|---|
| Frontend | **257/257** (252 + 5 new) on the mission branch; 252/252 on the deployed tree |
| Worker | **364/364** on the deployed tree (360 + 4 new fleet tests); + 2 heartbeat-cleaning tests (mission); 14/14 migration tests (candidate branch) |
| Engine | **301/301** on the mission branch (292 + 9 fault-injection) |
| Ops | 7/7 (health monitor) |
| Research | 8/8 backtester, 3/3 registry |

**Mutation checks:**
- the fleet equivalence test catches ordering and funding mistakes;
- the fault-injection test fails on the old engine code.

## 4. Safety finding: deployed engine defect (HIGH; fix prepared, NOT deployed)

**What fails.** The reconciliation hold introduced in `4849296`/`b17cce0` also held **retries**, which it must not.

**Scenario:**
1. A non-paused bot's entry fill is recorded by the ledger, but the reply is lost (a network blip).
2. The retry is held as "divergence", then expires unsent.
3. The engine drops the position the ledger still holds. That leaves an **unmanaged PAPER position**: no stop or exit is sent.

The health monitor would flag it ("position mismatch").

**Fix (`6a30602`):**
- Only never-sent requests are held. Retries are idempotent by order id.
- An entry still in delivery whose fill the ledger already recorded is not a divergence.
- Proven by the new test, which fails without the fix.

**Exposure:** SOL Orbit and BTC Atlas (the paused bots send no entries). No occurrence so far (the health monitor shows no mismatch).

**Deploy:**
```bash
node bin/release.mjs upgrade --root %USERPROFILE%\AlphaTerminal\engine-prod --repo <repo> --ref 6a30602 --expect-profile solusd-5m
```
Keep `ENGINE_PAUSED_BOTS`. **Needs owner authorization** (engine order handling).

## 5. Security review (read-only)

**What holds:**
- `/api/dashboard*` requires the admin session; production returns 401 unauthenticated.
- `/api/paper/*` needs a session + same-origin header + the passphrase **re-entered for every action**.
- Webhooks need the shared secret, compared through SHA-256 digests.
- **No permissive CORS:** a foreign-origin preflight gets no allow headers.
- `/__scheduled` (a local test hook) is **404 in production**.
- Mutation endpoints are idempotent by request id or order id. One pending order per bot is enforced by a unique index; D1 batches give atomic multi-row writes.

**Low-severity finding:**
- The public `/health` reveals `alpaca_configured: true` and the legacy route's kill-switch state.
- It reveals no secret or account data.
- Possible future change: reduce it to `{ok, mode, database}`. **Not changed** (security-relevant; owner decision).

**Not changed:** no credential, auth path or secret was touched or read.

## 6. Strict-fill observation (interim readiness)

**Ledger, read-only (`worker/scripts/strict-fill-observe.mjs`, 20:09 UTC, since the 03:19:37 switch):**
- 15 orders and **3 entry fills, all strict-compatible** (the fill candle began after the ledger's acceptance, at the limit, for the accepted quantity).
- **0 violations, 0 size-only re-placements, 0 duplicates.**

**Uptime:**
- **5.16 h of recorded engine uptime.** Downtime excluded: 06:44:52 → 18:25:19 (power cut).
- **24 h of uptime is reached at 2026-11-17 15:00 UTC** if nothing goes down. Recompute with the observer and the uptime calculation in this report's commands.

**Recommendation at completion:**
- If fills remain clean, enforcement may be approved. It must be together with, or after, the engine fix in §4.
- The owner must authorize it.

## 7. Owner actions pending (nothing here was done on the owner's behalf)

1. **Worker pause for SOL Flare and BTC Hash:** Bots → each bot → Owner controls → Pause (passphrase). The engine pause protects them meanwhile; the health monitor shows the disagreement until then.
2. **Authorize the engine fix** `6a30602` (§4).
3. **Optionally deploy the mission-branch frontend and Worker** (assistant answers; engine pause shown on the dashboard): candidate `57c8d03`.
4. **Strict-fill Worker enforcement** after 2026-11-17 15:00 UTC, with the readiness report.
5. **The BTC trend trial (BTC Titan)** is still "Not started": Settings → Advanced → Trial → Start.

## 8. Recommended next priorities

1. Deploy the engine fix (§4).
2. Complete the strict-fill observation and decide on enforcement.
3. **Research:** the next evidence must be data not yet used.
   - Option one: a pre-registered **research-only forward observation** of long-only momentum (M1) and Donchian trend (T1) across a basket. This is not a PAPER bot, and needs owner approval.
   - Option two: a pre-registered **portfolio-level** hypothesis that diversifies the concentration found in round 7.
   - No further OTE tuning (rounds 1–6).
4. **Measure** `/api/dashboard/bots` CPU on `00da3a6c` during the next app session (`wrangler tail`; the previous sample was 13–14 ms median and p95).
   - Then apply the same set-based approach to `/api/dashboard` (`getDashboardSnapshot`), which was 12–19 ms.
5. Apply migration 0009 when `trade_events` approaches about 5,000 rows.

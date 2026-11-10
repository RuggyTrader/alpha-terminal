# Strategy Mirror V1 — production readiness audit (2026-11-10)

**Scope.** An independent review of the Strategy Mirror from `7f6becd`, with:
- fixes for development defects;
- a Cloudflare free-tier capacity analysis;
- an investigation of the engine interruption;
- migration, rollback, security and engine-release rehearsals.

**Nothing in production was changed:** no deploy, no D1 write, no engine restart, no task change.

**Rollout plan:** `STRATEGY-MIRROR-ROLLOUT-PLAN.md`.

## 1. Verdict: **READY** for the staged, separately approved rollout. Conditions:

1. Approve and execute each stage (A database, B Worker, C engine, D monitoring) on its own, with its abort conditions.
2. Accept the known limitations in section 8. The most important:
   - the PC is powered off most nights, so the mirror's **live** coverage is limited to the hours the PC is on (the
     rest is labelled catch-up);
   - external TradingView parity is still partial until a CSV export is supplied.

The defects found by this audit (section 3) are fixed and tested in development.

## 2. Independent code review

| Area | Finding |
|---|---|
| Original strategy | `ote.mjs`, `broker.mjs`, `indicators.mjs`, `sizing.mjs` and `profiles/` are **byte-identical** to the pinned production release `6b70cc9` (`git diff --stat 6b70cc9 HEAD` on those files is empty). Only `config.mjs`, `runner.mjs` and the new `mirror.mjs` changed |
| Independent LONG/SHORT state | The mirror creates its own `createState` with fixed sizing and the default emulator. The funded track's `abandonPosition`, refusals, settings and limit-through option never reach it (separate objects and files) |
| Fixed $10 risk | Quantity = risk ÷ stop distance from the unchanged Pine code. Every 150-day mirror trade carries `risk_usd` 10; risk × distance is within one tick of $10 |
| Prices | The strategy's own fills (limit at limit, stop at stop, OHLC path). The Kraken price at receipt is stored separately (`reference_price`), only for live trades |
| Activation and classification | Activation is set once, at the end of the first batch (the warm-up). By the entry candle: before activation = `historical`; after it, processed more than `ENGINE_LATE_BARS` (2) candles late = `catch_up`; otherwise `live` |
| Restarts | The mirror state is saved atomically after every poll; a restart resumes it exactly (5 restarts with an open position = uninterrupted run) |
| Delivery | Ordered outbox, deterministic ids and sequence numbers, retried while pending; refused records are kept and audited |
| Worker ingestion | Strict validation, payload hash, conflicts never overwrite, one atomic batch, sequence-gap detection |
| Reconciliation | One journal entry per trade, equal to its gross; the dashboard checks count, total and per-trade match |
| Funded isolation | Separate tables, endpoint, ids and state files. The funded state, requests, heartbeats and audit are byte-identical with the mirror on or off |

## 3. Defects found and fixed in development

| # | Defect | Effect if deployed | Fix | Test |
|---|---|---|---|---|
| 1 | **D1 queries per request grew with the batch** (3–4 per record; the engine sent up to 100) | **Workers Free allows 50 D1 queries per invocation.** A warm-up or catch-up batch would have failed with "Too many API requests by single Worker invocation", every retry too, so the mirror would never deliver. Local `wrangler dev` does not enforce the limit, so the earlier tests passed | Constant work per request: local validation, three `IN` read-backs, **one atomic `db.batch`** (counts as one query). Batches capped at 25 (engine and Worker). The response reports `d1_queries` | every request in the suites ≤ 9 queries; a 26-record request is refused; mixed new/duplicate/conflict/invalid batch |
| 2 | **A mirror request on every 20-second poll** | +4,320 requests/day and ~8,600 rows written/day (2 writes each), for no information | Requests only for new records, a new candle, or a 15-minute health report (≈ 300/day). The sequence mark is written only when it changes | throttle test: no request without a new candle; one per candle; a heartbeat after 15 minutes |
| 3 | **False data-gap resets.** Kraken omits candles for intervals without trades; the mirror treated the hole as a data gap, re-warmed and recorded an open position as interrupted | 3 such intervals in the last 150 days (Aug 6, Aug 20, Oct 30). Each would have broken TradingView parity and interrupted a position | Inside Kraken's 720-candle window, a missing interval is **no bar** (TradingView semantics, as in the parity dataset). A reset happens only when the last candle is older than the window. Counted as `no_trade_intervals` and shown | no-trade-interval test (trades = the history without that bar); real-gap test (engine down beyond the window) |
| 4 | **Observation gaps were not disclosed** when an outage produced no trade | The dashboard could look continuous across a 17-hour outage | Candles processed late after activation form an observation gap (from, to, candles, processed at), sent with the account and listed in the dashboard's health card | outage replica test; UI test |
| 5 | `release.mjs validate` did not report the mirror setting | An operator could not see before activation whether the mirror would run | `validate` reports `mirror` (true/false; null for releases without it). `ENGINE_MIRROR=on` with a mirror-less release is a **warning**, not a refusal, so a rollback still starts the funded engine | launcher rehearsal |

**Pre-existing funded-track issue found, NOT changed (needs its own approval):** the funded track also re-warms when
the next candle is not adjacent, including an interval without trades (`runner.mjs`, unchanged since `6b70cc9`).
- It would have happened about 3 times in 150 days.
- Each time, an open funded engine position is reconciled and a fresh warm-up starts.
- The mirror no longer does this.
- The test `an interval without trades inside Kraken's window …` documents the funded behaviour without changing it.

## 4. Cloudflare free-tier compatibility

**Limits** (developers.cloudflare.com; Workers limits updated 2026-10-29, D1 limits and pricing 2026-10-30):

| Limit | Workers Free |
|---|---|
| Requests | 100,000/day |
| CPU time | 10 ms/request |
| Subrequests | 50/request |
| D1 queries | 50/invocation (**a `db.batch()` counts as one**) |
| Bound parameters | 100/query |
| Rows read / written | 5,000,000 / 100,000 per day |
| Storage | 500 MB/database |
| Time Travel | 7 days |

**Measured production usage** (`wrangler d1 info`, last 24 h, read-only):
- 4,399 read queries and 1,181 write queries;
- 6,120 rows read and 1,227 rows written;
- database size 200,704 bytes.

The engine was up only about 7 of those 24 hours. A full day of engine polls (every 20 s: engine-status +
engine-ledger) is about 8,640 requests and ~4,500 rows written.

**Mirror cost after the fixes:**

| Item | Estimate | Basis |
|---|---|---|
| Mirror requests | ≤ ~300/day (288 candles + up to 96 heartbeats while no candle arrives) | throttle |
| D1 queries per mirror request | ≤ 9 (limit 50) | measured `d1_queries` in every test request |
| Records per request | ≤ 25 (bound params ≤ 52, limit 100) | Worker cap |
| Rows written per day | ~300 (account upsert) + ~30 (4 trades × ~7 rows incl. indexes) + a few sequence updates ≈ **350** | per D1 pricing definitions |
| Rows read per day (ingestion) | ~1,500 | account and sequence reads |
| Dashboard Strategy Mirror page | ~3 × N rows per open (N = trades in the account; not polled) | full read of one account |
| Storage | ~2.5 KB per trade incl. journal and indexes; at ~4 trades/day ≈ **3.5 MB/year** | row sizes |
| 720-candle warm-up | ~15–30 trades (14 on the 720-candle fixture) → 1–2 requests | measured |
| Catch-up after up to 60 h offline | ≤ 720 candles → ≤ ~30 trades → ≤ 2 requests; beyond 60 h a reset plus an interruption record | measured |
| Retries during an outage | ≤ 1 request per poll while records are pending (≤ 4,320/day if the Worker failed all day); each ≤ 9 queries | design |

**Conservative daily totals with the mirror:**
- **Requests:** ~8,640 (engine) + ~300 (mirror) + dashboard (it polls every 7 s while open: ~4,100 for 8 hours,
  ~12,300 for 24 hours) ≈ **13,000–21,000** of 100,000.
- **Rows written:** ~4,500 + ~350 ≈ **5,000** of 100,000.
- **Rows read:** ~22,000 + 1,500 + mirror page opens (~4,500 rows each at 1,500 trades; 50 opens ≈ 225,000) ≈
  **250,000** of 5,000,000.
- **Storage:** well under 1% of 500 MB per year.

**Worst-case tests with the local Worker:**
- the full 150-day history (579 trades) in 24 requests, each ≤ 9 queries;
- 5,211 trades (nine 150-day histories) in 209 requests (6.5 s locally).

The dashboard summary for 5,211 trades was 34.6 KB and took 91 ms wall time locally (including SQLite and JSON).
**CPU time on Cloudflare was not measured** (`wrangler dev` does not enforce or report the 10 ms limit). Free-plan CPU
excludes I/O wait, and at ~4 trades/day 5,000 trades is ~3.5 years away.
- If the dashboard ever returns error 1102 (CPU), the fix is to pre-aggregate the per-category metrics on ingestion.
- This is not needed for V1.
- No paid dependency is introduced.

## 5. The 2026-11-10 engine interruption (read-only evidence)

| Time (UTC) | Evidence | Source |
|---|---|---|
| 03:45:05 | last on-time candle processed (the 03:40 candle) | `engine.log` |
| 03:46:12 | `winlogon.exe` initiated a **power off**, reason code 0x500ff, on behalf of NT AUTHORITY\SYSTEM; user logoff notification | System log, User32 1074, Winlogon 7002 |
| 03:46:19 | clean OS shutdown | Kernel-Power 109, Kernel-General 13 |
| — | no crash (no Kernel-Power 41), no sleep or hibernate events, no Windows Update events in the window | System log |
| 20:11:40 | OS started | Kernel-General 12 |
| 20:20:54 | user signed in | Winlogon 7001 |
| 20:21:00 | supervisor started by the task's sign-in trigger; release `6b70cc97c579` verified; engine PID 11900, resumed (no reset) | `supervisor.log`, audit |
| 20:23:55 | the second sign-in trigger (3-minute delay) started another supervisor, which saw the running one and exited (as designed) | `supervisor.log` |

**Cause: the PC was powered off (a clean shutdown).** It is not a crash, sleep, Windows Update or supervisor failure.
- The engine stayed down until the next **sign-in**: the task has two sign-in triggers and none at boot, so the 9
  minutes between boot and sign-in were also offline.
- The shutdown was initiated through winlogon as SYSTEM. The logs do not say whether the power button or the Start
  menu was used.
- **This is a nightly pattern:** 34 shutdown/restart events (1074) in the last 30 days, with power-offs almost every
  night between about 01:00 and 07:00 UTC (8 p.m. to 2 a.m. Eastern). Expect the engine, and the mirror, to be
  offline most nights.

**Effect:**
- The funded track caught up 197 candles without a gap or duplicate.
- It correctly expired 3 entries (05:45 SELL, 07:30 SELL, 08:00 BUY), never sending them.
- Its ledger check stayed OK.

**With the mirror:**
- **Classification:** the replica test (204 candles while offline, inside Kraken's history) shows those trades
  recorded as **`catch_up`, never `live`**. The 2 newest candles, closed within the 2-candle tolerance, count as on time.
- **Disclosure:** a single observation gap (202 candles, from/to, processed at) is shown on the dashboard.
- **No reset**, and live classification resumes afterwards.
- **Correction:** `STRATEGY-MIRROR-V1.md` §8a said the outage began at "about 03:25"; it began at 03:46 (corrected).

## 6. Migration 0005 and rollback evidence

`worker/test/mirror_rollout.test.mjs` starts from production's shape:
- schema 4 written by the deployed Worker `8b188c8` (= `e941387e`);
- MAIN $90 / SOLUSD $10, refusals and one accepted round trip, so every funded table has rows.

Results:
- 0005 applies alone. **All 14 funded and system tables are byte-identical** (`app_meta` apart from `schema_version`).
  Balances are unchanged, and re-applying is a no-op.
- **The deployed Worker and the rollback Worker `c5bb67e` on schema 5:**
  - consistency OK, refusals unchanged;
  - no mirror route (404);
  - books unchanged.
  - The same holds again **after** mirror records exist.
- **Mirror-capable Worker:**
  - 30 days of mirror records stored once;
  - three full replay rounds (in reverse order) are all `duplicate`, write nothing, and change no result;
  - the journal reconciles and health is OK;
  - funded tables are unchanged, with 0 FEE rows.

Also: `migrations.test.mjs` (0005 additive, constraints) and `mirror.test.mjs` (deployed and rollback Workers on
schema 5).

## 7. Security, configuration and funded isolation

- **Webhooks.** `/webhook/dry-run`, `engine-status`, `engine-ledger`, `engine-backtest` and `engine-mirror` all
  refuse a wrong secret (401). No secret appears in any response or stored record.
- **Mirror dashboard routes:** 401 without a session or with a forged cookie, and read-only (`POST` → 405). The
  existing dashboard endpoints (dashboard, performance, trades, activity, alerts, risk, orders, summary, backtest,
  trade proof) still work.
- **Configuration unchanged:**
  - `ENABLE_TRADING=false` and `PAPER_COST_PROFILE=none`;
  - limits: order notional 5,000, futures notional 75,000, order quantity 10, position exposure 10,000, total exposure
    25,000, 5 open positions, daily loss 2,000, shorts off;
  - `wrangler.jsonc` adds no variable (`deploy_config.test.mjs`); the bundle dry-run prints the same bindings.
- **No broker path.** `mirror.ts` imports only `costs`, `instruments` and `secureEqual`. Its only network call is a
  read-only Kraken public ticker GET (comparison price, live trades only). Every mirror response says
  `broker_request_sent:false`.
- **Ndax figures.** Labelled "Cost-model comparison … Estimates only; the gross baseline stays fee-free" and "Comparison
  only … never charged to any balance", under the "Hypothetical — unlimited buying power, not executable performance"
  banner. The funded profile stays `none`.
- **Funded isolation.** Byte-identical funded tables after every kind of mirror activity (Worker). Byte-identical
  funded state, requests, heartbeats and audit with the mirror on or off (engine). Byte-identical funded state after
  the whole upgrade, rollback and re-enable sequence versus an old-release control (release rehearsal).

## 8. Engine release rehearsal (`engine/test/mirror-release.test.mjs`)

Both releases were prepared with `release.mjs` (git objects plus checksum manifest) in temporary roots: OLD =
`6b70cc97c579` (pinned today) and NEW = this code.

**Part 1** runs each release's own code with a controlled clock on one shared state folder:
1. OLD runs the funded track.
2. NEW with the mirror **off** resumes it exactly, with no mirror file or request.
3. With the mirror **on**: its own state file, warm-up trades historical, **activation once**, then live.
4. A restart preserves both tracks.
5. A rollback to OLD continues the funded track and leaves the mirror file untouched.
6. Re-enabling NEW resumes the mirror: the rollback period is recorded as catch-up and an observation gap, with no
   reset, **no trade twice** and a contiguous sequence.
7. **The final funded state is byte-identical to an OLD-only control.**
8. The mirror recorded exactly the strategy's trades over those candles.

**Part 2** uses the real launcher (`run-release.ps1 -Once`):
- OLD starts.
- NEW validates with `mirror: true` and `state.resumable: true`; the launcher starts it; the funded state continues;
  the mirror is created and activated.
- A rollback with `ENGINE_MIRROR` still on gives a warning, not a refusal; OLD starts and leaves the mirror file
  alone.

## 9. Tests

Development only, on isolated temporary databases.

| Suite | Result |
|---|---|
| Engine `npm test`: TradingView parity, baseline (Model A/B/C), the 150-day mirror replay, mirror reliability (23), release rehearsal (11), release tooling, state migration | **171/171** |
| Worker `npm test`: mirror ingestion and bounds (15), rollout rehearsal (9), migrations incl. 0005, rollback and deploy rehearsals on `8b188c8`/`c5bb67e`, auth, costs, disclosures, deploy config | **234/234** |
| Frontend `vitest run` (incl. observation-gap disclosure) and `tsc --noEmit` | **113/113**, typecheck clean |
| Worker bundle (`wrangler deploy --dry-run`, nothing uploaded) | 200.75 KiB; `ENABLE_TRADING=false`, `PAPER_COST_PROFILE=none` |

Capacity test timing for 5,211 trades in 209 requests, dashboard summary 34.6 KB:
- alone: 6.5 s, dashboard 91 ms;
- inside the full parallel suite: 28 s, dashboard 303 ms.

These are local wall times.

**Historical baseline (internal parity):**
- 579 closed trades, 308 LONG / 271 SHORT;
- +$150.24 gross, PF 1.076, max DD $225.97;
- **0 of 579 trades differ** from the Model A records;
- Model B (Ndax) −$9,594.13 reproduced by the Worker's comparison;
- no change to the funded account.

**External TradingView verification is partial:** the benchmark window matches the TradingView report's summary and
its 5 listed trades (screenshots). A full trade-by-trade comparison needs a "List of trades" CSV export.

## 10. Limitations (accepted for V1)

- **Results are hypothetical:** margin 0, touch fills, no queue or liquidity limits. With costs the strategy loses
  heavily.
- **Live coverage** is limited to the hours the PC is on (most nights are offline). Those hours become catch-up,
  disclosed as observation gaps.
- **More than 60 hours offline** loses candles: positions are recorded as interrupted, and the mirror re-warms.
- **CPU time on Cloudflare** for very large accounts (thousands of trades) is unmeasured. Mitigation is noted in
  section 4.
- **The pre-existing funded re-warm** on no-trade intervals is unchanged (section 3).
- **External parity** stays partial until a CSV export is supplied.

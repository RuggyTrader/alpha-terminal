# Fee-aware Worker deployment, 2026-11-10 (costs OFF)

**Outcome: deployed and verified.** The owner approved this deployment on 2026-11-10. It followed
`WORKER-DEPLOYMENT-PLAN-2026-11-10.md`, steps A–G.

- Simulated execution costs stay **off** (`PAPER_COST_PROFILE=none`).
- Turning on the Ndax estimate is a later, separate approval.
- PAPER-only. `ENABLE_TRADING=false`. No balance, strategy, risk ($10) or engine change.

## Versions

| Component | Before | After |
|---|---|---|
| Active Worker (100%) | `2cd0119d-0336-431e-98c9-2163ed4f2b29` (commit `cde07af`) | **`e941387e-0942-4320-b0dd-454235095c4b`** (commit `8b188c8`) |
| Staged rollback Worker (0% traffic) | — | **`39b41f96-111f-442c-98f3-ccf68699fdeb`** (commit `c5bb67e`, tag `rollback-c5bb67e`) |
| D1 `alpha-terminal-db` | schema 3 | schema 4 (migration `0004_paper_execution_costs.sql`) |
| Pinned engine | release `6b70cc97c579`, PID 15976 | unchanged, not restarted |

## Timeline (UTC)

| Time | Step | Result |
|---|---|---|
| 02:03 | **A. Preflight** (read-only) | Passed. Engine release verified; 0 pending signals; no position. D1 schema 3; 0 open positions, fills and trades; 3 entries; MAIN $90, SOLUSD $10. Only 0004 pending |
| 02:03:34 | **B. Recovery point** | Time Travel bookmark `0000002c-000003ea-0000511f-68841211e43c39a6ac4c5e02752d33ef`. Full export `%USERPROFILE%\AlphaTerminal\backups\d1-before-0004-2026-11-10T02-03-34Z.sql` (51 INSERTs; counts match). Private: contains PAPER history; never commit |
| 02:04 | **C. Rollback version uploaded** | `39b41f96-…` from a worktree at `c5bb67e`; same bindings and variables; took no traffic |
| 02:05:21 | **D. Migration 0004** | Applied after the 02:05 candle (0 pending, no position). 19 commands OK. Schema 3 → 4; every count, wallet, entry and risk setting unchanged; 0 FEE entries |
| 02:06:07 | **E. Deploy** | `wrangler deploy` from clean `8b188c8` with a fresh frontend build. Bindings = production + `PAPER_COST_PROFILE ("none")`. No `--var` passed |
| 02:06:31 | **F. Verify** | See below |
| 02:10– | **G. Monitor** | See below |

## Verification (F)

| Check | Result |
|---|---|
| `deployments status` | `e941387e-…` at 100% |
| `versions view` | compatibility date 2026-10-30; secrets kept (names): ADMIN_SECRET, ALPACA_KEY, ALPACA_SECRET, DASHBOARD_PASSPHRASE, WEBHOOK_SECRET |
| `/health` | `ok:true`, mode PAPER, database connected, `enable_trading:false` |
| Dashboard page | HTTP 200 |
| Unauthenticated `/api/dashboard` | HTTP 401 (still refused) |
| Webhook with a wrong secret | `UNAUTHORIZED`, `broker_request_sent:false` |
| D1 (read-only) | schema 4; 0 open positions; $0 reserved; 0 fills, 0 trades; 3 entries; **0 FEE entries**; alerts 10, orders 4; MAIN $90.00, SOLUSD $10.00 — identical to the pre-deploy read |

## Monitoring (G), first window 02:06–02:11 UTC

| Check | Result |
|---|---|
| Engine, 02:10:05 candle (first one after the deploy) | processed on time ("Waiting for a swing"); no errors in `engine.log` since 02:00 |
| Engine heartbeat and ledger check | last run at engine start (00:36:05): both OK. These only run when the engine starts, and the engine was deliberately not restarted, so there is none after the deploy. The D1 checks below cover the same ground |
| D1, 02:11 (read-only) | schema 4; 0 open positions; 0 fills; **0 duplicate fills**; **0 FEE entries**; 3 entries; alerts 10, orders 4 |
| Ledger identity | wallets available + reserved = $100.00 = funding + realized − fees ($100 + $0 − $0) = sum of all entry changes |
| `/health`, `deployments status` | unchanged: PAPER, database connected, `enable_trading:false`; `e941387e-…` at 100% |

No signal has occurred since the deploy, so a fill under the new Worker has not been observed yet. When one
occurs, it should be answered `DRY_RUN_ACCEPTED` (or with a known refusal code), with `fee_micro = 0` and
`cost_profile = 'none'`. Keep monitoring for at least a few hours by re-running the plan's checks.

## Rollback (if ever needed)

From `worker\`, run:

```
node node_modules\wrangler\bin\wrangler.js versions deploy 39b41f96-111f-442c-98f3-ccf68699fdeb@100% --yes --message "rollback to fee-compatible c5bb67e"
```

- That Worker understands schema 4 and charges no fees.
- **Never restore D1 as part of a Worker rollback.** A Time Travel restore to the bookmark above discards every
  record made after 02:03:34 UTC. It needs its own approval and a data-loss analysis (runbook section 8).

## Still for the owner

- Log in to the dashboard. Settings → Execution costs should show "No execution costs" and the fill-pricing
  disclosure, and portfolio consistency should be OK. This needs the passphrase, so it was not checked here.
- Ndax cost estimates remain off until separately approved.
- Simulated PAPER results are not exchange profits.

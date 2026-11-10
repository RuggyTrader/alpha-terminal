# Fee-aware Worker deployment plan (prepared 2026-11-10; NOT executed)

**Status: ready for a separately approved deployment. Nothing below has been run against production.** Every step
marked **[APPROVAL]** needs the owner's explicit approval. Simulated execution costs stay **off**
(`PAPER_COST_PROFILE=none`). Turning on the Ndax estimate is a later, separate approval.

Reminders that apply to everything below:
- PAPER fills use the Kraken reference price when the signal is processed.
- Ndax costs are estimates applied to those prices, not Ndax SOL/CAD executions.
- Maker/taker is inferred from order types, not exchange-verified.
- The funded PAPER ledger is not the theoretical leveraged TradingView backtest.
- Simulated results are not exchange profits.

## 1. Versions

| Component | Version |
|---|---|
| Production Worker | `2cd0119d-0336-431e-98c9-2163ed4f2b29` (commit `cde07af`), 100% of traffic, deployed 2026-11-09 03:16 UTC |
| Production D1 | `alpha-terminal-db` (`40741873-0a98-4b23-b4e2-19ac8acec80c`), schema 3 (0001–0003); pending: `0004_paper_execution_costs.sql` only |
| Pinned production engine | release `6b70cc97c579` = commit `6b70cc97c57964eb8f0d0fabc761ffb8a77053b3`, root `%USERPROFILE%\AlphaTerminal\engine-prod` (unchanged by this plan) |
| Worker to deploy | branch `v1.2.0-cloudflare` at the commit that adds this plan (the fee-aware Worker `3ff5717` + disclosures `abbdd66` + config default `none`) |
| Rollback Worker | branch `rollback/worker-fee-compat`, commit `c5bb67e` (Worker code identical to `1694c1f`) |
| Wrangler | 4.156.0 (every command below was checked against its `--help`) |

## 2. Production preflight, 2026-11-10 01:27–01:40 UTC (read-only)

| Check | Result |
|---|---|
| Pinned engine | PID 15976; active release `6b70cc97c579`, files and launcher verified; task working directory `%USERPROFILE%\AlphaTerminal\engine-prod`; validate ok: `solusd-5m`, risk $10, longs and shorts on, fixed sizing, sync on, settings hash `c826d785d58a4a39` |
| Candles since the engine migration | 11 (00:30–01:20), 0 gaps, 0 duplicates, none processed late; 0 errors |
| Signals | 39, 0 duplicates, 0 pending; no strategy position; no reset since 2026-11-09T01:28:50Z |
| D1 (2 identical reads, no writes) | schema 3; 0004 column absent; 0 open positions; $0 reserved; 0 fills, 0 trades; 3 entries; alerts 10, orders 4 (none in the last 24 h); risk SOLUSD $10 v1 APPLIED |
| Wallets | all 6 reconciled with their entry history: MAIN $90.00, SOLUSD $10.00, others $0; realized $0; funding $100 |
| Worker settings (`versions view`) | D1 binding `DB`; `ENABLE_TRADING=false`; ALLOWED_SYMBOLS, MAX_ORDER_QTY 10, MAX_ORDER_NOTIONAL 5000, MAX_FUTURES_ORDER_NOTIONAL 75000, MAX_POSITION_EXPOSURE 10000, MAX_TOTAL_EXPOSURE 25000, MAX_OPEN_POSITIONS 5, SHORT_SELLING_ENABLED false, DAILY_LOSS_LIMIT 2000; compatibility date 2026-10-30; secrets (names): ADMIN_SECRET, ALPACA_KEY, ALPACA_SECRET, DASHBOARD_PASSPHRASE, WEBHOOK_SECRET |
| D1 Time Travel | bookmarks resolve for 1, 6 and **8 days** ago, so retention exceeds the free plan's 7 days (Wrangler accepts up to 30). Nothing before the database's creation on 2026-10-30 |
| Export | available (schema-only export verified 2026-11-09) |

## 3. What the deployment changes, and what it does not

- **Configuration:** `wrangler.jsonc` keeps every production setting exactly (`worker/test/deploy_config.test.mjs`).
  Its only new variable is `PAPER_COST_PROFILE`, which ships as **`none`**. Until 2026-11-10 it shipped as `ndax`, so
  a plain deploy would have switched fees on. A local `wrangler deploy --dry-run` shows exactly the production
  bindings plus `PAPER_COST_PROFILE ("none")`. Secrets are not in the config and are kept by a deploy.
- **Code since `cde07af`** (all tested):
  - PAPER execution-cost accounting (inactive with `none`);
  - fill-pricing disclosures;
  - the ledger-balance read for the engine's optional percent sizing (unused: production sizing is fixed);
  - Worker-side rejection handling.
- **D1:** migration 0004 rebuilds `portfolio_entries` (same ids, keys and amounts) to allow `FEE`, and adds cost
  columns with neutral defaults. It changes no balance, trade or position.
- **Not changed:** the pinned engine, its task and state, strategy, risk, balances, `ENABLE_TRADING` and every limit.

## 4. Commands (Windows `cmd`, from a clean checkout of the approved commit)

Run D1 commands as `node node_modules\wrangler\bin\wrangler.js …` from `worker\`. Through the `npx` wrapper, quoted
SQL can hang. `W` below stands for that command.

**A. Preflight (read-only) — abort if anything differs from section 2 in a way not explained by normal trading.**

```
node %USERPROFILE%\AlphaTerminal\engine-prod\bin\release.mjs status --root %USERPROFILE%\AlphaTerminal\engine-prod
node %USERPROFILE%\AlphaTerminal\engine-prod\bin\release.mjs state-check --dir %USERPROFILE%\AlphaTerminal\engine-state
W d1 execute alpha-terminal-db --remote --json --command "SELECT (SELECT value FROM app_meta WHERE key='schema_version') AS schema_version, (SELECT COUNT(*) FROM paper_positions WHERE status='OPEN') AS open_positions, (SELECT COALESCE(SUM(reserved_micro),0) FROM portfolio_wallets) AS reserved, (SELECT COUNT(*) FROM paper_fills) AS fills, (SELECT COUNT(*) FROM trades) AS trades, (SELECT COUNT(*) FROM portfolio_entries) AS entries, (SELECT COUNT(*) FROM alerts) AS alerts"
W deployments status
W d1 migrations list alpha-terminal-db --remote          (must list only 0004_paper_execution_costs.sql)
```

Requirements:
- 0 open SOLUSD positions;
- `state-check` shows 0 pending signals, and the strategy is not in a position;
- run it shortly after a candle has been processed.

**B. Recovery point and backup.**

```
W d1 time-travel info alpha-terminal-db                  (record the bookmark and time in the deployment record)
W d1 export alpha-terminal-db --remote --output=%USERPROFILE%\AlphaTerminal\backups\d1-before-0004-<UTC time>.sql
```

The export contains PAPER history; keep it private and never commit it.

**C. Stage the rollback Worker as an uploaded, not deployed, version [APPROVAL].**

```
git worktree add ..\alpha-rollback c5bb67e
cd ..\alpha-rollback\frontend && npm ci && npm run build
cd ..\worker && npm ci && npx wrangler versions upload --message "ALPHA TERMINAL fee-compatible rollback c5bb67e" --tag rollback-c5bb67e
```

Record the printed version id as **ROLLBACK_VERSION**. An uploaded version takes no traffic.

**D. Apply migration 0004 [APPROVAL].**

```
W d1 migrations apply alpha-terminal-db --remote         (Wrangler asks for confirmation; it lists only 0004)
```

Then re-run the A query and:
- `schema_version` = 4;
- entries, fills, trades and alerts are unchanged;
- each wallet's available, reserved, realized and funding values are unchanged;
- `SELECT COUNT(*) FROM portfolio_entries WHERE kind='FEE'` returns 0.

The production Worker keeps working on schema 4 with no fees (rehearsed).

**E. Deploy the fee-aware Worker with costs OFF [APPROVAL].**

```
cd frontend && npm ci && npm run build
cd ..\worker && npx wrangler deploy --message "ALPHA TERMINAL <commit> fee-aware Worker, PAPER_COST_PROFILE=none (PAPER-only)"
```

- Do **not** pass `--var`. The committed config already sets `none`, and adds nothing else.
- Check the printed bindings: they must equal section 2 plus `env.PAPER_COST_PROFILE ("none")`.
- Record the new version id.

**F. Verify.**
- `curl https://alpha-terminal-api.mattledger787.workers.dev/health` shows `enable_trading:false` and the database
  connected.
- Dashboard → Settings → Execution costs shows "No execution costs" and the fill-pricing disclosure. Portfolio
  consistency is OK, and the totals match section 2.
- The A query is unchanged.
- At the next candle, `engine.log` shows normal processing and the engine's heartbeat and ledger check are OK
  (`audit-SOLUSD-5m.jsonl`).
- If a signal occurs, it is answered `DRY_RUN_ACCEPTED`, or with a known refusal code. Its fill has `fee_micro = 0`
  and `cost_profile = 'none'`.

**G. Monitor** for an agreed period (at least a few hours):
- consistency OK;
- no `FEE` rows;
- no duplicate fills (`SELECT client_order_id, COUNT(*) FROM paper_fills GROUP BY 1 HAVING COUNT(*) > 1` returns
  none);
- the engine processes every candle.

## 5. Abort and recovery

| Situation | Action | Data |
|---|---|---|
| A preflight check fails | stop; deploy nothing | unchanged |
| Migration 0004 fails | D1 rolls the migration back; confirm schema 3 and unchanged rows; stop | unchanged |
| The new Worker misbehaves | `npx wrangler versions deploy <ROLLBACK_VERSION>@100% --yes --message "rollback to fee-compatible c5bb67e"` | kept (schema 4 understood; no fee charged) |
| Same, and the rollback version was not staged | `npx wrangler rollback 2cd0119d-0336-431e-98c9-2163ed4f2b29 --message "rollback" --yes` | kept. Safe **only while no FEE entry exists**, which holds with `PAPER_COST_PROFILE=none`. That Worker has no fee term in its consistency check |
| Anything touching the engine | leave the pinned engine running; it is not part of this deployment | — |

- **Never restore D1 as a Worker rollback.** A Time Travel restore discards every record made after the bookmark and
  needs its own approval and data-loss analysis (runbook section 8).
- **After any rollback:** consistency OK, the A query matches, and the engine heartbeat is OK.

## 6. Evidence (development, isolated local databases)

| Suite | Result |
|---|---|
| Engine `npm test` (incl. TradingView parity, release tooling, state migration) | 137/137 |
| Frontend `vitest run` + `tsc` | 103/103, typecheck clean |
| Worker `npm test` (incl. paper_costs, cost_audit, rollback_release, deploy_rehearsal, deploy_config, disclosures, migrations, engine_sync) | 201/201 |
| Rollback branch (`c5bb67e` Worker code) `npm test` and frontend | 148/148 and 94/94 |
| `worker/test/deploy_rehearsal.test.mjs` | the exact sequence C–F on production-shaped data (MAIN $90, SOLUSD $10): 0004 keeps every row; the committed config gives costs `none`; an engine-format signal (with `liquidity`) is accepted with no fee and gross = net; duplicate, over-capital and short orders are refused; rollback to `c5bb67e` and roll-forward leave the books identical. 5/5 |

Defects found while preparing this plan:
1. **`wrangler.jsonc` shipped `PAPER_COST_PROFILE=ndax`**, so a plain deploy would have enabled fees. Fixed: `none`,
   guarded by `deploy_config.test.mjs`.
2. **`sync_setup.test.mjs` shared port 8791 with `auth.test.mjs`.** Test files run in parallel, so another Worker
   could answer and three tests failed intermittently. Fixed: port 8805, on both branches. Test-only; no application
   change.

# Strategy Mirror Stage B — mirror-capable Worker deployed (2026-11-11)

**Outcome: succeeded; no rollback needed.**
- **New Worker version `4d3ddcb6-08a3-472d-8f99-81ff8b317ae2`**, built from the approved application commit
  `0db082fbd0449bf47ac610e74055916c72282412`, serves 100% of traffic. Deployed 2026-11-11 01:55:11–14 UTC.
- It carries the Strategy Mirror ingestion endpoint, the read-only mirror API and the Strategy Mirror dashboard.
- All funded PAPER behaviour, the configuration and the secrets are unchanged.
- The funded ledger is byte-identical before and after.

**Not done (Stage C and later, separate approvals):**
- engine not restarted or upgraded (still `6b70cc97c579`);
- `ENGINE_MIRROR` not set; task unchanged;
- no D1 migration, no restore; no fee, risk, balance or trading change;
- no production test trade and no simulated mirror trade.

## Source

- **Checkout:** `HEAD` = `origin/v1.2.0-cloudflare` = `ae315e5`, clean.
- **Code:** `git diff 0db082f HEAD -- worker frontend engine` is empty (only 2 docs files differ), so the deployed code
  is the approved commit.
- **Dependencies:** package files unchanged since the deployed `8b188c8`.
- **Frontend:** `npm ci` and `npm run build` from scratch.
- **Deploy command:**
  `wrangler deploy --message "ALPHA TERMINAL 0db082f Strategy Mirror V1 Worker (hypothetical mirror ingestion; PAPER_COST_PROFILE=none)"`.
  No `--var`.
- **Bundle (dry-run first):**
  - 200.75 KiB, with `/webhook/engine-mirror`, `/api/dashboard/mirror[/trades|/trade]`, the hypothetical label and
    `d1_queries`;
  - the frontend build includes the Strategy Mirror page (observation gaps, cost-model comparison, trade proof);
  - the served page loads `assets/index-B_EmMT_u.js`, which contains "Strategy Mirror".

## Preflight (01:51 UTC), compared with Stage A

| Check | Result |
|---|---|
| Pinned engine | `6b70cc97c579`, files verified, PID 11900 running; 1,301 candles, last 01:45; resets 0; 42 signals, 0 duplicates, 0 pending; no position; risk $10; ledger check OK 01:50:46; no mirror file; `ENGINE_MIRROR` absent |
| Worker | `e941387e` at 100%; `/health` ok, PAPER, database connected, `enable_trading:false` |
| D1 | schema 5; `migrations list` = "No migrations to apply"; mirror tables 0 rows |
| Ledger | **all 18 tables byte-identical to the Stage A post-migration fingerprint** (row-level SHA-256; the engine heartbeat key excluded); counts identical: 3 entries, 0 FEE, 0 fills, 0 trades, 0 open positions, alerts 10, orders 4, risk decisions 8 |
| Wallets | MAIN $90.00, SOLUSD $10.00, others $0; each = sum of its entries = funding + realized − fees; reserved 0 |
| Risk setting | SOLUSD v1, $10, not compounding, APPLIED |

## Rollback readiness (recorded before the deploy; not used)

| Version | Description | Configuration |
|---|---|---|
| `e941387e-0942-4320-b0dd-454235095c4b` | pre-mirror Worker (`8b188c8`) | same D1 binding, 11 variables, 5 secrets |
| `39b41f96-111f-442c-98f3-ccf68699fdeb` | fee-compatible rollback (`c5bb67e`) | same binding and limits, 5 secrets (no `PAPER_COST_PROFILE`: charges no fee by design) |

Both were rehearsed on schema 5, before and after mirror rows existed (`worker/test/mirror_rollout.test.mjs`).

Commands, from `worker\`:

```
node node_modules\wrangler\bin\wrangler.js versions deploy e941387e-0942-4320-b0dd-454235095c4b@100% --yes --message "rollback to e941387e (pre-mirror)"
node node_modules\wrangler\bin\wrangler.js versions deploy 39b41f96-111f-442c-98f3-ccf68699fdeb@100% --yes --message "rollback to fee-compatible c5bb67e"
```

Never restore D1 as part of a Worker rollback.

## Configuration of the new version (`wrangler versions view`)

- Compatibility date 2026-10-30.
- D1 `DB` = `40741873-0a98-4b23-b4e2-19ac8acec80c`.
- Variables:
  - `ENABLE_TRADING=false`, `PAPER_COST_PROFILE=none`, `SHORT_SELLING_ENABLED=false`;
  - `MAX_ORDER_QTY=10`, `MAX_ORDER_NOTIONAL=5000`, `MAX_FUTURES_ORDER_NOTIONAL=75000`;
  - `MAX_POSITION_EXPOSURE=10000`, `MAX_TOTAL_EXPOSURE=25000`, `MAX_OPEN_POSITIONS=5`, `DAILY_LOSS_LIMIT=2000`;
  - `ALLOWED_SYMBOLS` unchanged.
- **Identical to `e941387e`.** No new variable.
- **Secrets preserved** (names): ADMIN_SECRET, ALPACA_KEY, ALPACA_SECRET, DASHBOARD_PASSPHRASE, WEBHOOK_SECRET.

## Post-deployment validation (01:55–02:01 UTC)

| # | Check | Result |
|---|---|---|
| 1 | Traffic | `4d3ddcb6-…` at **100%** |
| 2–3 | `/health` | ok, `mode: PAPER`, `database: connected`, `enable_trading: false` |
| 4 | Unauthenticated dashboard | **401** for `/api/dashboard`, `/performance`, `/trades`, `/activity`, `/alerts`, `/risk`, `/orders`, `/summary`, `/backtest`, `/trade-proof`, `/auth/session` |
| 5 | Wrong-secret webhooks | **401 `UNAUTHORIZED`** for `/webhook/dry-run` (`broker_request_sent:false`), `engine-status`, `engine-ledger`, `engine-backtest`, `engine-mirror`; nothing stored (ledger byte-identical afterwards) |
| 6 | Mirror API | `/api/dashboard/mirror`, `/mirror/trades`, `/mirror/trade` → **401** without a session and with a forged session cookie |
| 7 | Existing routes and pages | all existing API routes present (401 without a session, not 404); `/`, `/mirror`, `/engine`, `/trades` serve the new dashboard (200) |
| 8 | Schema | 5; no migration pending |
| 9 | Wallets | identical; reconcile |
| 10 | FEE rows | 0 |
| 11 | Trades and fills | **all 18 tables byte-identical before and after**: 0 fills, 0 trades, no new alert, order or risk decision; mirror tables 0/0/0 |
| 12 | Engine | 02:00:05 candle processed on time; 1,303 candles; resets 0; 42 signals, 0 duplicates, 0 pending; no new audit event apart from the candle; no failed heartbeat |
| 13 | Engine ledger check | **OK** at 02:01:27, now answered by the new Worker; `lastError` null |

**D1 usage (24 h, after the deploy):**
- 4,690 read and 1,147 write queries;
- 5,974 rows read, 1,156 rows written;
- size 245,760 bytes (200,704 before Stage A: the new empty tables and indexes).

**Cloudflare errors:** none. The deploy and every request answered as expected.

**Pending owner verification** (needs the dashboard passphrase, not used here):
- Engine → Strategy Mirror shows **"The Strategy Mirror has not reported yet"**. This is expected: the production
  engine is not mirror-capable until Stage C.
- Settings → Execution costs = "No execution costs".
- Portfolio consistency OK.

## Next

**Stage C (new pinned engine release, `ENGINE_MIRROR=on`, one controlled restart) is recommended** and awaits its own
approval (`STRATEGY-MIRROR-ROLLOUT-PLAN.md`). Run it at a time when the PC stays on.

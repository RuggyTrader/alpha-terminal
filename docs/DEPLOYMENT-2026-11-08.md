# Production deployment 2026-11-08 (PAPER-only)

**Status: PARTIAL.** The website, API, migration and portfolio are live and verified. Two things stop PAPER trades
in production, and only you can fix them (both need secrets that must not pass through chat):

1. **Alpaca PAPER keys are rejected** (`BROKER_AUTH_FAILED`). This was already true before this deploy: the broker
   code (`src/trade_core.ts`) and the stored secrets are unchanged since the previous version. Every BUY/SELL/CLOSE
   signal reads the Alpaca PAPER account first, so every signal is currently refused.
2. **The engine is not connected**: it needs the production `WEBHOOK_SECRET`.

## What was deployed

| | |
|---|---|
| Worker | `alpha-terminal-api`, https://alpha-terminal-api.mattledger787.workers.dev (unchanged address) |
| Code | commit `361c030` (`v1.2.0-cloudflare`); frontend build `index-BrQhJohL.js` / `index-BTfLUsZ3.css` |
| New version | `a1ab344a-388e-4840-956f-d19a3db9f1ce` (2026-11-08 ~21:55 UTC) |
| Previous version (rollback target) | `1d551619-e4aa-4727-8b43-eef8ad91deca` (2026-11-01 23:26 UTC, built from about `8bf5cbc`) |
| D1 | `alpha-terminal-db` `40741873-0a98-4b23-b4e2-19ac8acec80c` |
| Bindings | `ENABLE_TRADING "false"`, `SHORT_SELLING_ENABLED "false"`, limits unchanged |
| Plan | Cloudflare Free; nothing purchased |

## Before deploying

- One account; wrangler has D1 and Workers write access. The D1 ID matches `wrangler.jsonc`.
- Pending migrations: `0003_paper_portfolio.sql` only.
- Secrets present (names only): `ADMIN_SECRET`, `ALPACA_KEY`, `ALPACA_SECRET`, `DASHBOARD_PASSPHRASE`,
  `WEBHOOK_SECRET`.
- Production data: schema 2, 10 alerts, 4 dry-run orders (none sent to a broker), 8 risk decisions, **0 positions,
  0 fills, 0 trades**. No portfolio tables, so no funded position could exist.
- Code: the only broker host is `paper-api.alpaca.markets`, GET only; no order submission.
- Tests at `361c030`: engine 50/50, Worker 124/124, frontend 81/81, demo isolation 13/13; production build and
  `wrangler deploy --dry-run` clean.

## Backup

- Time Travel bookmark: `00000024-00000000-0000511d-f001db28853f68832ff1259727df628c` (kept 7 days on Free).
- SQL export: `C:\Users\hujhj\Documents\AlphaTerminalBackups\alpha-terminal-db-20261108T214538Z-pre0003.sql`
  (outside git; contains session and trading history, keep private).
- Verified: loaded into a scratch SQLite database: same 12 tables and row counts as production, migrations
  0001-0002, schema 2, `PRAGMA integrity_check` ok.
- Rollback rehearsal against production's own code (`8bf5cbc`) on a `0003` database: works (dashboard 200,
  BUY/CLOSE accepted, no broker order). Hazard as documented: a funded position open at rollback stays reserved.

## Migration 0003

Applied 2026-11-08 ~21:50 UTC (12 statements). After: schema 3, migrations 0001-0003, the same 10 alerts, 4 orders
and 8 risk decisions, 6 wallets at $0, no entries, `SOLUSD v1 $10 PENDING`.

## Production checks after deploy

Signed out: `/health` 200 (PAPER, `enable_trading: false`); `/`, `/portfolio` serve the new build; `/api/dashboard`
and `/api/paper/fund` 401; missing site header 403; wrong webhook secret 401 on `/webhook/dry-run`,
`/webhook/engine-status`, `/webhook/engine-backtest` (`broker_request_sent: false`); wrong passphrase refused.

Signed in (the owner signed in; read-only checks, no balance changed):
- Home: PAPER portfolio "Not funded yet"; ALPHA PAPER P&L $0.00, 0 positions; engine NOT RUNNING (never reported);
  PAPER / DRY RUN / BROKER SUBMISSION OFF; the old alerts listed.
- Portfolio: allocation ring empty; Unallocated, SOL, ETH, BTC, HYPE, KAITO each $0.00; transfer and funding forms
  with passphrase; history empty; ledger check passing.
- SOL: available/reserved $0.00; risk "Pending $10.00 · v1 · waiting for the engine"; simulator "No verified
  backtest uploaded yet"; the $10 preview warns it exceeds the $0 balance.
- ETH: wallet only, "No validated strategy for this asset yet".
- API: PAPER, `DRY_RUN_ONLY`, broker submission false, consistency ok, limits $5,000 / $10,000, shorts off.

Not verified on production (need your passphrase or the engine): funding, transfers, reserve/release on a trade,
risk Apply → Applied, simulator results, STALE/OFFLINE. All are covered by local tests on the same code.

## Your steps

**A. Alpaca PAPER keys.** In the Alpaca dashboard (paper account), generate new API keys, then in your own terminal
from `worker/`: `npx wrangler secret put ALPACA_KEY` and `npx wrangler secret put ALPACA_SECRET`, pasting them
when asked. They must be PAPER keys. Reload the dashboard: the "Alpaca PAPER rejected the API keys" message goes.

**B. Engine.** `engine/.env` is prepared (git-ignored): profile `solusd-5m`, $10 risk, production address, its own
fresh state folder `engine/data/production`, sync off. Open it in an editor, paste the production
`WEBHOOK_SECRET` after `ALPHA_WEBHOOK_SECRET=` and set `ENGINE_SYNC=on`. If you no longer have that value, setting a
new one (`npx wrangler secret put WEBHOOK_SECRET`) also changes what your TradingView alerts must send. Then:

```bash
cd engine
node src/cli/run.mjs --once
npm start
```

The `--once` run warms up, sends its first heartbeat and confirms the $10 setting (v1 becomes Applied); check the
dashboard shows ONLINE. Then `npm start` runs it continuously (only one copy can run per data folder).
Optionally upload the simulator's backtest with the same settings:
`node src/cli/simulate.mjs --candles data/SOLUSD-5m-25d.json --profile solusd-5m --history-from 2026-10-19T00:00:00Z --upload`
(the same history start as the matched TradingView benchmark).

**C. iPhone.** The checklist in `docs/DEPLOYMENT-READINESS.md`.

## Rollback

`npx wrangler rollback 1d551619-e4aa-4727-8b43-eef8ad91deca` (only while no funded position is open). The database
stays on `0003`. Database restore only if data is wrong: the bookmark above (deletes everything written since).

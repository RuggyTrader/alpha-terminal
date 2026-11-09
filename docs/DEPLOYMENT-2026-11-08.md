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

## Update 2026-11-09 ~00:00 UTC: `a8b06db` (ALPHA PAPER risk from D1)

Authorized by the owner. Production now runs **`b1c87441-bc4f-47b5-8f8c-7e3f8235228b`** (commit `a8b06db`, message
"ALPHA TERMINAL a8b06db ALPHA PAPER risk from D1 (PAPER-only)"). **Rollback target: `a1ab344a-388e-4840-956f-d19a3db9f1ce`**
(`361c030`): `npx wrangler rollback a1ab344a-388e-4840-956f-d19a3db9f1ce`; safe with or without funded positions (see
`docs/ENGINE-SYNC-SETUP.md`), but that version needs working Alpaca keys for every signal.

- Before: same account and D1; production at `a1ab344a`; 0 positions (open or closed), all six wallets $0, no
  funding entries, no broker orders, SOL v1 $10 PENDING. No migration pending (schema 3).
- Backup: Time Travel bookmark `00000027-00000006-0000511d-7f6e7eabf45b7ae593c0e921c8b80082`; export
  `C:\Users\hujhj\Documents\AlphaTerminalBackups\alpha-terminal-db-20261108T235554Z-pre-a8b06db.sql`
  (sha256 `a5aaad8d…c103`), loaded into scratch SQLite: 16 tables, counts equal production, migrations 0001-0003,
  integrity ok.
- Change versus production: 5 Worker source files only (`index.ts`, `paper_ledger.ts`, `portfolio.ts`,
  `trade_core.ts`, `webhook_dry_run.ts`); frontend build identical (`index-BrQhJohL.js`); `wrangler.jsonc` and
  migrations unchanged. Bindings: `ENABLE_TRADING "false"`, `SHORT_SELLING_ENABLED "false"`, limits unchanged.
- After: `/health` `mode PAPER`, `enable_trading: false`, **`alpha_paper_account: "D1"`**, database connected.
  Signed out: dashboard and PAPER actions 401, webhooks with a wrong secret 401 (`broker_request_sent: false`).
  Signed in (read-only): portfolio $0 in all six balances, consistency OK, limits $5,000 / $10,000, shorts off;
  SOL "Pending $10.00 · v1 · waiting for the engine"; simulator "No verified backtest uploaded yet"; engine
  NOT_RUNNING. D1 unchanged by the deploy (10 alerts, 4 orders, 0 fills, positions, entries, trades).
- Not exercised in production (by design, no PAPER trade was created): a signal through the D1 risk account. It is
  covered by the local tests with Alpaca keys blank. The stored Alpaca keys (`alpaca_configured: true`) are still
  rejected by Alpaca; ALPHA PAPER does not read them; only the optional broker panel shows the error.
- Not done (separate steps): webhook secret rotation, engine sync, funding.

## Update 2026-11-09 ~03:15 UTC: `cde07af` (verified performance UI, read-only proof routes)

Approved by the owner. Production now runs **`2cd0119d-0336-431e-98c9-2163ed4f2b29`** (commit `cde07af`, message
"ALPHA TERMINAL cde07af verified performance UI + read-only proof routes (PAPER-only)"). **Rollback target:
`8077719f-c6fb-45a8-82ba-9260f78f12a3`** (`a8b06db` code with the current secret): `npx wrangler rollback
8077719f-c6fb-45a8-82ba-9260f78f12a3`. The frontend is served from the Worker's static assets (`assets.directory`
`../frontend/dist` in `wrangler.jsonc`), so the same command rolls back the frontend too. No data change either way.

- Before: same account and D1; production `8077719f`, bundle `index-BrQhJohL.js`; no pending migration; secrets
  ADMIN_SECRET, ALPACA_KEY, ALPACA_SECRET, DASHBOARD_PASSPHRASE, WEBHOOK_SECRET (names only).
- Backup: Time Travel bookmark `00000028-000000b0-0000511e-b52d160f2041969983baf77087537190`; export
  `C:\Users\hujhj\Documents\AlphaTerminalBackups\alpha-terminal-db-20261109T031419Z-pre-cde07af.sql`
  (sha256 `d5d25245…7628d50`), loaded into scratch SQLite: integrity ok, migrations 0001-0003, counts equal
  production (10 alerts, 8 risk decisions, 4 intents, 0 fills/positions/trades/entries, wallets $0, SOL v1 $10
  APPLIED, 1 backtest).
- Change versus production: Worker `dashboard_api.ts` (GET `/api/dashboard/performance`, `/api/dashboard/trade-proof`,
  SELECT only) and `portfolio.ts` (read-only limits display); frontend redesign. `wrangler.jsonc`, migrations,
  trading logic, limits and strategy inputs unchanged. Fresh frontend build `index-C5DZ1x4O.js` / `index-hWuUg80P.css`.
- Tests at `cde07af`: engine 80/80, Worker 148/148, frontend 92/92, demo 13/13, typecheck (pre-existing index.ts
  warning only), build and dry run clean.
- After: new bundle served; `/health` PAPER, `enable_trading: false`, D1 connected; signed out: dashboard,
  performance, trade proof and PAPER actions 401, wrong webhook secret refused. D1 counts and all six balances
  unchanged. Engine (PC, supervisor 28032 / engine 4260, not restarted) polled after the deploy, ledger check OK.
- Signed in at 402 × 874 and 1280 × 860: Home (Verified P&L $0.00, return / win rate N/A, 0 closed trades, ENGINE
  ONLINE; CRYPTO ACTIVE Kraken, STOCKS NOT CONFIGURED; System Health all HEALTHY, live execution DISABLED),
  Verified Performance ("NOT ENOUGH VERIFIED TRADING HISTORY", 0 verified trades, 0 excluded), Trades (history empty),
  Trade Proof (route answers; no trades exist yet), Engine, Activity, Settings (8 groups), SOL strategy: no
  horizontal overflow, no error states. The engine's own simulation (18 trades, +$16.33) is shown only as "Engine
  simulation · not verified" and is not counted anywhere.

# Deployment readiness: PAPER-only website on Cloudflare Free (2026-11-08)

**Assessment: ready for a controlled PAPER-only deployment once you complete the pre-deploy checks below.** Nothing
has been deployed. The local 24-hour observation passed (`docs/OBSERVATION-2026-11-07.md`) and all suites pass at
the commit that adds this file. The iPhone checks can only be done after deployment, on the real HTTPS site.

Scope: the existing Worker `alpha-terminal-api` (API + dashboard assets, one origin) and its D1 `alpha-terminal-db`,
on the Cloudflare Free plan. `ENABLE_TRADING` stays `"false"`; there is no broker order path. The OTE engine keeps
running on your PC and reports to the Worker; no VPS.

## Evidence

| Check | Result |
|---|---|
| 24 h observation (local) | PASS: 26 h 20 m, no downtime, 0 missing/duplicate candles, 0 OHLC differences vs Kraken, 0 restarts |
| Engine tests | 50/50 (includes the TradingView settings and benchmark lock-in) |
| Worker tests | 124/124 (portfolio, concurrent fills, migrations, engine sync incl. a funded-portfolio replay of real candles) |
| Frontend | 81/81, typecheck clean |
| Demo isolation | 13/13 |
| `ENABLE_TRADING` in `worker/wrangler.jsonc` | `"false"` |
| Migration `0003` on existing rows | tested (`worker/test/migrations.test.mjs`) |
| Rollback of Worker code to the pre-portfolio version on a `0003` database | rehearsed locally, see "Rollback" |

## Migration 0003

`0003_paper_portfolio.sql` only adds: four tables (`portfolio_wallets`, `portfolio_entries`, `strategy_settings`,
`backtest_results`), two columns on `paper_positions` (`wallet` nullable, `reserved_micro` default 0), seed rows
with `INSERT OR IGNORE`, and `schema_version = 3`. It drops, rewrites or deletes nothing. Existing positions stay
outside the portfolio (`wallet` NULL). Wallets start at $0; nothing is funded until you do it on the website.

Apply it **before** deploying the new code (the new code reads the new tables).

## Pre-deploy checks (yours, in your own terminal, from `worker/`)

1. `npx wrangler whoami`: the intended Cloudflare account, Free plan.
2. `npx wrangler deployments list`: note the **current version ID**. This is the rollback target.
3. `npx wrangler d1 migrations list alpha-terminal-db --remote`: expected unapplied: `0003` only (also `0002` if
   production predates the ALPHA PAPER ledger; both are additive). Stop if anything else is listed.
4. Secrets present: `npx wrangler secret list` shows `DASHBOARD_PASSPHRASE`, `ADMIN_SECRET`, `WEBHOOK_SECRET` (and
   the Alpaca **PAPER** keys if used). Never paste their values into chat.

## Backup (immediately before the migration)

1. Time Travel bookmark (point-in-time restore, kept 7 days on the Free plan):
   `npx wrangler d1 time-travel info alpha-terminal-db`. Save the bookmark it prints.
2. File export (kept as long as you keep the file):
   `npx wrangler d1 export alpha-terminal-db --remote --output ../backups/alpha-terminal-db-<date>-pre0003.sql`.
   Keep it out of git (it holds your trading history). The export briefly blocks the database while it runs.

## Deploy (when you authorise it)

```bash
npm --prefix ../frontend ci
npm --prefix ../frontend run build
npx wrangler d1 migrations apply alpha-terminal-db --remote
npx wrangler deploy --dry-run        # bindings: ENABLE_TRADING must read "false"
npx wrangler deploy
```

Immediately after: `/health` 200; sign in on desktop; the Portfolio page shows "Not funded yet" and the ledger
check passes; the engine on the PC shows ONLINE within one candle; the SOL risk setting shows v1 $10 "Applied".

## Rollback

**Code:** `npx wrangler rollback <version ID from pre-deploy step 2>`. Keep the database on `0003`: the rehearsal
showed the pre-portfolio Worker (`69b3b09`) runs normally on a `0003` database (dashboard 200, BUY/CLOSE accepted,
trades recorded, no broker order).

**Rule: before a code rollback, the portfolio must have no open funded position.** In the rehearsal, a position
opened by the new code from the funded SOL balance was closed by the old code. The old code knows nothing about
wallets, so the $89.25 reservation was never released and the realized P&L was not credited. After rolling forward
again, the dashboard correctly shows "Ledger check failed: SOLUSD: reserved differs from its open positions", and
there is no in-app repair. Either roll back while flat (or before funding at all), or restore the database (below).

**Database:** only if the data itself is wrong. `npx wrangler d1 time-travel restore alpha-terminal-db --bookmark
<saved bookmark>` returns the whole database to that moment, deleting everything written since (alerts, fills,
trades, funding). Restoring to before `0003` also requires rolling the code back first, because the new code needs
the new tables. The `.sql` export is the fallback beyond 7 days.

## Free plan fit

Workers Free allows 100,000 requests a day. One dashboard tab left open polls every 7 s (about 12,300 a day). The
engine sends about 2,900 heartbeats a day plus a few signals. Comfortable for one user. Watch in the Cloudflare
dashboard during the first days: Worker CPU time per request (Free limit 10 ms) and D1 rows read per day (Free limit
5 million). The dashboard endpoint reads several tables on every poll, and neither figure can be measured locally.

## Physical iPhone verification (after deploy, on the real HTTPS URL)

1. Sign in, close Safari fully, reopen: still signed in (Secure, HttpOnly, SameSite=Strict cookie); sign out works
   and shows signed out only after the server confirms.
2. Home, Portfolio, SOL strategy page: no sideways scrolling; the bottom navigation clears the home indicator in
   portrait and landscape; nothing hides under the notch or Dynamic Island.
3. Tapping an amount field opens the decimal keypad and does not zoom the page.
4. Passphrase fields: Safari/iCloud Keychain autofill does not submit anything by itself; a wrong passphrase shows
   the error and does **not** sign you out.
5. Fund $100 PAPER; transfer $20 to SOL; try to transfer more than SOL holds (refused with the reason); the pie and
   history update; double-tapping Submit applies once.
6. Risk per trade: change $10 to $12, preview updates as you type; Apply shows Pending, then Applied after the PC
   engine confirms (within about a minute while it runs). Set it back to $10 the same way if wanted.
7. Turn on Airplane mode for a minute: the dashboard shows the connection problem, then recovers without signing
   out. Lock the phone for 10+ minutes and return: data refreshes.
8. With the PC engine stopped for over 12 minutes: STALE; over 30 minutes: OFFLINE.
9. Add to Home Screen: icon and name correct; opens signed in.

## Known limitations at deployment (not blockers for a PAPER website)

- ALPHA PAPER is long-only: about half the strategy's trades (shorts) are refused, so ledger results are not the
  strategy's results.
- At $10 risk, tight stops produce orders above the $5,000 order limit (2 of 3 longs in the observation).
- Ledger fills use Kraken's price when the signal arrives (about 5 s after the candle), not the strategy's limit or
  stop price, so P&L differs per trade.
- The engine runs on your PC: when the PC is off (it has powered off most evenings), the website shows the engine
  STALE then OFFLINE and no signals are processed.
- The $25K figure from the TradingView report is still unexplained.

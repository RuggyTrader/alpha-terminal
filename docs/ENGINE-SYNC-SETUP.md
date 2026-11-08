# ALPHA PAPER without Alpaca, and secure engine sync (prepared 2026-11-08)

Not deployed. Production still runs `361c030` (version `a1ab344a-388e-4840-956f-d19a3db9f1ce`).

## What changed

**ALPHA PAPER no longer depends on Alpaca.** The dry-run webhook (`/webhook/dry-run`, used by the engine and by
TradingView alerts) used to fetch Alpaca's `/v2/account` before every signal and refused everything when that
failed. That is why production answered `BROKER_AUTH_FAILED`. Now its risk account comes from D1:

| Risk input | Before | Now (dry-run webhook) |
|---|---|---|
| Positions, exposure | ALPHA PAPER ledger | unchanged |
| Account active / not blocked | Alpaca account | the ledger (always active; D1 unreadable → 503, nothing approved) |
| Buying power | Alpaca non-marginable buying power | the symbol's strategy balance, available funds; unfunded = $0 |
| Daily loss | Alpaca equity − last equity | ALPHA PAPER P&L realized since 00:00 UTC + open unrealized at the last mark |
| Shorting | Alpaca flag | never (the ledger is long-only; `SHORT_SELLING_ENABLED` stays false) |

Unknown is refused, never assumed: a missing balance row or an open position whose last mark failed gives
`ACCOUNT_DATA_UNAVAILABLE`. Order notional ($5,000), position exposure ($10,000), total exposure ($25,000),
open positions (5) and the daily loss limit ($2,000) are enforced as before. CLOSE and position-reducing SELL
are never blocked by account checks.

**Behaviour change:** before, a BUY with an unfunded portfolio was accepted without any balance. Now an unfunded
strategy balance is $0, so the BUY is rejected `INSUFFICIENT_PAPER_CAPITAL` until you allocate PAPER capital to
it (Portfolio page: Add PAPER capital, then Transfer to SOL). Every strategy-balance BUY now reserves its position
value; the portfolio gate stays as a second check.

**Alpaca stays optional.** `/api/risk/preview`, the broker panel on the dashboard and the PAPER execution path (still
disabled, `ENABLE_TRADING=false`) use Alpaca PAPER exactly as before when keys are set. No new broker request
exists anywhere. `/health` now reports `alpha_paper_account: "D1"`.

Code: `worker/src/trade_core.ts` (`RiskAccount`, `alpacaRiskAccount`, the ledger branch of `runRiskEvaluation`),
`worker/src/paper_ledger.ts` (`ledgerAccount`), `worker/src/portfolio.ts` (reserve and gate for every strategy
balance), `worker/src/index.ts` (`/health` field). No migration.

## Tests (isolated local Workers, no Alpaca keys)

Every Worker test now starts its Worker with blank `ALPACA_KEY`/`ALPACA_SECRET`, so none of them can reach Alpaca:
`paper_ledger`, `pine_pipeline` (real Kraken prices), `portfolio` (incl. concurrent fills), `engine_sync` (the
real engine replaying real Kraken candles: funded trade, restart, forced resend, outage, STALE/OFFLINE) and two new
files:

- `paper_account.test.mjs`: real Kraken SOLUSD closes from 2026-11-05 (95.11 at 14:20, 90.37 at 15:20 UTC). BUY
  10 SOL on a $5,000 SOL balance, a failed mark blocks new entries, CLOSE returns the −$47.40 loss to the SOL
  balance, then the daily loss limit (set to $25 in this test Worker only) refuses the next BUY, and a missing
  balance row is refused.
- `sync_setup.test.mjs`: the setup tool below against a local Worker.

## Secure secret setup (you run this; it changes production)

`engine/src/cli/sync-setup.mjs` handles the secret so it never appears on screen, in a command line, in logs or in
git. It is generated in the process (32 random bytes), passed to `wrangler secret put WEBHOOK_SECRET` on stdin, and
written only to `engine/.env` (git-ignored).

**Who uses the current secret?** Production D1 shows 10 webhook alerts, all manual tests (SPY/TSLA, strategy
"TEST"/"RISK-TEST") on 2026-10-31 03:18–04:22 UTC, none since, and no engine heartbeat ever. Requests with a wrong
secret are not stored, and a TradingView alert that never fired leaves no trace, so check TradingView → Alerts for
any alert whose webhook URL is `alpha-terminal-api.mattledger787.workers.dev`. If one exists, its message must get
the new secret after rotation (or delete it).

Order (from `engine/`):

1. **Deploy this Worker first** (needs your authorization). Until then `check` fails on "Worker computes ALPHA
   PAPER risk from D1", and every engine signal would still be refused for the broken Alpaca keys.
2. `node src/cli/sync-setup.mjs rotate --confirm-no-other-clients`. This stores the new secret in Cloudflare and
   `engine/.env` (`ENGINE_SYNC` stays off), then runs the checks. Cloudflare publishes a new Worker version with
   the same code when a secret changes.
3. `node src/cli/sync-setup.mjs check`. Every line must be PASS: profile `solusd-5m`, risk $10, no engine running,
   PAPER with trading disabled, D1 account, secret accepted, engine and ledger positions match.
4. `node src/cli/sync-setup.mjs enable`. This sets `ENGINE_SYNC=on` only if every check passes.
5. Fund the SOL balance on the website (e.g. $5,000 PAPER: at $10 risk the historical positions were up to ~$8,400,
   and orders above the $5,000 limit are refused anyway).
6. `node src/cli/run.mjs --once`: one engine, warm-up, first heartbeat. The dashboard should show ONLINE and the
   SOL risk "Applied (engine confirmed) $10.00 · v1". Then `npm start` for continuous running.

The engine keeps its saved state in `engine/data/production` (empty now, so it starts flat), its lock file
prevents a second instance, and every signal id is unique, so a resend never applies twice. `check` refuses to
enable sync if the saved state holds a position the production ledger does not hold as the same entry (it would
otherwise send an unmatched CLOSE) or if production holds a position the engine did not open.

## Rollback assessment

- No schema change; production D1 stays on migration 0003.
- Rehearsed locally: this code opened a funded position, the production version `361c030` then closed it
  (reservation released, P&L credited) and opened/closed another; this code again: consistency check OK.
  Rolling back is therefore safe with or without open funded positions between these two versions.
- After a rollback, production again needs Alpaca for every signal, so with the current keys every signal is
  refused (`BROKER_AUTH_FAILED`) until rolled forward or valid PAPER keys are set.
- After any rollback or redeploy, run `node src/cli/sync-setup.mjs check`; if the secret is no longer accepted,
  stop the engine and run `rotate` again.
- Command: `npx wrangler rollback a1ab344a-388e-4840-956f-d19a3db9f1ce` (from `worker/`).

## Not changed

Strategy settings and the `solusd-5m` profile, risk limits, `ENABLE_TRADING=false`, short selling disabled, the
Cloudflare plan. Nothing was deployed and no secret was changed.

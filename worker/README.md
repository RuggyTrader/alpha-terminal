# ALPHA TERMINAL — Cloudflare Worker (v1.2.0, PAPER · DRY RUN)

The Worker handles TradingView dry-run webhooks, the PAPER risk engine, D1 persistence
and the read-only dashboard API. It also serves the dashboard itself (`../frontend/dist`)
so the page and the API share one origin.

**PAPER only. DRY RUN only.** `ENABLE_TRADING` stays `"false"` in `wrangler.jsonc`.
No code path sends a POST to Alpaca; broker access is GET-only (account, positions,
clock, latest price).

## Dashboard sign-in

Two separate Worker secrets:

| Secret | Used by | Grants |
|---|---|---|
| `DASHBOARD_PASSPHRASE` | the dashboard sign-in screen, `/auth/login` only | a read-only browser session |
| `ADMIN_SECRET` | admin scripts, as the `x-admin-secret` header | engine controls, kill switch, broker, risk preview, dry-run admin routes, dashboard API |

`/auth/login` never accepts `ADMIN_SECRET`; if `DASHBOARD_PASSPHRASE` is not set it returns
`503 AUTH_NOT_CONFIGURED`. Use two different long random values.

| Route | Method | Purpose |
|---|---|---|
| `/auth/login` | POST `{"passphrase": "...", "remember_device": false}` | compares with `DASHBOARD_PASSPHRASE` server-side, sets the session cookie |
| `/auth/session` | GET | 200 when signed in, 401 otherwise |
| `/auth/logout` | POST | deletes the session and clears the cookie |

* Cookie `at_session`: `HttpOnly; Secure; SameSite=Strict; Path=/`, host-only. Lifetime 12 hours, or 30 days when
  the user ticks **Remember this device** (`"remember_device": true`; anything other than boolean `true` means 12 hours).
  A remembered session has exactly the same read-only permissions; logout or expiry ends it.
* Only a SHA-256 hash of the token is stored (D1 `auth_sessions`).
* `/auth/login` and `/auth/logout` require the `X-Alpha-Terminal: 1` header and a same-origin
  `Origin` (or one listed in the optional `DASHBOARD_ORIGINS` var, for local development).
* 5 wrong passphrases per IP in 15 minutes → `429` (tracked in `app_meta`).
* **A browser session is read-only.** It unlocks `GET /api/dashboard*` only. Engine controls,
  the kill switch, `/api/broker/*`, `/api/risk/preview` and `/api/dry-run/*` still need the
  `x-admin-secret` header, and webhooks need `WEBHOOK_SECRET`, so the browser cannot change
  execution state. The header still works for scripts on every admin route.
* The dashboard never sends, stores or compares `ADMIN_SECRET`. Neither secret is in the
  bundle, browser storage, URLs or client env vars; the cookie is not readable by JavaScript.
* Sign out only shows "signed out" after `/auth/logout` succeeds. If it fails, the dashboard
  says the server session may still be active and offers a retry.

## Local development

```bash
cd worker
npx wrangler d1 migrations apply alpha-terminal-db --local
# create worker/.dev.vars (git-ignored) with DASHBOARD_PASSPHRASE, ADMIN_SECRET,
# WEBHOOK_SECRET and DASHBOARD_ORIGINS=http://localhost:5173 ; leave Alpaca keys out
# unless testing PAPER
npx wrangler dev --local --port 8787
```

Then either open http://127.0.0.1:8787 (after `npm --prefix ../frontend run build`), or run
`npm run dev` in `frontend/` and open http://localhost:5173 (Vite proxies `/api`, `/auth`,
`/engine`, `/kill`, `/health` to port 8787).

## Deploy

```bash
npm --prefix ../frontend ci
npm --prefix ../frontend run build      # assets must exist before deploying
npx wrangler deploy --dry-run           # check bindings: ENABLE_TRADING must read "false"
npx wrangler deploy
```

Secrets are set with `npx wrangler secret put DASHBOARD_PASSPHRASE` and
`npx wrangler secret put ADMIN_SECRET` (plus `WEBHOOK_SECRET`, `ALPACA_KEY`, `ALPACA_SECRET`
for Alpaca **PAPER** keys), typed into your own terminal. `DASHBOARD_PASSPHRASE` is a secret,
not a `vars` entry in `wrangler.jsonc`.
Never put them in `wrangler.jsonc`, the frontend or chat.

If Cloudflare Access protects the dashboard hostname, exclude `/webhook*` from the Access
policy so TradingView can still reach it.

## Instruments

`src/instruments.ts` is the instrument list: MES, MNQ, GOLD, BTCUSD, ETHUSD, SOLUSD, HYPEUSD and KAITOUSD
(`ALLOWED_SYMBOLS` must list the same symbols). For each one it records the truthful reference-price source and
whether Alpaca PAPER can hold a position:

| Symbol | Price for risk notional | Position read from |
|---|---|---|
| BTCUSD, ETHUSD, SOLUSD, HYPEUSD | Kraken public ticker (GET, no key) | Alpaca PAPER |
| KAITOUSD | Kraken public ticker | none (Alpaca does not list KAITO) |
| MES, MNQ | none: no licensed CME feed configured | none |
| GOLD | none: no spot-gold feed; Alpaca's `GOLD` is a stock and is never used | none |

Without a price, BUY and SELL are rejected `MARKET_DATA_UNAVAILABLE` with that reason; nothing is estimated.
Sources were checked on 2026-11-01; adding a futures or gold feed means adding a source in `instruments.ts`.

### Risk rules by asset class

| Rule | Crypto, gold (cash assets) | MES, MNQ (futures) |
|---|---|---|
| Quantity | up to 8 decimals | whole contracts; `MAX_ORDER_QTY` (10) caps contracts per order |
| Order size | `MAX_ORDER_NOTIONAL` ($5,000) on qty × price | `MAX_FUTURES_ORDER_NOTIONAL` ($75,000) on contracts × price × point value ($5 MES, $2 MNQ) |
| Position / total exposure | `MAX_POSITION_EXPOSURE`, `MAX_TOTAL_EXPOSURE` | not applied (cash measures) |
| Buying power | Alpaca PAPER (crypto: non-marginable) | not applied: no PAPER broker holds futures, so no margin is modelled |
| Account active, open positions, daily loss | applied | applied |

$75,000 allows one MES (about $38,000 at 7,600) or one MNQ per order; two MES (about $76,000) exceed it. Raise
`MAX_FUTURES_ORDER_NOTIONAL` to allow more. If `MAX_FUTURES_ORDER_NOTIONAL`
is missing or not positive, futures orders are rejected. Today no futures feed exists, so MES/MNQ never reach
this rule: they stop at `MARKET_DATA_UNAVAILABLE`.

## Known gaps

* An accepted DRY-RUN intent does not create an internal PAPER position or trade. Positions shown on the
  dashboard and used by risk come only from the Alpaca PAPER account, so a later CLOSE for a dry-run BUY returns
  `NO_POSITION`, and exposure limits do not count earlier dry-run intents.

* The Worker does not yet write `trades` or `activity_events`, so those dashboard panels show
  empty states until a later phase records them.
* `return_pct` in `trades` is displayed as a percentage value.

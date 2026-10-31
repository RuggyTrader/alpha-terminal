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

## Known gaps

* The Worker does not yet write `trades` or `activity_events`, so those dashboard panels show
  empty states until a later phase records them.
* `return_pct` in `trades` is displayed as a percentage value.

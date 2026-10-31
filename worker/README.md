# ALPHA TERMINAL — Cloudflare Worker (v1.2.0, PAPER · DRY RUN)

The Worker handles TradingView dry-run webhooks, the PAPER risk engine, D1 persistence
and the read-only dashboard API. It also serves the dashboard itself (`../frontend/dist`)
so the page and the API share one origin.

**PAPER only. DRY RUN only.** `ENABLE_TRADING` stays `"false"` in `wrangler.jsonc`.
No code path sends a POST to Alpaca; broker access is GET-only (account, positions,
clock, latest price).

## Dashboard sign-in

| Route | Method | Purpose |
|---|---|---|
| `/auth/login` | POST `{"passphrase": "..."}` | compares with `ADMIN_SECRET` server-side, sets the session cookie |
| `/auth/session` | GET | 200 when signed in, 401 otherwise |
| `/auth/logout` | POST | deletes the session and clears the cookie |

* Cookie `at_session`: `HttpOnly; Secure; SameSite=Strict; Path=/`, 12 hours, host-only.
* Only a SHA-256 hash of the token is stored (D1 `auth_sessions`).
* `/auth/login` and `/auth/logout` require the `X-Alpha-Terminal: 1` header and a same-origin
  `Origin` (or one listed in the optional `DASHBOARD_ORIGINS` var, for local development).
* 5 wrong passphrases per IP in 15 minutes → `429` (tracked in `app_meta`).
* **A browser session is read-only.** It unlocks `GET /api/dashboard*` only. Engine controls,
  the kill switch and `/api/broker/*` still need the `x-admin-secret` header, so the browser
  cannot change execution state. The header still works for scripts on every admin route.
* The browser never receives `ADMIN_SECRET`: it is not in the bundle, storage, URLs or env vars.

## Local development

```bash
cd worker
npx wrangler d1 migrations apply alpha-terminal-db --local
# create worker/.dev.vars (git-ignored) with ADMIN_SECRET, WEBHOOK_SECRET and
# DASHBOARD_ORIGINS=http://localhost:5173 ; leave Alpaca keys out unless testing PAPER
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

Secrets are set with `npx wrangler secret put ADMIN_SECRET` (and `WEBHOOK_SECRET`,
`ALPACA_KEY`, `ALPACA_SECRET` for Alpaca **PAPER** keys), typed into your own terminal.
Never put them in `wrangler.jsonc`, the frontend or chat.

If Cloudflare Access protects the dashboard hostname, exclude `/webhook*` from the Access
policy so TradingView can still reach it.

## Known gaps

* The Worker does not yet write `trades` or `activity_events`, so those dashboard panels show
  empty states until a later phase records them.
* `return_pct` in `trades` is displayed as a percentage value.

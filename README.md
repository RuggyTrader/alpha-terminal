# ALPHA TERMINAL — STOCKS + CRYPTO PAPER TRADING · `PAPER DESK`

Version **1.1.0** — redesigned mobile-first dashboard (see [docs/UI.md](docs/UI.md)); backend trading logic unchanged from 1.0.0.

A private, always-online middleman between **TradingView alerts** and **Alpaca PAPER trading**, with a mobile-first
dashboard (installable as an iPhone Home Screen app).

```
TradingView strategy alert
  → POST https://api.mydomain.com/webhook   (public, HTTPS)
  → webhook secret → JSON validation → persistent duplicate guard
  → engine state / kill switch → risk + position checks
  → Alpaca PAPER order (deterministic client_order_id)
  → SQLite on a persistent volume
  → private dashboard at https://terminal.mydomain.com
```

> **PAPER ONLY.** The only Alpaca trading host in this codebase is `https://paper-api.alpaca.markets`, hard-coded in
> `backend/alpha_terminal/config.py`. There is no live mode, no toggle, no wallet, no transaction signing, no deposits or
> withdrawals. If `APCA_API_BASE_URL` / `ALPACA_BASE_URL` / `ALPACA_ENDPOINT` is set to anything else the server
> refuses to start. **The engine always boots `STOPPED`.** Crypto is shown as `NOT CONFIGURED` because there is no crypto
> broker or data integration yet.

---

## Contents
1. [Prerequisites](#1-prerequisites) · 2. [Install](#2-cloning--installing) · 3. [Backend](#3-backend-setup) ·
4. [Frontend](#4-frontend-setup) · 5. [Alpaca PAPER keys](#5-creating-alpaca-paper-keys) ·
6. [Environment](#6-environment-variables) · 7. [Database](#7-database-setup) · 8. [Run locally](#8-running-locally) ·
9. [Log in](#9-logging-into-the-dashboard) · 10. [Manual webhook test](#10-testing-the-webhook-manually) ·
11–14. [TradingView alerts](#11-creating-tradingview-alerts) · 15. [Duplicates](#15-testing-duplicate-protection) ·
16–19. [Engine & kill switch](#16-starting-the-engine) · 20. [Confirm an order](#20-confirming-an-alpaca-paper-order) ·
21–27. [Deploy](#21-deploying-the-backend-flyio) · 28. [Logs](#28-checking-logs) ·
29. [Troubleshooting](#29-troubleshooting) · 30. [PAPER-only check](#30-confirming-paper-only-operation) ·
[Architecture](#architecture) · [Dashboard UI](#dashboard-ui) · [Cookies & CORS](#cookies-cors-and-domains) · [PWA install](#installing-on-iphone-pwa) · [Calculations](docs/CALCULATIONS.md)

---

## 1. Prerequisites
* Python **3.11+** (developed with 3.12), Node.js **20+** (developed with 24), Git.
* An Alpaca account (free) with a **Paper Trading** account.
* TradingView plan that supports **webhook alerts**, with **2-factor authentication enabled** (TradingView requires 2FA for webhooks).
* For hosting: a [Fly.io](https://fly.io) account (backend), a [Cloudflare](https://cloudflare.com) account (DNS, frontend
  hosting on Pages, Access), and a domain you own.

## 2. Cloning / installing
```bash
git clone <your-repo-url> alpha-terminal
cd alpha-terminal
python -m venv .venv
```
Activate the venv: `source .venv/bin/activate` (macOS/Linux) or `.venv\Scripts\activate` (Windows).

## 3. Backend setup
```bash
pip install -r backend/requirements-dev.txt
cp .env.example .env        # then edit .env (section 6)
```

## 4. Frontend setup
```bash
cd frontend
npm install
```

## 5. Creating Alpaca PAPER keys
1. Sign in at <https://app.alpaca.markets>.
2. Switch the account selector (top left) to your **Paper** account.
3. On the Paper dashboard, under **API Keys**, click **Generate New Keys** (or Regenerate).
4. Copy the **Key ID** into `ALPACA_KEY` and the **Secret Key** into `ALPACA_SECRET`. The secret is shown once.

Paper keys only work against the paper host. Keys from a funded account will be rejected by the paper host (401), and this
app never contacts any other trading host.

## 6. Environment variables
All are **server-side only** (backend `.env` locally, `fly secrets` in production). The frontend never sees them.

| Variable | Required | Meaning |
|---|---|---|
| `ALPACA_KEY`, `ALPACA_SECRET` | yes | Alpaca **PAPER** API key pair |
| `WEBHOOK_SECRET` | yes | shared secret TradingView includes in each alert body (≥ 32 random chars) |
| `ADMIN_SECRET` | yes | dashboard passphrase; also accepted as `Authorization: Bearer` for scripts (≥ 24 random chars) |
| `ENABLE_TRADING` | yes | `false` (default): the engine cannot START and no order is ever submitted |
| `DATABASE_URL` | no | default `sqlite:///backend/data/alpha_terminal.db`; production `sqlite:////data/alpha_terminal.db` |
| `ALLOWED_SYMBOLS` | no | whitelist, default `SPY,QQQ,AAPL,NVDA` |
| `MAX_ORDER_QTY` / `MAX_ORDER_NOTIONAL` | no | per-order limits (default 10 shares / $5,000) |
| `MAX_POSITION_EXPOSURE` / `MAX_TOTAL_EXPOSURE` | no | default $10,000 / $25,000 |
| `MAX_OPEN_POSITIONS` | no | default 5 |
| `SHORT_SELLING_ENABLED` | no | default `false` |
| `ALLOW_FRACTIONAL_QTY` | no | default `false` (whole shares only) |
| `DAILY_LOSS_LIMIT` | no | default 2000; blocks new exposure once today's PAPER P&L ≤ −limit; 0 disables |
| `PAPER_STARTING_EQUITY` | no | fixed baseline for return %; otherwise captured at first connection |
| `FRONTEND_ORIGINS` | yes (prod) | e.g. `https://terminal.mydomain.com` (CORS + CSRF origin check) |
| `PUBLIC_API_BASE_URL` | yes (prod) | e.g. `https://api.mydomain.com` (used to display the webhook URL) |
| `COOKIE_SECURE` | prod `true` | `false` only for local http |
| `TRUST_PROXY_HEADERS` | prod `true` | trust `Fly-Client-IP` / `CF-Connecting-IP` for rate limiting |
| `TRADINGVIEW_IP_ALLOWLIST` | no | optional: `52.89.214.238,34.212.75.30,54.218.53.128,52.32.178.7` (TradingView's published senders) |
| `WEBHOOK_RATE_LIMIT_PER_MINUTE` | no | per source IP, default 60 (TradingView itself stops an alert that fires > 15 times in 3 minutes) |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | no | default 5 |
| `BROKER_TIMEOUT_SECONDS` | no | default 2.5 (TradingView cancels webhooks that take > 3 s) |
| `ORDER_SYNC_INTERVAL_SECONDS` | no | how often open orders are refreshed from Alpaca, default 15 |
| `ENABLE_API_DOCS` | no | `false`; `true` exposes `/docs` (local debugging only) |

Generate secrets:
```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

## 7. Database setup
SQLite, created automatically on start. To create/check explicitly (from `backend/`):
```bash
python -m alpha_terminal.manage init-db
python -m alpha_terminal.manage check-db      # tables, PRAGMA integrity_check, UNIQUE(alert_id) guard
python -m alpha_terminal.manage check-config  # prints which settings are configured, never values
```
Tables: `alerts` (UNIQUE `alert_id` = persistent duplicate guard), `risk_decisions`, `orders` (UNIQUE `client_order_id`),
`trades` (derived ledger), `activity_events`, `engine_state`, `app_meta` (counters, baseline), `auth_sessions` (hashed tokens).
No secrets are stored; the webhook `secret` field is removed from payloads before they are saved.

## 8. Running locally
Terminal 1 — backend (from `backend/`):
```bash
python -m uvicorn alpha_terminal.main:create_app --factory --port 8000
```
Terminal 2 — frontend (from `frontend/`):
```bash
npm run dev
```
Open <http://localhost:5173>. Vite proxies `/api`, `/auth`, `/engine`, `/kill`, `/health` to the backend, so the session
cookie is same-origin. Set `COOKIE_SECURE=false` in `.env` for local http.

## 9. Logging into the dashboard
Enter `ADMIN_SECRET` on the sign-in screen. The server compares it in constant time and sets an `HttpOnly; Secure;
SameSite=Strict` session cookie (12 h by default). The secret is never stored in the browser. **SETTINGS → LOG OUT** ends
the session server-side.

## 10. Testing the webhook manually
```bash
curl -i -X POST http://localhost:8000/webhook \
  -H "Content-Type: application/json" \
  -d '{"secret":"YOUR_WEBHOOK_SECRET","id":"manual-test-1","symbol":"SPY","action":"buy","qty":1,"strategy":"OTE"}'
```
With the engine STOPPED you get `403 ENGINE_STOPPED`. Send the same body again → `200 DUPLICATE`. Use a new `id` for each new test.

Response format (every webhook / control response):
```json
{"ok": false, "status": "rejected", "code": "ENGINE_STOPPED", "message": "...", "alert_id": "manual-test-1", "data": null}
```

| HTTP | `code` | When |
|---|---|---|
| 200 | `ACCEPTED` | PAPER order submitted; `data.order_status` is Alpaca's real status (`filled`, `accepted`, `new`…) |
| 200 | `DUPLICATE` | `id` already processed; nothing submitted |
| 400 | `INVALID_JSON`, `MISSING_FIELD`, `INVALID_ALERT_ID`, `INVALID_ACTION`, `INVALID_SYMBOL`, `INVALID_QUANTITY`, `UNSUPPORTED_ORDER_TYPE`, `UNSUPPORTED_TIME_IN_FORCE` | validation |
| 401 | `UNAUTHORIZED` | wrong/missing secret (alert is **not** recorded, so it cannot burn an id) |
| 403 | `ENGINE_STOPPED`, `ENGINE_PAUSED`, `KILL_SWITCH_ACTIVE`, `EXECUTION_DISABLED`, `FORBIDDEN_SOURCE` | execution gate |
| 413 | `PAYLOAD_TOO_LARGE` | body > 16 KB |
| 422 | `MAX_ORDER_QTY`, `MAX_ORDER_NOTIONAL`, `MAX_POSITION_EXPOSURE`, `MAX_TOTAL_EXPOSURE`, `MAX_OPEN_POSITIONS`, `INSUFFICIENT_BUYING_POWER`, `DAILY_LOSS_LIMIT`, `NO_POSITION`, `SELL_EXCEEDS_POSITION`, `SELL_EXCEEDS_AVAILABLE`, `SHORT_DISABLED`, `SHORT_POSITION_PRESENT`, `POSITION_LOCKED`, `ACCOUNT_RESTRICTED`, `MARKET_DATA_UNAVAILABLE`, `BROKER_REJECTED` | risk / position / Alpaca rejection |
| 429 | `RATE_LIMITED` | too many requests from one IP |
| 502 | `BROKER_UNAVAILABLE`, `BROKER_AUTH_FAILED` | Alpaca unreachable / bad keys |
| 503 | `BROKER_NOT_CONFIGURED`, `WEBHOOK_NOT_CONFIGURED` | missing server config |
| 504 | `BROKER_TIMEOUT` | Alpaca did not answer; order marked `unknown` and reconciled by `client_order_id`, **never resent** |
| 500 | `INTERNAL_ERROR` | unexpected error (logged, no details leaked) |

Every authenticated alert with an `id` is stored exactly once, including rejected ones, so a TradingView retry of a
rejected alert is also answered `DUPLICATE`.

## 11. Creating TradingView alerts
Placeholders verified against TradingView's help pages ("How to use a variable value in alert", "Strategy Alerts",
"How to configure webhook alerts"): `{{ticker}}`, `{{time}}` (bar open time, `yyyy-MM-ddTHH:mm:ssZ`), `{{timenow}}`
(fire time, same format), `{{strategy.order.action}}` (`buy`/`sell`), `{{strategy.order.contracts}}`,
`{{strategy.order.id}}`, `{{strategy.order.alert_message}}`.

Steps (any template below):
1. Open the chart → **Alerts** → **Create alert**.
2. **Condition**: your indicator/strategy. For strategies choose the order-fill condition.
3. **Notifications** tab → enable **Webhook URL** → `https://api.mydomain.com/webhook` (ports 80/443 only, no IPv6).
4. **Message**: paste one template, replacing `YOUR_WEBHOOK_SECRET`. The message must be valid JSON so TradingView sends
   `Content-Type: application/json`.
5. Keep `"symbol"` within `ALLOWED_SYMBOLS`. `{{ticker}}` gives e.g. `SPY`; an `EXCHANGE:SPY` prefix is also accepted.

**Recommended for strategies — one alert handles every fill:**
```json
{
  "secret": "YOUR_WEBHOOK_SECRET",
  "id": "{{ticker}}-{{strategy.order.id}}-{{strategy.order.action}}-{{timenow}}",
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.action}}",
  "qty": "{{strategy.order.contracts}}",
  "strategy": "OTE"
}
```
A long exit arrives as `sell` with the closed size, which reduces the long. A strategy that *reverses* (long → short in
one order) sends a `sell` larger than the position; it is rejected (`SELL_EXCEEDS_POSITION`), never turned into a short.

## 12. BUY alert setup
For an indicator/`alertcondition` alert set to **Once Per Bar Close**:
```json
{
  "secret": "YOUR_WEBHOOK_SECRET",
  "id": "{{ticker}}-{{time}}-BUY",
  "symbol": "{{ticker}}",
  "action": "buy",
  "qty": 1,
  "strategy": "OTE"
}
```

## 13. SELL alert setup
Reduces an existing long by `qty`. Rejected if you hold no long or `qty` exceeds it.
```json
{
  "secret": "YOUR_WEBHOOK_SECRET",
  "id": "{{ticker}}-{{time}}-SELL",
  "symbol": "{{ticker}}",
  "action": "sell",
  "qty": 1,
  "strategy": "OTE"
}
```

## 14. CLOSE alert setup
Flattens the whole available position (no `qty` needed). Returns `NO_POSITION` if flat. Never reverses.
```json
{
  "secret": "YOUR_WEBHOOK_SECRET",
  "id": "{{ticker}}-{{time}}-CLOSE",
  "symbol": "{{ticker}}",
  "action": "close",
  "strategy": "OTE"
}
```

**About the `id`:** `{{time}}` is the bar's open time, so a second BUY on the same bar is blocked as a duplicate (desired with
"Once Per Bar Close"). Use `{{timenow}}` when several distinct signals can fire inside one bar.

### Using `alert_message` in Pine strategies
Keep the secret in the alert box and let Pine choose the action per order:
```pine
strategy.entry("Long", strategy.long, alert_message = "buy")
strategy.close("Long", alert_message = "close")
```
Alert **Message** box:
```json
{
  "secret": "YOUR_WEBHOOK_SECRET",
  "id": "{{ticker}}-{{strategy.order.id}}-{{timenow}}",
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.alert_message}}",
  "qty": "{{strategy.order.contracts}}",
  "strategy": "OTE"
}
```
Per TradingView's Pine docs, `{{placeholders}}` cannot be used *inside* the `alert_message` argument, and an order call without
`alert_message` renders the placeholder as an empty string — this app then rejects it (`MISSING_FIELD`), it never guesses.

### Using `alert()` in Pine
`alert()` messages are built in Pine with string concatenation (`syminfo.ticker`, `str.tostring(time)`); TradingView documents
placeholder substitution for alert-box/`alertcondition` messages, not for `alert()` text, so do not rely on `{{...}}` there.
The secret would then live in your script source — never publish such a script. Create the alert on the script with the
condition that triggers on `alert()` function calls (check the exact wording in your TradingView version). Prefer the
`alert_message` approach above.

## 15. Testing duplicate protection
1. Send the curl from section 10 twice with the same `id` → second answer `200 DUPLICATE`.
2. Restart the backend and send it again → still `DUPLICATE` (the guard is a UNIQUE database column).
3. **ACTIVITY** shows `WEBHOOK Duplicate alert blocked`; **ENGINE → DUPLICATES BLOCKED** increments.
Alpaca also gets a deterministic `client_order_id` (`at-` + SHA-256 of the alert id), so even Alpaca would refuse a second
submission of the same alert.

## 16. Starting the engine
`ENABLE_TRADING=true` must be set on the server. Dashboard **ENGINE → START**, or:
```bash
curl -X POST https://api.mydomain.com/engine/start -H "Authorization: Bearer YOUR_ADMIN_SECRET"
```
The server always restarts into `STOPPED`; you must START again after every deploy/restart.

## 17. Pausing the engine
**PAUSE** (`POST /engine/pause`): alerts are still received, authenticated, de-duplicated and logged, but rejected with
`ENGINE_PAUSED`. **RESUME** (`POST /engine/resume`) returns to RUNNING.

## 18. Stopping the engine
**STOP** (`POST /engine/stop`): alerts are rejected with `ENGINE_STOPPED`. Positions are untouched.

## 19. Using the kill switch
**ENGINE → KILL SWITCH — STOP NEW ORDERS** (two taps) or `POST /kill`. It immediately blocks every new webhook order, forces
`STOPPED`, and the engine cannot START until **RESET KILL SWITCH** (`POST /kill/reset`). It does **not** close positions or
cancel open orders. Those are separate, explicit buttons under **CLOSE POSITIONS · SEPARATE ACTIONS**
(`POST /api/positions/close-all` with `{"confirm":"CLOSE ALL PAPER POSITIONS"}`, `POST /api/orders/cancel-open` with
`{"confirm":"CANCEL OPEN ORDERS"}`, per position `POST /api/positions/{SYMBOL}/close` with `{"confirm":"SYMBOL"}`).

## 20. Confirming an Alpaca PAPER order
1. **TRADES → ALERTS & ORDERS** → open the alert: shows the Alpaca PAPER order id and Alpaca's status.
2. On <https://app.alpaca.markets> (Paper account) → **Orders**: find the same order id / client order id `at-…`.
3. Outside market hours Alpaca **queues** a DAY market order (`accepted`/`new`). The webhook says
   `Market closed: … queued, not filled`, and it is only counted as a fill when Alpaca reports one (the order sync runs every 15 s).

---

## 21. Deploying the backend (Fly.io)
Fly runs the backend 24/7 with a persistent volume for SQLite (always-on, so a webhook never wakes a sleeping server). Cost is a few
dollars per month for one small machine plus a 1 GB volume; check Fly's pricing page. Exactly **one** machine: SQLite, the
execution lock and the rate limiter are per-process.

```bash
# install flyctl: https://fly.io/docs/flyctl/install/
fly auth login
cd backend
# edit fly.toml: set a unique `app` name and your FRONTEND_ORIGINS / PUBLIC_API_BASE_URL
fly apps create alpha-terminal-api-CHANGEME
fly volumes create alpha_data --region iad --size 1
fly secrets set ENABLE_TRADING=false --stage
fly deploy --ha=false
fly scale count 1
curl https://alpha-terminal-api-CHANGEME.fly.dev/health
```
Enter `ALPACA_KEY`, `ALPACA_SECRET`, `WEBHOOK_SECRET` and `ADMIN_SECRET` yourself in the Fly dashboard
(fly.io → your app → **Secrets** → Add), or with `fly secrets set` in your own terminal. Secrets stay out of the repo and out
of `fly.toml`; typing them on a command line can leave them in shell history, so the dashboard is simplest.

**First deploy keeps `ENABLE_TRADING=false`.** Verify `/health`, sign in, and check that the Engine page shows the Alpaca PAPER
account. Only then run `fly secrets set ENABLE_TRADING=true`, which restarts the app. The engine still boots **STOPPED**, so
no order can be sent until you press START.

## 22. Deploying the frontend (Cloudflare Pages)
The build-time variable `VITE_API_BASE_URL` is the **public** API URL — not a secret.
```bash
cd frontend
VITE_API_BASE_URL=https://api.mydomain.com npm run build
npx wrangler login
npx wrangler pages project create alpha-terminal --production-branch main
npx wrangler pages deploy dist --project-name alpha-terminal
```
Or connect the Git repo in Cloudflare → Workers & Pages → Create → Pages: root `frontend`, build `npm run build`, output `dist`,
environment variable `VITE_API_BASE_URL=https://api.mydomain.com`. Pages serves `index.html` for unknown paths automatically (there is no `404.html`); `public/_headers`
sets security headers. (v1.2.0 serves the dashboard from the Worker instead; see `worker/README.md`.)

## 23. Configuring the database
Nothing to do: SQLite lives on the Fly volume at `/data/alpha_terminal.db` (`DATABASE_URL` in `fly.toml`). Fly takes daily volume
snapshots (`fly volumes snapshots list <volume-id>`). To copy the DB out: `fly ssh sftp get /data/alpha_terminal.db`.
`DATABASE_URL` is a SQLAlchemy URL, so PostgreSQL is possible in principle, but only SQLite has been tested.

## 24. Connecting a custom domain
Target layout:
| Host | Serves | Protection |
|---|---|---|
| `terminal.mydomain.com` | dashboard (Cloudflare Pages) | Cloudflare Access + backend session login |
| `api.mydomain.com` | backend (Fly.io) | `/webhook`: secret + validation + rate limit + duplicates + risk; everything else: backend session / bearer |
| `api.mydomain.com/webhook` | TradingView target | public by necessity |

1. Use a domain you already own. In Cloudflare **Add a site** → enter the domain → Free plan.
2. At your registrar, replace the nameservers with the two Cloudflare gives you. Wait until Cloudflare shows the zone **Active**.

## 25. Configuring Cloudflare / DNS
**API subdomain** (Fly issues the certificate):
```bash
fly certs add api.mydomain.com
fly certs show api.mydomain.com   # shows the exact DNS target
```
Cloudflare → DNS → add `CNAME  api  →  alpha-terminal-api-CHANGEME.fly.dev`, **Proxy status: DNS only (grey cloud)**. Wait for
`fly certs show` to report the certificate as issued. (Grey cloud keeps webhook latency low and lets Fly validate the cert.)

**Dashboard subdomain**: Cloudflare → Workers & Pages → `alpha-terminal` → **Custom domains** → add `terminal.mydomain.com`
(Cloudflare creates the proxied CNAME and the HTTPS certificate).

**HTTPS**: both hosts are HTTPS only (Fly `force_https`, Pages always HTTPS). SSL/TLS mode **Full (strict)** if you ever proxy
the API through Cloudflare.

Both hosts must share the same registrable domain (`mydomain.com`): the session cookie is `SameSite=Strict` and only flows between
same-site hosts. Opening the dashboard on `*.pages.dev` will not keep you signed in — use the custom domain.

No secret ever goes into DNS records or URLs.

## 26. Protecting the dashboard
Two layers:
1. **Backend authentication (always on):** every private route (`/api/*`, `/engine/*`, `/kill*`, `/auth/session`) requires the
   session cookie (plus `X-Alpha-Terminal: 1` header and an allowed `Origin` for state changes) or `Authorization: Bearer ADMIN_SECRET`.
2. **Cloudflare Access (recommended):** Cloudflare → Zero Trust → Access → Applications → **Add → Self-hosted** → domain
   `terminal.mydomain.com` → policy **Allow** → Include **Emails** = your email → Save. Now the dashboard files are only served
   after Cloudflare's one-time-PIN/email login. Do **not** put Access in front of `api.mydomain.com`, or TradingView cannot reach
   `/webhook`.

### Cookies, CORS and domains
* The session cookie is set by `api.mydomain.com` as **host-only** (no `Domain` attribute), `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/`. Host-only is deliberate: no other subdomain can read or overwrite it.
* `terminal.mydomain.com` → `api.mydomain.com` requests are **same-site** (same registrable domain), so a
  `SameSite=Strict` cookie is sent on the dashboard's `fetch(..., { credentials: "include" })` calls.
* CORS on the API allows exactly `FRONTEND_ORIGINS` (e.g. `https://terminal.mydomain.com`) with credentials, methods
  `GET, POST`, headers `Content-Type, X-Alpha-Terminal, Authorization`.
* Every cookie-authenticated POST must carry `X-Alpha-Terminal: 1` (forces a CORS preflight) and, when the browser sends
  `Origin`, it must be in `FRONTEND_ORIGINS`.
* This does **not** work across unrelated domains (e.g. dashboard on `*.pages.dev`, API on `mydomain.com`): the cookie is then
  cross-site and the browser will not send it. Use both subdomains of one domain.
* Locally, Vite proxies the API so everything is same-origin `http://localhost:5173` (`COOKIE_SECURE=false`).

## 27. Testing the public webhook
```bash
curl -s https://api.mydomain.com/health
curl -i -X POST https://api.mydomain.com/webhook -H "Content-Type: application/json" \
  -d '{"secret":"YOUR_WEBHOOK_SECRET","id":"public-test-1","symbol":"SPY","action":"buy","qty":1,"strategy":"OTE"}'
curl -i https://api.mydomain.com/api/summary          # must be 401 without auth
```
Then in TradingView create a test alert (section 12) and check **ACTIVITY** and TradingView's alert log *Webhook status* column.
Expected while STOPPED: 403 `ENGINE_STOPPED`; after START during market hours: 200 `ACCEPTED`.

## 28. Checking logs
* Dashboard **ACTIVITY**: persisted, colour coded (green success, orange webhook/decision, red error/rejection, gray info).
* Server: `fly logs` (secrets are redacted by a logging filter; request headers are never logged).
* Database: `alerts`, `risk_decisions`, `orders` and `activity_events` tables hold the full audit trail.

## 29. Troubleshooting
| Symptom | Fix |
|---|---|
| `401 UNAUTHORIZED` from webhook | secret in the TradingView message ≠ `WEBHOOK_SECRET` |
| `400 INVALID_JSON` | message box isn't valid JSON (quotes, trailing commas, an empty placeholder) |
| `400 INVALID_SYMBOL` | add the ticker to `ALLOWED_SYMBOLS` and redeploy |
| `400 INVALID_QUANTITY` with strategies | `{{strategy.order.contracts}}` was fractional while `ALLOW_FRACTIONAL_QTY=false` |
| `403 ENGINE_STOPPED` after a deploy | expected: the server boots STOPPED. Press START |
| START refused `EXECUTION_DISABLED` | set `ENABLE_TRADING=true` (`fly secrets set ENABLE_TRADING=true`) |
| `502 BROKER_AUTH_FAILED` | wrong keys, or non-paper keys used against the paper host |
| `MARKET_DATA_UNAVAILABLE` | Alpaca market data request failed; BUY is refused rather than guessed |
| `504 BROKER_TIMEOUT` | Alpaca slow; order is `unknown` and reconciled automatically. Check TRADES before re-sending manually |
| Dashboard logs you out immediately | dashboard not on the same registrable domain as the API, or `COOKIE_SECURE=true` over plain http locally |
| CORS errors in the browser | `FRONTEND_ORIGINS` must exactly equal the dashboard origin (scheme + host, no trailing slash) |
| TradingView shows webhook timeout | keep the backend in a US region (`iad`); TradingView cancels requests after 3 s |

## 30. Confirming PAPER-only operation
```bash
python scripts/security_scan.py                    # after `npm run build`
git grep -n -E "[a-z-]+\.alpaca\.markets"            # only paper-api, data (market data), app (links)
git grep -n -i -E "live|real money|production trading"
curl -s https://api.mydomain.com/health            # "mode":"PAPER","paper_only":true
```
Note: a plain text search for the non-paper trading host also matches inside `paper-api.alpaca.markets`; the scan therefore matches whole host names. Every API
response carries the header `X-Paper-Only: true`.

---

## Architecture
```
backend/alpha_terminal/
  main.py            app factory, CORS, security headers, error format, lifespan (boot STOPPED, order sync loop)
  config.py          env settings; PAPER host constant; refuses non-paper base-URL overrides
  database.py        SQLAlchemy engine, schema creation, integrity report
  models.py          Alert, RiskDecision, Order, Trade, ActivityEvent, EngineStateRow, AppMeta, AuthSession
  schemas.py         webhook payload validation, response envelope
  webhook.py         POST /webhook pipeline
  risk.py            risk + position checks (pure functions)
  broker.py          Alpaca PAPER client (httpx), typed errors, timeout semantics
  orders.py          submission, deterministic client_order_id, reconciliation, status sync
  ledger.py          FIFO trade ledger and P&L stats
  engine.py          STOPPED/RUNNING/PAUSED state machine + kill switch
  auth.py            login/logout/session, require_admin, CSRF checks
  api.py             private dashboard API + explicit close/cancel actions
  health.py          component health, /health
  logging_service.py persisted activity log + secret-redacting process log
  rate_limit.py      sliding-window limiter
  manage.py          init-db / check-db / check-config
frontend/src/        React + Vite + TypeScript PWA (pages/, components/, store/, api/, hooks/, types/, lib/) — see docs/UI.md
scripts/             security_scan.py, make_icons.py
docs/CALCULATIONS.md exact P&L / return / win-rate definitions
docs/UI.md           UI architecture, motion, freshness rules, status meanings
```
**Engine state flow:** `STOPPED → start → RUNNING → pause → PAUSED → resume → RUNNING`; `stop` from anywhere → STOPPED;
`kill` → STOPPED + latch (start refused until `kill/reset`). Server start always writes STOPPED.

**PWA:** manifest, icons, `viewport-fit=cover`, safe-area padding, standalone mode. No service worker is registered on purpose so
the dashboard never shows cached trading data and never interferes with sign-in. On iPhone: Safari → Share → **Add to Home Screen**.

**Adding crypto later:** implement a crypto broker/data client behind the same `Broker` protocol, map `asset_class == "crypto"`, and
only then flip the CRYPTO market status — the UI already reads market status from the backend.

## Dashboard UI
Mobile-first (designed at 402 × 874, verified at 390/402/430 widths and desktop). One dark hero with the large animated
PAPER P&L, today, return, equity, buying power and exposure; a thin strategy-performance bar; small 3-column closed-trade
tiles; a white chat-style "Alpha Engine" activity panel; compact open-position rows; a slim bottom bar with the orange
**Engine** pill in the centre. Trades has a sliding segmented control (Trades / Alerts & orders), filter chips and
receipt-style detail pages. Engine shows only the actions valid for the current state; the kill switch and the
close/cancel actions are separate and each needs confirmation. Activity has category filters. Settings is an iOS-style
grouped list. Motion (count-up numbers, tile FLIP moves, top banners, milestone particles) is documented in
[docs/UI.md](docs/UI.md), together with data-freshness rules, status meanings and where every number comes from.
Screenshots: `docs/screenshots/` (taken against the tests' fake broker — **test-fixture numbers, not real results**).

## Installing on iPhone (PWA)
Open `https://terminal.mydomain.com` in Safari → Share → **Add to Home Screen**. It launches full-screen (standalone) with
safe-area padding. There is intentionally **no service worker / offline cache**: the dashboard always loads live data from
the API and shows `OFFLINE` / `STALE` when it can't, instead of showing cached numbers. Sign-in is still required.

## Running the checks
```bash
cd backend && python -m pytest && ruff check alpha_terminal tests && mypy alpha_terminal
python -m alpha_terminal.manage check-db
cd ../frontend && npm test && npm run typecheck && npm run build
cd .. && python scripts/security_scan.py
```

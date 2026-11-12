# Notifications Stage N3 — Worker and frontend deployment (2026-11-12)

**Outcome: completed and verified.** Worker version **`63f960a4-e5ac-41d2-b138-ad5a7325f854`** was built from approved
commit `ffb66bd691bbd10a35f9c0d06365f139b82f5594`. It was deployed at 100% at **2026-11-12 00:18:05 UTC**, replacing
`4d3ddcb6-08a3-472d-8f99-81ff8b317ae2`.

Production `https://alpha-terminal-api.mattledger787.workers.dev` now serves the new frontend:
- Home Pipeline and Activity panels;
- the orange α icon set and manifest;
- the Light/Dark/System theme;
- Settings → Notifications;
- the push backend, using the Stage N2 VAPID secrets.

**Not done:**
- `ENGINE_MIRROR_EVENTS` is still off (Stage N4, separate approval);
- no engine restart or change;
- no migration; no risk, strategy, cost or funded-capital change;
- no Multi-Crypto V2 deployment;
- no secret rotated or revealed.

## Source and build

- **Checkout:** a clean, detached worktree of `ffb66bd` (no line-ending conversion, 0 local changes), with fresh
  `npm ci` in `frontend/` and `worker/`. Later commits on the branch (Multi-Crypto V2 tests, fixtures and docs) are
  not included.
- **Frontend build:** `index-CA6xzXmJ.js` (333.48 kB) and `index-C6MCDGJh.css`, plus 12 static assets:
  - `_headers`;
  - `apple-touch-icon(.png, -precomposed.png)`;
  - `favicon.ico`, `favicon-32.png`;
  - `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `icon.svg`;
  - `index.html`, `manifest.webmanifest`, `sw.js`.

  The bundle contains the pipeline, the activity endpoint, the theme key and the notification settings.
- **Worker bundle:** 235.97 KiB (gzip 54.94 KiB).
- **Deploy method:**
  1. `wrangler versions upload` (no traffic), message
     "ALPHA TERMINAL ffb66bd Home pipeline/activity, Web Push backend, alpha icon, Light/Dark/System theme (Stage N3)".
  2. Verification of that version, including through its preview URL.
  3. `wrangler versions deploy 63f960a4…@100% --yes`.

## Preflight (23:49–23:57 UTC)

| Check | Result |
|---|---|
| Worker | `4d3ddcb6` at 100%; `3cbfa292` (Stage N2 VAPID secrets) the latest, undeployed |
| D1 | schema 6, `migrations list`: "No migrations to apply"; `event_cursors` paper_fills=0, mirror_trades=7, mirror_open_events=0 |
| Engine | release `0db082fbd044`, files verified, PID 15952; last candle 23:45 on time; ledger check OK 23:50:06; `lastError` null; 0 pending; risk $10; inputs hash `c826d785d58a4a39` |
| Mirror | seq 11, delivered 11, 0 pending, no gaps, no error |
| Ledger (D1) | 3 entries, 0 FEE, 0 fills, 0 trades, 0 open positions; alerts 16, orders 4, risk decisions 14; all 6 wallets reconcile (MAIN $90, SOLUSD $10, others $0); risk SOLUSD v1 $10 APPLIED |
| Mirror (D1) | 11 trades, seq 1–11 contiguous; last contiguous = max seen = engine last = 11; 0 conflicts; journal 11 × REALIZED_GROSS_PNL $15.474502 = trades gross |
| Release config vs production | `wrangler.jsonc` at `ffb66bd`: same D1 binding (`40741873-…`) and the same 11 variables (`ENABLE_TRADING=false`, `PAPER_COST_PROFILE=none`, `SHORT_SELLING_ENABLED=false`, all limits, `ALLOWED_SYMBOLS`) |

## Final tests (clean checkout)

| Suite | Result |
|---|---|
| Frontend `vitest` | **142/142** |
| Frontend `tsc --noEmit` and `vite build` | pass |
| Engine `node --test` | **188/188** |
| Worker `node --test` | **263/263**. The first full run reported 3 failures, all in `mirror_rollout.test.mjs`: the Stage A rehearsal's `npx wrangler` call in a temp folder without `node_modules` hit the test's 120 s timeout, which left its throwaway database without 0005 and failed the 2 dependent checks. Rerun on its own: **9/9 pass**. A harness timing issue, not a code fault |
| Worker deploy dry-run | pass, 235.97 KiB; production binding and variables |

## Verification before traffic (version `63f960a4`, not yet deployed)

| Check | Result |
|---|---|
| Secret names | 8: `ADMIN_SECRET`, `ALPACA_KEY`, `ALPACA_SECRET`, `DASHBOARD_PASSPHRASE`, `WEBHOOK_SECRET`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` (values not read) |
| Bindings and variables | D1 `DB` = `40741873-…`; 11 variables identical to production; `fetch` handler; compatibility date 2026-10-30 |
| Preview URL | `/health` ok, PAPER, `enable_trading:false`; `/icon.svg`, `/sw.js`, `/apple-touch-icon.png`, `/manifest.webmanifest`, `/favicon-32.png` served; `/api/notifications/config` and `/api/dashboard/events` 401 without a session; page loads `index-CA6xzXmJ.js` with the theme script |

## Post-deployment verification (production URL)

| Check | Result |
|---|---|
| Deployment | `(100%) 63f960a4-e5ac-41d2-b138-ad5a7325f854`, created 2026-11-12 00:18:05 |
| Page | `index.html` loads `index-CA6xzXmJ.js`; pre-paint theme script present; theme-color `#F3F0EA` light, `#0F0D0B` dark |
| Icon assets | `/icon.svg` (α, 2,845 B), `/apple-touch-icon.png` (5,973 B, `no-cache`), `/favicon.ico`, `/icon-maskable-512.png` (`max-age=86400`), `/manifest.webmanifest` (`no-cache`); SHA-256 of `icon.svg`, `sw.js` and `apple-touch-icon.png` **identical to the build** |
| Service worker | `/sw.js` served `no-cache`, `text/javascript`; it has no fetch handler and no cache, so trading data is never served from a cache. Not registered on page load (0 registrations); only Settings → Enable registers it |
| Authentication | `/api/dashboard`, `/api/dashboard/events`, `/api/notifications/config` return 401 without a session; `/webhook/engine-status` with a wrong secret returns 401 |
| Mobile 402 px, light and dark | Sign-in screen shows the α mark; System theme follows the device (light, then dark: background `#0f0d0b`, theme-color `#0F0D0B`); no horizontal scroll. Screenshots: `docs/screenshots/production-n3-signin-light-402.jpg`, `production-n3-signin-dark-402.jpg` |
| Engine on the new Worker | 00:20:05 and 00:25:05 candles processed on time; heartbeats and ledger checks 200; ledger check **OK** (00:20:46, 00:25:46); mirror heartbeats accepted (seq 11/11, 0 pending); `lastError` null; release `0db082fbd044`, PID 15952 (not restarted) |
| Live requests (`wrangler tail`, 00:22:38–00:24:48) | 12 requests (`engine-status`, `engine-ledger`), all 200, outcome ok, 0 exceptions, no `[events]` error log |
| Ledger after (row-level SHA-256, 00:21) | every funded table identical: counts, wallet reconciliation and risk unchanged; 0 FEE; mirror 11 trades / journal $15.474502 unchanged; no schema object changed |
| Expected D1 changes | `mirror_accounts`: its row advanced with live candles. `event_cursors.mirror_trades` 7 → 11. `trade_events` 0 → 4: the live mirror trades 8–11 that closed after Stage N1, one `MIRROR_CLOSE` each, labelled `live`, mirror source; each event's gross and modelled net equal its `mirror_trades` row exactly. No device is subscribed, so nothing was sent (`push_deliveries` 0). A device that subscribes later starts after these events (no backlog) |
| Funded events | none: the funded ledger has 0 fills |

Not checked: the signed-in homepage (Pipeline and Activity under the hero, Settings → Notifications) on production.
This browser has no owner session, and the passphrase was not used. The same build was screenshot signed in on the
local preview (`home-light-402.jpg`, `home-dark-402.jpg`). **The owner should confirm it on the iPhone.**

## Interruption seen during the window (not caused by the deployment)

From **23:52 to about 00:16 UTC** every engine request (Kraken and the Worker) failed with `fetch failed`. Windows
logged clock-change events at 00:04 and a power-state transition (Kernel-Power 566) at 00:12, which suggested
sleep. **Correction (2026-11-12 01:10):** the PC did not sleep; Windows logged no sleep/resume events, sleep is set to
Never, and the Wi-Fi stayed associated. Internet connectivity was lost upstream (router or ISP); see
`N4-COMBINED-RELEASE-PROPOSAL.md` section 9. At 00:16:10 the engine caught up 5 candles. The mirror recorded an observation gap
(23:50–00:00, 3 candles processed late, classified as catch-up). No trade, sequence or ledger record was lost. The
deployment came afterwards, at 00:18:05.

## Resource use

- No new request type from the engine.
- Event processing runs after the response on existing engine requests. On this run it made one sync batch of 4
  events and no push (no device).
- The Activity panel polls only while a signed-in Home page is visible.
- No exceptions in the tail.

## Rollback (not used)

```
node node_modules\wrangler\bin\wrangler.js versions deploy 4d3ddcb6-08a3-472d-8f99-81ff8b317ae2@100% --yes --message "rollback N3 to 4d3ddcb6"
```

- Schema 6 stays; `4d3ddcb6` ignores the new tables.
- Never restore D1.
- Devices that enabled notifications would stop receiving them.

## Owner steps on the iPhone

1. Delete the old ALPHA TERMINAL Home Screen app (it shows the cached "A").
2. In Safari, open the site, reload, then **Share → Add to Home Screen**. The sheet should show the orange α.
3. Open the new app, sign in, and check that Home shows Pipeline and Activity under the account card.
4. Settings → Appearance: try Light, Dark and System.
5. Settings → Notifications: choose the types, type the passphrase, tap **Enable**, allow notifications, then
   **Send test notification**.

## Next

**Stage N4 (`ENGINE_MIRROR_EVENTS=on`, same engine release, planned restart) awaits its own approval.** It enables
Strategy Mirror *entry* notifications. Mirror *exit* notifications already work from N3 for subscribed devices.
Funded entry and exit notifications work too, but will not fire while the funded ledger cannot open trades ($10 PAPER
capital).

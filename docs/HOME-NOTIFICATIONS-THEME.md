# Home dashboard, push notifications, icon and theme (development, 2026-11-11)

**Status: built and tested in development only. Nothing here is deployed.** Production is unchanged:
- engine `0db082fbd044` with the mirror on;
- Worker `4d3ddcb6-08a3-472d-8f99-81ff8b317ae2`;
- D1 schema 5;
- $10 risk, PAPER only, `PAPER_COST_PROFILE=none`, `ENABLE_TRADING=false`.

Each production step below (migration 0006, VAPID secrets, Worker deployment, engine flag) **needs its own owner
approval**.

The 25-second reference video and the icon screenshot mentioned in the request were not received. The build follows
the written description.

## 1. Home: Pipeline and Activity

The two panels sit directly beneath the account hero (`frontend/src/terminal/pages/Home.tsx`). They are side by side
from 900 px and stacked on a phone (checked at 402 px).

### Pipeline

The five stages are computed by `frontend/src/terminal/pipeline.ts` from data the Worker already reports: the
dashboard poll every 7 s, plus the mirror overview every 60 s. The pipeline makes no new data of its own.

| Stage | Evidence | Statuses |
|---|---|---|
| Market Data | engine heartbeat state and age; last processed candle time and close; mirror observation gaps | Waiting for candle (with the time to the next close), Catching up (3+ candles behind, or a recent observation gap), Stale, Offline, Processing (online, nothing processed yet) |
| Strategy | the engine's own status line (`Waiting for a swing`, `Need more confluence`, `Waiting for OTE tap`, `ORDER PLACED`, `IN TRADE…`, `ORDER SKIPPED…`) | Waiting for candle, Setup found, Order pending, Entry filled, Refused |
| Signals | engine outbox (pending), latest signal received by the Worker and its outcome | Processing, Setup found (accepted), Refused (with the refusal code), Waiting for candle |
| Risk | engine position vs the ALPHA PAPER ledger (MIRRORED / PENDING / NOT_IN_LEDGER and reason); engine sizing (SIZED / SKIPPED); fixed $10 risk | Entry filled, Processing, Refused, Setup found, Waiting for candle |
| Execution / Mirror | open ALPHA PAPER positions; resting strategy order; most recent closed trade and its ledger P&L; a separate, labelled Strategy Mirror line | Entry filled, Order pending, Exit recorded, Waiting for candle |

The following rules always apply:
- With no data at all, every stage shows **Offline**.
- When the poll fails, every stage shows **Stale**, with the age of the last good data.
- No percentages, progress bars, scan counters or profits are generated.
- A stage pulses only while it is genuinely in progress (order resting, signal queued, catching up). The pulse is off
  under `prefers-reduced-motion`.

### Activity

`GET /api/dashboard/events?limit=N` needs a session, is read-only, and returns at most 50 items, newest first. Every
item comes from a stored row:

| Item | Source | Label | Opens |
|---|---|---|---|
| Funded PAPER fill or exit | `paper_fills` + `trades` (ledger P&L after fees) | ALPHA PAPER | `/trades/<id>` |
| Strategy Mirror entry | `mirror_open_events` (explicit engine ENTRY record) | STRATEGY MIRROR (hypothetical) | `/mirror?account=…` |
| Strategy Mirror exit | `mirror_trades` (gross, plus modelled net) | STRATEGY MIRROR (hypothetical) | `/mirror/trade/<id>` |
| Signal accepted or refused | `alerts` (response code, reason) | ALPHA PAPER | `/trades` |
| Candle processed | engine heartbeat (`app_meta.engine_status`) | SYSTEM | `/engine` |
| Observation gap (catch-up) | mirror health (`observation_gaps`) | SYSTEM | `/mirror` |
| Worker connection lost / reconnected | seen by this device only, never sent anywhere | THIS DEVICE | — |

Catch-up and historical items carry their own tag. The feed is polled every 20 s, only while the Home page is visible
(it stops in a background tab). Requests never overlap.

## 2. Web Push notifications

### Architecture

```
engine ─► Worker request (signal / engine-status / engine-mirror) ─► response sent
                                   └─ ctx.waitUntil(processEvents)   (after the response; errors swallowed)
                                        1. syncTradeEvents: new paper_fills / mirror_open_events / mirror_trades rows
                                           → trade_events (unique event_key; cursors move in the same batch)
                                        2. deliver: plan one push_deliveries row per event × device (UNIQUE),
                                           claim ≤ 3, encrypt (RFC 8291) + VAPID (RFC 8292), POST to the push service
device (Home Screen app) ─► sw.js "push" → showNotification; tap → opens the trade page (same-origin path only)
```

- **No paid provider.** Delivery goes to Apple, Google or Mozilla push services, with WebCrypto in the Worker.
- **Funded entry:** `ALPHA PAPER · SOLUSD BUY filled`, with the quantity and price of the accepted PAPER fill.
- **Funded close:** `ALPHA PAPER · SOLUSD closed · +$2.45 PAPER P&L`. The P&L is the ledger's recorded realized result
  after fees (`trades.realized_pnl`), and the fees are shown too. Nothing is recomputed.
- **Mirror entry:** `STRATEGY MIRROR · ETHUSD SHORT opened`, with the body "Hypothetical, not an order".
  - It comes only from an explicit, durable engine `ENTRY` record emitted on the candle where the simulated fill
    happened (`engine/src/mirror.mjs`, flag `ENGINE_MIRROR_EVENTS=on`).
  - A pending limit order never produces one.
  - The Worker validates the record (id format, candle grid, price inside its candle, no lookahead) and stores it once.
    Changed content under the same id is an `ENTRY_CONFLICT`.
- **Mirror close:** `STRATEGY MIRROR · SOLUSD closed · +$14.56 hypothetical gross`, with
  `Modelled net +$13.98 (estimated costs)` in the body.
- **Default preferences are live only.** Catch-up and historical events are separate opt-ins, so a warm-up replay or
  the backlog after the PC was off never floods the phone.

### Reliability

- **One notification per event per device:**
  - `trade_events.event_key` is unique, so there is one event per source row.
  - `push_deliveries` has `UNIQUE(event_id, subscription_id)`.
  - A delivery is **claimed** (`pending → sending`, by a conditional update) before it is sent, so overlapping
    invocations cannot both send it.
  - A claim that was never recorded (invocation cut off) is marked `failed` after 5 minutes, **not resent**. Delivery is
    at most once, never twice.
- **No flood after deploying:**
  - Migration 0006 starts the cursors at the current end of each table.
  - A new device starts after the events that already exist.
- **Persisted status:** each delivery is `pending`, `sending`, `sent`, `failed`, `expired` or `skipped`, with attempts,
  times and the last error. Each device also records its last success and last error.
- **Retries:** 429 and 5xx responses back off 30 s × attempts, up to 6 attempts. Other 4xx responses are not retried.
- **Expired subscriptions:** a 404 or 410 response disables the device ("push service reports the subscription
  expired"), and it is never contacted again.
- **Failures never block ingestion:** everything runs after the response, and `processEvents` swallows errors. On
  schema 5 (before 0006), the Worker records nothing, and engine ENTRY records stay pending in the engine (not refused,
  not lost).

### Security

- **VAPID private key:** it lives only in the Worker secret `VAPID_PRIVATE_KEY`. The browser receives only the public
  key (`GET /api/notifications/config`). Tests check that the private key never appears in a response.
- **Enabling a device:**
  - It needs a session, the app's origin (the `X-Alpha-Terminal` header plus the Origin check) **and the passphrase
    typed again**. A stolen session cannot route trade alerts elsewhere.
  - The passphrase uses the same rate limit as the other PAPER actions.
- **Abuse prevention:**
  - Endpoints must be https and on a known push service (Apple, FCM, Mozilla, WNS), at most 2,048 characters.
  - Keys must be a valid P-256 point and a 16-byte auth secret.
  - At most 10 active devices.
  - Bodies are limited to 8 KB.
  - The test notification is limited to one every 30 s and goes only to the device that asked for it.
- **Payloads** contain only the notification text and a same-origin path. They never include passwords, secrets,
  credentials, account ids or keys. "Hide amounts on the lock screen" removes every price, quantity and P&L.
- **Service worker (`/sw.js`):**
  - It has **no fetch handler and no cache**. Every page and API response still comes from the network, so financial
    data is never served stale.
  - It is registered only when the user enables notifications, and unregistered when they disable them.
  - On activation it deletes any cache an older build left behind.
  - A tap opens only same-origin paths.

### API (session required)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/notifications/config` | availability, public key, device count, defaults, reason when unavailable |
| POST | `/api/notifications/subscribe` | `{subscription, passphrase, prefs, label}`; idempotent per endpoint |
| POST | `/api/notifications/status` | `{endpoint}` → prefs, active, last success / error |
| POST | `/api/notifications/preferences` | `{endpoint, prefs}` |
| POST | `/api/notifications/test` | `{endpoint}`; 30 s rate limit |
| POST | `/api/notifications/unsubscribe` | `{endpoint}`; disables this device |

## 3. iPhone setup (owner)

Web Push on iPhone needs iOS 16.4 or later and the app **added to the Home Screen**. It does not work in a Safari tab.

1. Open the ALPHA TERMINAL URL in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open ALPHA TERMINAL from the new icon and sign in.
4. Go to **Settings → Notifications**, choose the types, type the passphrase and tap **Enable notifications**. Allow
   notifications when iOS asks.
5. Tap **Send test notification**.

Delivery depends on the device:
- notification permission (iPhone Settings → Notifications → ALPHA TERMINAL);
- Focus modes;
- Low Power Mode;
- network;
- Apple's push service.

A missed notification never affects trading. To stop, tap **Disable for this device**, or remove the Home Screen app.

### If the old "A" icon still shows

iOS caches the Home Screen icon when the app is added, so a new icon appears only after the app is added again:

1. Long-press the old icon → **Remove App → Delete from Home Screen**.
2. In Safari, open the URL once and reload the page, so the new `apple-touch-icon.png` is fetched (it is served
   `no-cache`).
3. **Share → Add to Home Screen** again. The preview in the sheet should show the orange α.
4. If the preview still shows the old icon: Settings → Safari → Advanced → Website Data → remove the site's data, then
   repeat step 3. This also signs you out of the site in Safari.
5. Re-enable notifications in the new Home Screen app, because each installation has its own subscription.

## 4. Icon

The icon is an orange lowercase **α** (`#F2661B`) on a deep charcoal rounded square (`#15130F`). It uses the same glyph
as the in-app mark and is rendered by `frontend/scripts/make-icons.py` (8× supersampled).

| File | Size | Use |
|---|---|---|
| `apple-touch-icon.png` (+ `-precomposed`) | 180×180, opaque full-bleed | iPhone Home Screen (iOS rounds it) |
| `icon-192.png`, `icon-512.png` | rounded square, transparent corners | manifest `any` |
| `icon-maskable-512.png` | full bleed, glyph in the safe zone | manifest `maskable` (Android) |
| `favicon.ico` (16/32/48), `favicon-32.png`, `icon.svg` | | browsers |

- **Manifest:** `id: "/"` keeps the same app identity across updates. It also sets `display: standalone`, portrait,
  `theme_color` and `background_color` `#15130F`, and lists the any + maskable + svg icons.
- **`index.html`:** sets a theme-color per colour scheme, `color-scheme: light dark`, the apple-touch-icon at 180×180,
  and the favicons.
- **`_headers`:** the manifest, `sw.js` and the apple-touch icons are served `no-cache`; the other icons are cached for
  one day.
- **Tests:** they check each file's PNG signature and declared size, the manifest icons, and the SVG colours.

## 5. Theme (Light / Dark / System)

- **Tokens:** shared CSS tokens are in `frontend/src/terminal/theme.css`. Light is the default, dark is
  `:root[data-theme="dark"]`, and there is a no-JS fallback via `prefers-color-scheme`.
- **No hard-coded colours:** the light-only literals in `terminal.css`, `verified.css`, `motion.css` and `mirror.css`
  were replaced with tokens. These cover banners, buttons, navigation, skeletons, segmented controls, inputs, toggles,
  dark cards, chips, highlights and lifts. Every page, dialog, chart, form and loading, empty or error state therefore
  follows the theme.
- **Before first paint:** an inline script in `index.html` sets `data-theme` from `localStorage["at-theme"]`, so there
  is no flash.
- **System choice:** `theme.ts` keeps it in step with the device (e.g. iOS switching to dark at sunset) and updates
  `theme-color`.
- **Settings → Appearance:** a segmented Light / Dark / System radiogroup.
- **What is stored:** only the theme choice, on this device. A test enforces that `theme.ts` is the only storage user
  and that it touches only the `at-theme` key.
- **Contrast:** dark ink `#f4efe6` on `#0f0d0b` and `#1a1714` surfaces; green `#40d98a`, red `#ff7b6f` and amber
  `#f2a24c` were chosen for legibility on dark.

Screenshots (local preview at 402 px, real Kraken fixture candles replayed through the real engine into a throwaway
local Worker):
- `docs/screenshots/home-light-402.jpg`
- `docs/screenshots/home-dark-402.jpg`
- `docs/screenshots/settings-dark-402-permission-blocked.jpg` (the preview browser denies notification permission,
  which shows the blocked state)

The "2080 candles behind" in the screenshots is genuine: the fixture's candles are from earlier dates.

## 6. Cloudflare Workers Free estimates

The Free-plan limits are 100k requests per day, 10 ms CPU per invocation, 50 subrequests, 50 D1 queries per invocation,
5M rows read and 100k rows written per day.

| Item | Estimate | Share of Free |
|---|---|---|
| Activity poll | 180 requests per hour while Home is visible, plus mirror overview 60 per hour. At 3 h/day visible: ~720 per day | 0.7 % of requests |
| Activity D1 | session check + ≤ 5 queries, ≤ ~70 rows read per request → ~50k rows per day | ~1 % of rows read |
| Event processing | piggybacks on existing engine requests (heartbeat every 20 s ≈ 4,320 per day, plus mirror posts): **no new requests** | 0 % |
| Its D1 queries | sync ≤ 5; delivery 1 with no device, ≤ 7 with devices. Combined with the mirror handler's measured maximum of 9 → ≤ 21 per invocation | under 50 |
| Its rows read | ~10–30 per invocation (cursor-indexed) → ≤ ~140k per day | ~3 % |
| Rows written | only when something happens: about 1 + 4 × devices per event. ~30 events per day × 2 devices → ~300 per day | 0.3 % |
| Subrequests | ≤ 3 push POSTs per invocation | under 50 |
| CPU | **measured locally** at ~0.9 ms per encrypted push (Node 24, this PC). The cap of 3 per invocation keeps it at ~3 ms. **Not yet measured on Cloudflare**: check the Worker's CPU-time chart during the staged rollout | estimate |
| Storage | trade_events + push_deliveries ≈ 10k rows per year, a few MB | under 1 % of 500 MB |

## 7. Staged rollout (each stage a separate owner approval) and rollback

**Order: migration 0006 → VAPID secrets → Worker → engine flag.** Every step is optional on its own, so stopping
anywhere leaves a working system.

1. **Stage N1: migration 0006** (additive: 5 new tables, cursors at the current end, schema 6). **EXECUTED
   2026-11-11 05:20:24 UTC**; record: `DEPLOYMENT-2026-11-11-NOTIFICATIONS-STAGE-N1.md`.
   - Rehearsed: `worker/test/migrations.test.mjs` shows every existing table and row unchanged, and that re-applying is
     a no-op.
   - The current production Worker ignores the new tables.
   - Rollback: none needed. The tables can stay; never restore D1.
2. **Stage N2: VAPID keys.** **EXECUTED 2026-11-11 22:49 UTC** as undeployed version `3cbfa292` (all three stored as
   secrets; record: `DEPLOYMENT-2026-11-11-NOTIFICATIONS-STAGE-N2.md`).
   - A P-256 key pair was generated in memory on the owner's PC and self-checked with the Worker's own code.
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (the Worker's https URL, not an e-mail address) were
     stored with `wrangler versions secret bulk`, so production stayed on `4d3ddcb6`. Stage N3's deploy keeps them.
   - The private key was never printed, logged, written to disk or committed.
   - Rollback: never deploy `3cbfa292`, or set the three secrets to null; the current Worker never reads them.
3. **Stage N3: Worker deployment** (this commit; includes the frontend, `sw.js` and icons). **EXECUTED 2026-11-12
   00:18:05 UTC**: version `63f960a4`; record: `DEPLOYMENT-2026-11-12-NOTIFICATIONS-STAGE-N3.md`.
   - Pre-checks: `npm test` in worker, engine and frontend; `wrangler deploy --dry-run` (bundle 235 KiB).
   - The same Worker works on schema 5 and on schema 6.
   - Rollback: `wrangler rollback 4d3ddcb6-08a3-472d-8f99-81ff8b317ae2` (schema 6 is compatible with it). Devices that
     enabled notifications simply stop receiving them. Tell the owner to tap "Disable" or delete the Home Screen app.
4. **Stage N4: engine flag** `ENGINE_MIRROR_EVENTS=on` (mirror entry notifications).
   - Only after N1 and N3 are live. This is the only engine change: the same release `0db082fbd044` plus one env line,
     restarted right after a candle.
   - Trade records are unchanged. ENTRY records only add sequence numbers (tested: trades identical apart from seq,
     sequence contiguous).
   - Rollback: set the flag to off and restart. ENTRY records already stored stay.
5. **Owner device tests** (cannot be done here):
   - add to Home Screen;
   - check the new icon;
   - enable, then send a test;
   - receive one live funded or mirror notification;
   - tap opens the trade;
   - hide amounts;
   - disable;
   - permission denied in iOS Settings;
   - delete and re-add the Home Screen app.

## 8. Tests added

| Suite | What |
|---|---|
| `worker/test/events_push.test.mjs` (24) | RFC 8291 vector byte for byte; VAPID JWT verifies with the public key; endpoint allowlist; send outcomes; no backlog after 0006; idempotent sync; funded/mirror separation; ledger P&L and fees; schema-5 no-op; message formats, hide amounts, P&L off, catch-up label; preferences; one per event per device; cap per run; 410 retires; 5xx backoff to failed; overlapping invocations send once; interrupted send not resent; failures never break ingestion; no VAPID → nothing; activity feed bounded and ordered, excludes tests; API: session, passphrase, origin, keys, allowlist, 10-device cap, preferences, test rate limit and targeting, disable; ENTRY ingestion stored once, duplicates, ENTRY_CONFLICT, INVALID_ENTRY, MIRROR_ENTRY events; schema 5 leaves ENTRY pending |
| `worker/test/migrations.test.mjs` | 0006 additive, cursors at the end, constraints, re-apply |
| `worker/test/mirror_rollout.test.mjs` | Stage A rehearsal pinned to 0001–0005; the new Worker on schema 5 reports notifications unavailable |
| `engine/test/mirror.test.mjs` (+4) | flag off byte-identical; flag on: one ENTRY per fill before its TRADE, inside its candle, no lookahead, classification; no ENTRY for unfilled orders; on/off only |
| `frontend/src/terminal/home.test.tsx` (26) | pipeline mappings incl. offline, stale, catching up, refusals, exits; no invented numbers; panels render; activity merge, dedup and cap; iPhone / standalone detection; theme resolution, pre-paint script, dark tokens complete; icon sizes, manifest, SW has no fetch / cache, `_headers`, no SW registration at start-up |

The theme preference rule replaces the old "no storage" rule only for `theme.ts`, and only for the key `at-theme`.

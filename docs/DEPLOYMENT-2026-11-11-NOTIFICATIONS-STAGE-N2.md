# Notifications Stage N2 — VAPID keys (2026-11-11)

**Outcome: completed and verified.** The owner approved Stage N2. A new VAPID key pair was stored as Worker secrets
in a **new, undeployed** Worker version: `3cbfa292-4d88-4cca-9705-ca93515604ae`. Production traffic still runs
`4d3ddcb6-08a3-472d-8f99-81ff8b317ae2` at 100%, so no behaviour changed.

**Not done (later stages, separate approvals):**
- no Worker deployment (Stage N3);
- no engine restart or flag (Stage N4);
- no push activation;
- no D1, funded, risk or cost change.

## What was stored

| Secret | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | `BOJtNqWdApkqnBVHMdI05LeeQyHznv1hyitjTjabQD_Tl79LlhMjTCbJ2HrddoMyb8pTcS49-YKAxkdtA7inwM4` (public; SHA-256 of the raw key `f58d7edf4fa13e1ccf7804a8409daaf05493d00441a3fdba8226d5a527c9d319`) |
| `VAPID_PRIVATE_KEY` | **secret**: the P-256 private scalar. It was generated in memory on the owner's PC and piped to Cloudflare over stdin. It was never printed, logged, written to disk or committed, and no copy exists outside Cloudflare |
| `VAPID_SUBJECT` | `https://alpha-terminal-api.mattledger787.workers.dev`: the Worker's own URL (RFC 8292 allows an https URL), so no personal e-mail address is sent to Apple or Google |

All three are secrets, even though two of them are public values. This means `wrangler.jsonc` needs no change, and
the next `wrangler deploy` (Stage N3) keeps them, because Cloudflare carries secrets over to new versions.

## Procedure (UTC)

| Time | Step | Result |
|---|---|---|
| 22:48:35 | **Preflight** | Worker `4d3ddcb6` at 100%, also the latest version; its secrets were the 5 existing ones (`ADMIN_SECRET`, `ALPACA_KEY`, `ALPACA_SECRET`, `DASHBOARD_PASSPHRASE`, `WEBHOOK_SECRET`), with no VAPID values; `/health` ok, PAPER, `enable_trading:false`; engine processed the 22:40 candle on time |
| 22:48 | Code check | `worker/src` at HEAD identical to approved `ffb66bd`; dry run with throwaway keys: self-check ok |
| 22:49:16 | **Generate and self-check** | P-256 pair generated (raw public key 65 bytes, private 32 bytes). A VAPID JWT signed with the Worker's own `webpush.ts` verified with the public key alone (`aud` `https://web.push.apple.com`, 12 h expiry, `sub` as above), and the header does not contain the private key |
| 22:49:17 | **Upload** | `wrangler versions secret bulk` (JSON on stdin) created version `3cbfa292-4d88-4cca-9705-ca93515604ae` with 3 secrets created and 0 deleted; exit 0. Not deployed |
| 22:49:36 | **Verification** | Passed; see below |

## Verification

| Check | Result |
|---|---|
| Deployment | Still `(100%) 4d3ddcb6-08a3-472d-8f99-81ff8b317ae2`, deployed 2026-11-11 01:55:12, unchanged |
| New version vs deployed | `wrangler versions view` of both: identical apart from id, creation time, source, message and the **three added secret names**. Same code, `fetch` handler, compatibility date 2026-10-30, D1 binding `DB` (`40741873-…`) and every variable: `ENABLE_TRADING=false`, `PAPER_COST_PROFILE=none`, `SHORT_SELLING_ENABLED=false`, `MAX_ORDER_QTY=10`, `MAX_ORDER_NOTIONAL=5000`, `MAX_FUTURES_ORDER_NOTIONAL=75000`, `MAX_POSITION_EXPOSURE=10000`, `MAX_TOTAL_EXPOSURE=25000`, `MAX_OPEN_POSITIONS=5`, `DAILY_LOSS_LIMIT=2000`, `ALLOWED_SYMBOLS` unchanged |
| `/health` | ok, PAPER, database connected, `enable_trading:false` |
| `/api/notifications/config` | 404 (the deployed Worker has no notifications code), as expected until Stage N3 |
| Engine | Release `0db082fbd044` running; candles on time; ledger check OK at 22:49:31; `lastError` null; risk $10 |
| D1 | Not touched (schema 6 from Stage N1) |

## Rollback

Nothing is live, so there is nothing to roll back:
- Version `3cbfa292` can simply never be deployed.
- To remove the keys entirely, run `wrangler versions secret bulk` with the three names set to null (another
  undeployed version), or `wrangler secret delete` after Stage N3.
- If Stage N3 is ever rolled back to `4d3ddcb6`, the keys are harmless, because that code never reads them.

**Key rotation**: generate a new pair the same way. Every device must then enable notifications again, because
subscriptions are tied to the public key.

## Next

**Stage N3 (Worker deployment of `ffb66bd`, including the frontend, `sw.js` and icons) awaits its own approval.**
`wrangler deploy` will create a new version from that code and keep these secrets. Notifications become available on
the Worker then, and devices can opt in from Settings. Mirror entry notifications additionally need Stage N4.

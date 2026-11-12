# Stage N5 — Worker and frontend for universal funded sizing (2026-11-12)

**Outcome: completed and verified.**
- **Version:** Worker **`1b51170c-4f9d-41c0-8284-fa8ab61eac81`**, built from approved commit
  `af924ffa4703ffc677c3f81dd5ee7eb7178e067d`.
- **Deployed:** at 100% at **2026-11-12 03:30:12 UTC**, replacing `63f960a4-e5ac-41d2-b138-ad5a7325f854`.
- **Changes:**
  - the ledger view reports exposure and limits;
  - the Worker passes through the new sizing fields;
  - the dashboard has the new sizing panel.

**Not done:**
- **Engine:** no restart and no change. Release `0db082fbd044`, PID 15952, still in fixed sizing.
- **Engine settings:** `ENGINE_MIRROR_EVENTS` is not enabled; no funded sizing configuration was changed.
- **Unchanged:** no migration; no capital, risk, strategy, cost or trading-flag change.
- **Not started:** BTC/ETH and Multi-Crypto V2.
- **Secrets:** none read, rotated or revealed.

## Preflight (02:59–03:01 UTC)

| Check | Result |
|---|---|
| Worker | `63f960a4` at 100% (Stage N3) |
| D1 | schema 6; `migrations list`: "No migrations to apply"; 6 migrations recorded |
| Engine | active release `0db082fbd044` (`current`), PID 15952; candles on time (last log 03:00:05); ledger check **OK** 03:00:46; `lastError` null; 0 pending; sizing **fixed**; risk $10; inputs `c826d785d58a4a39` |
| Engine config (key names only) | `ENGINE_PROFILE`, `ENGINE_SYMBOL`, `ENGINE_INTERVAL_MIN`, `ENGINE_POLL_SECONDS`, `ENGINE_LATE_BARS`, `ENGINE_SYNC`, `ALPHA_API_BASE`, `ALPHA_WEBHOOK_SECRET`, `ENGINE_DATA_DIR`, `ENGINE_MIRROR`; no `ENGINE_SIZING`, no `ENGINE_MIRROR_EVENTS`, no `ENGINE_MARKETS` |
| Mirror (engine) | seq 11, delivered 11, 0 pending, no error, flat |
| Funded ledger (D1) | 3 entries, 0 FEE, 0 fills, 0 trades, 0 open positions; alerts 16, orders 4, risk decisions 14. Wallets MAIN $90, SOLUSD $10, ETHUSD/BTCUSD/HYPEUSD/KAITOUSD $0, all reconciling. Risk SOLUSD v1 $10 APPLIED |
| Mirror (D1) | 11 trades, seq 1–11 contiguous; last contiguous = max seen = engine last = 11; 0 conflicts; journal 11 × REALIZED_GROSS_PNL $15.474502 = trades gross |
| Notifications | 1 push subscription; 5 trade events; 1 delivery (`sent`, the owner's test of 00:48); cursors `paper_fills=0 mirror_trades=11 mirror_open_events=0 push_planned=5` |
| Stored engine status | `sizing.mode fixed`, `risk_usd_fixed 10`, last sizing SHORT 12.2105623 SOL @ 84 (stop 84.82), `current: false` |

A row-level SHA-256 snapshot of every table was taken at 03:00:45.

## Source and build

- **Checkout:** clean, detached git worktree of `af924ff`.
  - `core.autocrlf false`; 0 tracked changes.
  - Fresh `npm ci` in `frontend/` and `worker/`. The engine has no dependencies.
- **Changes since `ffb66bd` (N3), Worker and frontend:**
  - `worker/src/engine_status.ts` (+22/−2):
    - exposure SQL in the ledger view;
    - three limit variables;
    - sizing pass-through fields.
  - `frontend/src/terminal/components/SizingPanel.tsx` (rewritten).
  - `frontend/src/terminal/types.ts`: 15 changed lines; the rest of its diff is line endings only.
  - New test `worker/test/funded_sizing.test.mjs`.
- **Unchanged since N3:** `wrangler.jsonc`, migrations, `package.json`/lockfiles and the static assets.
- **Frontend build:** `index-BMS-_qKf.js` (334.87 kB) and the same `index-C6MCDGJh.css` as N3; 12 static assets.
- **Worker bundle:** 237.47 KiB (gzip 55.29 KiB).

## Final tests (clean checkout)

| Suite | Result |
|---|---|
| Engine `node --test` | **222/222** |
| Worker `node --test` | **272/272** in one run (263 existing + 9 new `funded_sizing` end-to-end; that suite took 659 s) |
| Frontend `vitest` | **142/142** |
| Frontend `tsc --noEmit`, `vite build` | pass |
| Worker type check | the Worker has no TypeScript compiler dependency (as at N3); wrangler's esbuild bundling in the dry-run is its compile check |
| Worker deploy dry-run | pass, 237.47 KiB; D1 `DB` = `40741873-…`; the same 11 variables |

## Backward compatibility with the running engine (local, real code)

The **running** engine release `0db082fbd044` was run against the N5 Worker code locally:
- the committed real Kraken SOLUSD fixture, 220 candles with a ledger poll after each;
- a fresh schema-6 D1.

Nothing touched production.

| Check | Result |
|---|---|
| Engine | ledger check **OK**, `lastError` null, no step errors or retries |
| Mirror | seq 1–7 delivered; D1 last contiguous 7 = max seen; 0 conflicts |
| Ledger response | old fields unchanged. New: `max_position_exposure_usd 10000`, `max_total_exposure_usd 25000`, `max_open_positions 5`, `position_exposure_usd 0`, `total_exposure_usd 0`, `open_positions 0`. The old engine ignores them |
| Stored sizing | the old engine's fields as before. Every new field is `null`/`false`: `max_risk_usd`, `symbol`, `spend_limit_usd`, `min_order_cost_usd`, `checks`, `outcome`, `explanation`. Nothing is invented |
| Funded alerts | 6, all `rejected` (fixed sizing on an unfunded local wallet; same behaviour as production today) |

**Sizing panel with the exact production sizing block** (server-rendered with the N5 component; throwaway test, not
committed):

> Position sizing FIXED $10.00 | Fixed-dollar sizing ignores the available equity. Funded PAPER trading uses
> percent-of-equity sizing. | Calculated risk $10.00 | Actual stop risk $10.00 | Quantity 12.210562 SOL | Estimated
> position cost N/A | Accepted for sizing. SHORT 12.210562 SOL @ $84.00, stop $84.82 · from an earlier candle

- **Correct:** fixed mode and every number; the position cost the old engine does not report is shown as N/A.
- The percent-only rows (capital, maximum risk, buying-power cap, minimum order, checks) are hidden in fixed mode.
- Wording limitations: see the limitations section.

The Worker's own checks are unchanged:
- buying power at the live price;
- the order, position and total exposure limits;
- open positions;
- short selling disabled;
- `ENABLE_TRADING=false`.

The new exposure SQL only feeds the read-only ledger view.

## Upload and verification before traffic

- **Upload:** `wrangler versions upload`, message "ALPHA TERMINAL af924ff universal sizing: ledger exposure/limits,
  sizing pass-through, dashboard sizing panel (Stage N5)". Result: version `1b51170c`, preview URL
  `https://1b51170c-alpha-terminal-api.mattledger787.workers.dev`.

| Check | Result |
|---|---|
| Source | worktree HEAD `af924ffa4703ffc677c3f81dd5ee7eb7178e067d`, 0 tracked changes |
| Secret names (8, values not read) | `ADMIN_SECRET`, `ALPACA_KEY`, `ALPACA_SECRET`, `DASHBOARD_PASSPHRASE`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `WEBHOOK_SECRET` |
| Binding | D1 `DB` = `40741873-0a98-4b23-b4e2-19ac8acec80c` |
| Variables | `ENABLE_TRADING=false`, `SHORT_SELLING_ENABLED=false`, `PAPER_COST_PROFILE=none`, `ALLOWED_SYMBOLS`, `MAX_ORDER_QTY=10`, `MAX_ORDER_NOTIONAL=5000`, `MAX_FUTURES_ORDER_NOTIONAL=75000`, `MAX_POSITION_EXPOSURE=10000`, `MAX_TOTAL_EXPOSURE=25000`, `MAX_OPEN_POSITIONS=5`, `DAILY_LOSS_LIMIT=2000`. Identical to production |
| Runtime | compatibility date 2026-10-30; `fetch` handler |
| Preview URL | `/health` ok, PAPER, `enable_trading:false`; the page loads `index-BMS-_qKf.js`; icon, service worker, manifest and touch icon served; `/api/dashboard`, `/api/dashboard/events`, `/api/notifications/config` 401 without a session; ledger with a wrong secret 401 |

Deploy: `wrangler versions deploy 1b51170c-4f9d-41c0-8284-fa8ab61eac81@100% --yes`. Done at 03:30:12, right after the
03:30:05 candle.

## Post-deployment verification

| Check | Result |
|---|---|
| Deployment | `(100%) 1b51170c-4f9d-41c0-8284-fa8ab61eac81`, created 2026-11-12 03:30:12 |
| Production page | loads `index-BMS-_qKf.js`. `icon.svg`, `sw.js`, `apple-touch-icon.png` have SHA-256 **identical to the build**. Manifest and `favicon.ico` served |
| Authentication | dashboard, events and notification config 401 without a session; `engine-status` with a wrong secret 401 |
| Mobile 402 px | sign-in screen in light (background `#F3F0EA`, theme-color `#F3F0EA`) and dark (background `#0F0D0B`); α mark; no horizontal scroll; 0 service-worker registrations on load |
| Live requests (`wrangler tail`, 03:30:29–03:39:30) | 62 requests. Every engine request (`engine-ledger` 27, `engine-status` 27, `engine-mirror` 1) returned **200**, outcome ok, **0 exceptions, 0 error logs**. The other 401s were these checks and the browser's signed-out session probe |
| Engine on the new Worker | 03:35:05 candle processed on time. Ledger check **OK** (03:39:53). Mirror heartbeat accepted at the candle. `lastError` null; 0 pending. Release `0db082fbd044`, PID 15952 (not restarted); sizing still **fixed** |
| Ledger endpoint, production (the engine's own request, secret not printed) | `ok`, `read_only`, no position. Balance: SOLUSD available $10, reserved $0. `max_order_notional_usd 5000`, `max_position_exposure_usd 10000`, `max_total_exposure_usd 25000`, `max_open_positions 5`, `position_exposure_usd 0`, `total_exposure_usd 0`, `open_positions 0`. These match D1: 0 open positions, wallet $10 |
| Stored engine status | as before, plus the new fields as `null`/`false` (old engine). The dashboard shows **FIXED $10.00**, the actual current configuration |
| D1 after (row-level SHA-256, 03:41:04) | every table **identical** except `mirror_accounts`, whose one row advanced with live candles (999 → 1008 candles, last candle 03:35). Counts, wallet reconciliation and risk setting identical. 0 FEE. No schema object changed or added |
| Mirror | 11 trades, seq 1–11, contiguous = max seen = engine last = 11, 0 conflicts; journal $15.474502 unchanged |
| Notifications | 1 subscription (unchanged); 5 trade events, 1 delivery (`sent`); cursors unchanged (`mirror_trades=11`, `push_planned=5`). **No event re-created or re-sent** |

Not checked: the signed-in dashboard on production. This browser has no owner session, and the passphrase was not
used.

## Resource use (Cloudflare Free)

- **Requests:** no new request type. The engine still makes about 6 requests a minute (≈ 8,700 a day; the Free limit is
  100,000).
- **D1:** the ledger view adds one aggregate `SELECT` over open `paper_positions` (currently 0 rows) per ledger call.
  That is well inside the Free D1 read allowance.
- **CPU per request** (`wrangler tail`):

  | Endpoint | Median | Maximum |
  |---|---|---|
  | `engine-ledger` | 2 ms | 5 ms |
  | `engine-status` | 8 ms | 13 ms |
  | `engine-mirror` | 12 ms (1 sample) | |

  - All outcomes were `ok`; none hit the CPU limit.
  - The last pre-N3 tail (2026-11-10, Stage D) had `engine-status` at a 1 ms median.
  - N5 changes that path only by filtering more fields. The rise most likely comes from N3's event processing, which
    runs after the response on engine requests; N3 recorded no CPU figures.
- **Watch item:** the Free plan's nominal CPU limit is 10 ms per request, and `engine-status` peaks at 13 ms. If
  `exceededCpu` outcomes ever appear, move the event pass off the 20-second status heartbeat, for example so it runs
  only on candle or mirror requests.

## Known limitations

1. **Panel wording in fixed mode:**
   - "Funded PAPER trading uses percent-of-equity sizing" states the policy, but is **not yet true** while the running
     engine uses fixed sizing.
   - "Accepted for sizing." on the last fixed-mode SHORT can be misread as ledger acceptance. Shorts are rejected by
     the long-only ledger; the dashboard's alert and risk sections show the actual refusals.
   - The numbers are correct. Fix the wording with the next frontend change; it needs its own Worker deploy.
2. **N3 CPU increase:** see the watch item under resource use.

## Rollback (not used)

```
node node_modules\wrangler\bin\wrangler.js versions deploy 63f960a4-e5ac-41d2-b138-ad5a7325f854@100% --yes --message "rollback N5 to 63f960a4"
```

- D1 schema 6 and all records stay; never restore D1. No engine restart is needed.
- The running engine ignores the ledger's extra fields. The new engine, if ever active, treats missing limits as
  absent.

## Next

**Stage N4 (corrected engine release `af924ffa4703`) awaits its own approval.**

`docs/N4-COMBINED-RELEASE-PROPOSAL.md` section 10 answers the five N5-review questions:
1. **Maximum risk:** the proposed configuration now uses `ENGINE_MAX_RISK_USD=10`, not `setting`, so a website risk
   change cannot raise the funded cap.
2. **Rollback:** fail-safe rules, at `ENGINE_RISK_PCT=1`:
   - no SOLUSD wallet above $1,000 while the old release runs;
   - otherwise stop funded entries when flat.
3. **Allocation:** `allocateCapital` is **not** yet in the execution path. That is safe with one funded market. It is a
   new checklist gate before a second one.
4. **Strategy Mirror:** independence evidence.
5. **BTCUSD/ETHUSD:** confirmed inactive.

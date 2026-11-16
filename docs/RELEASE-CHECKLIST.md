# ALPHA TERMINAL release checklist

Use one copy of this list per release candidate, and record the answers in the release's commit or PR.

**A candidate is not a release.** Never say a change is live until the deployed version is read back and checked.

## 1. Identify

- [ ] **Current production Worker version:** `node worker/node_modules/wrangler/bin/wrangler.js deployments list` (last line).
- [ ] **Current engine release:** `%USERPROFILE%\AlphaTerminal\engine-prod\current`.
- [ ] **Candidate commit:** one branch, one commit. It must contain the full current production frontend (diff `frontend/` against the deployed commit).
- [ ] **What changes:** Worker / engine / frontend / migration / docs only.

## 2. Test (on the exact candidate commit, in isolation)

| Suite | Command | Notes |
|---|---|---|
| Frontend | `cd frontend && npx vitest run && npm run build` | build must succeed |
| Worker | `cd worker && npm test` | needs `frontend/dist`; no other wrangler workload running |
| Engine | `cd engine && npm test` | includes the fault-injection and outage-reconcile suites |
| Ops tools | `node --test tools/ops/*.test.mjs` | |
| Research (when touched) | `node --test engine/test/r7-backtester.test.mjs engine/test/research-registry.test.mjs` | |

Record the counts. Failures must be explained (pre-existing vs new). **Do not deploy with an unexplained failure.**

## 3. Risk

**Migrations:**
- Only additive (`CREATE … IF NOT EXISTS`).
- The migration guard test is updated.
- A D1 export and a time-travel bookmark are taken before applying.

**Trading behaviour:**
- Does it change orders, fills, sizing, stops or the ledger?
- If yes: the owner's explicit authorization is required, plus fault-injection results.

**Safety settings:**
- Strict-fill enforcement, pauses and `ENGINE_PAUSED_BOTS` are untouched unless authorized.

**Frontend:**
- The four tabs, Home fits 402 × 874, branding unchanged.

## 4. Deploy (only when authorized for this kind of change)

**Worker:**
- `node node_modules/wrangler/bin/wrangler.js deploy` from a clean checkout of the candidate. Use `node …/wrangler.js`, not `npx`: the Windows `npx` launcher can hang.
- Record the new version id and the time.

**Engine:**
- `node bin/release.mjs upgrade --root %USERPROFILE%\AlphaTerminal\engine-prod --repo <repo> --ref <commit> --expect-profile solusd-5m`. It is graceful and needs no administrator.
- Back up `engine-state` and `engine.env` first.

## 5. Verify in production (read-only)

- [ ] `node tools/ops/health.mjs`: every bot running, connected, data fresh, ledger OK, and pause agreement as intended.
- [ ] Worker `/health` 200; `/api/dashboard/*` 401 without a session.
- [ ] The served asset hash equals the candidate build (`/` → `/assets/index-*.js`).
- [ ] The ledger: funding total unchanged, no duplicate fills, open positions and pending orders match the engine.
- [ ] The CPU sample (`wrangler tail`, about 10 minutes) if the change targeted performance.

## 6. Roll back

**Worker:**
```bash
node worker/node_modules/wrangler/bin/wrangler.js rollback <previous version id>
```

**Engine:**
```bash
node bin/release.mjs upgrade … --ref <previous engine commit>
```
Then restore `engine.env` from `engine-prod\backups` if settings changed.

**Database:** D1 time travel to the recorded bookmark (destructive to later writes; owner decision only).

## 7. Monitoring plan

- **Run `tools/ops/health.mjs`** after the deploy and again 1 hour later.
- **Keep the strict-fill observer running** while an observation is open (`worker/scripts/strict-fill-observe.mjs`).
- **Watch for** an engine outage (stale `last candle`), DIVERGED ledger checks and pause disagreement.

## 8. Owner authorization required for

- **Engine order handling:** changes to how the engine handles orders, and restarting paused bots.
- **Trading and money settings:** strict-fill Worker enforcement; strategy, risk, size or capital changes.
- **Credentials and passphrase-protected actions:** for example the Worker pause and starting the BTC trial.
- **Data and live trading:** destructive database operations, and anything involving real money.

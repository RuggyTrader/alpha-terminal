# Mac continuation handoff (2026-11-17)

The Mac is a **secondary development workstation**. The Windows PC remains the primary development machine and the
**only** host of the live PAPER engine.

**What the Mac did not do:**
- start, stop or configure an engine;
- deploy anything;
- change a bot state, an allocation or a risk setting;
- read any secret.

## 1. Repository and branch

| Item | Value |
|---|---|
| Mac location | `~/Developer/alpha-terminal` (new clone; nothing was overwritten) |
| Remote | `https://github.com/RuggyTrader/alpha-terminal.git` (public) |
| Branch | `development/mac-continuation` |
| Based on | `origin/mission/2026-11-16` @ `61fcc4d` (the latest pushed mission branch), with `origin/research/round4` @ `8c58aff` merged in (merge `620b08d`) |
| Merge conflict | `docs/research/FAILED-CANDIDATES.md` only. Kept both sides (Round 4 from mission; Rounds 5–7 from research) |

**Not a separate project.** `~/Documents/Codex/2026-08-08/for` on this Mac is the separate **Crypto Bot**
(SOL Phantom/Jupiter) project, not ALPHA TERMINAL. It was not touched.

## 2. Windows-only work that is NOT on GitHub (must be pushed from the PC)

| Reported item | On GitHub? | Notes |
|---|---|---|
| `378b28e` engine-outage alerts (+ migration `0009`) | **No** | **Migration number collision:** GitHub branch `candidate/activity-index` (`907230c`) also adds a migration `0009` (activity index). Renumber one of them before either is applied |
| `73ab8b6` bot-state display | **No** | |
| `bc4ce79` portfolio assistant | **No** | |
| `57c8d03` portfolio assistant | Yes (`mission/2026-11-16`) | |
| `6a30602` engine fix (reconciliation must not hold a RETRY) | Yes (`mission/2026-11-16`) | The pushed report says "NOT deployed". You report engine `6a3060228937` as live, which matches this commit. **Not verifiable from the Mac** (engine host only) |
| `docs/ENGINE-OUTAGE-PROTECTION.md` | **No** | Not in any pushed branch |
| Worker `aa5dc013` | Unknown | The pushed report records Worker `00da3a6c` (commit `2674412`). `aa5dc013` is not in any pushed document. **Not verifiable from the Mac** (no `wrangler login`) |

**On the Windows PC**, push those branches first. Use normal pushes, never force:

```bash
git push origin <branch-holding-378b28e> <branch-holding-73ab8b6> <branch-holding-bc4ce79>
```

## 3. What changed on the Mac branch (all additive; no production code path changed)

| Commit | What |
|---|---|
| `620b08d` | Merge `research/round4` into the mission base |
| `2e6affb` | **Round 8 pre-registration** + tested tooling: portfolio backtester, sizing scenarios A–D, Kraken minimums, eligibility screen, frozen acceptance |
| `b9fcc8e` | **Forward research shadow**: isolated collector, append-only store, hash-chained audit, deterministic evaluator, frozen registry (start 2026-11-18) |
| `40350d2` | **Research dashboard** (`docs/research/dashboard/index.html`, a separate static page) + Round 8 registry entries |
| (this commit) | This handoff, `docs/MAC-DEVELOPMENT.md`, `scripts/mac-test.sh` |

**Files added:**
- `engine/src/research/r8/{portfolio,families,markets,run,kraken-minimums,download-all}.mjs`
- `engine/src/research/forward/{store,collect,shadow,run}.mjs`
- `engine/src/research/dashboard.mjs`
- `engine/test/{r8-portfolio,r8-driver,forward-shadow,research-dashboard}.test.mjs`
- `docs/research/round8/PREREGISTRATION.md`
- `docs/research/forward/{README.md,registry.json}`
- `docs/research/dashboard/index.html`
- `docs/MAC-DEVELOPMENT.md`
- `scripts/mac-test.sh`
- this file

**File modified:** `engine/src/research/registry.mjs` (Round 8 entries), plus the regenerated `docs/research/registry/*`.

**Untouched:**
- engine runtime (`engine/src/*.mjs` outside `research/`);
- Worker source and migrations;
- frontend source and four-tab navigation;
- profiles, `AGENTS.md`.

## 4. Production state: what could and could not be verified from the Mac

**Verified (public, read-only), 2026-11-17 ~17:20 UTC:**
- `GET https://alpha-terminal-api.mattledger787.workers.dev/health` returned `ok:true`, `mode:PAPER`,
  `database:connected`, `enable_trading:false`.
- `/api/dashboard` returned **401** without a session, as designed.

**Not verified.** These need either the owner's dashboard session or the Windows engine host:
- engine and Worker versions;
- bot states;
- equity and P&L;
- open positions and pending orders;
- fees, downtime and strict-fill status.

**Why:**
- Wrangler is not logged in on this Mac. Running `wrangler login` would grant an OAuth session to the Cloudflare
  account, which only the owner may approve.
- The dashboard needs the owner's passphrase.

**Latest pushed record** (`docs/AUTONOMOUS-DEVELOPMENT-REPORT.md`, 2026-11-16 20:17 UTC). This is old and does not
describe the current state:
- funding $100.000;
- equity $99.4505;
- realized net −$0.5495;
- no open position;
- one pending order (BTC Atlas).

## 5. Loss containment: owner actions (prepared; none performed)

**Recommendation:** pause **new entries** on **SOL Orbit (ALPHA-02)** and **BTC Atlas (ALPHA-04)** until a strategy
shows credible positive net expectancy.

**Why:**
- Rounds 1–6 found the OTE strategy has no edge even **before** fees on independent markets. Its losses do not come
  from fees alone.
- The pushed profitability audit (`docs/research/PROFITABILITY-AUDIT-2026-11-16.md`) records negative net expectancy
  for all four live bots.

**Keep:** SOL Flare (ALPHA-01) and BTC Hash (ALPHA-03) **remain paused**.

**Before pausing, check (on the PC, read-only):**

```bash
node tools/ops/health.mjs
```

It reports, per bot, entries (engine/Worker), open position, pending order and ledger sync. Note any **open position**
and any **accepted pending order** on ALPHA-02/04.

**What each pause layer does** (from the code):

| Layer | How | Effect |
|---|---|---|
| Worker | Dashboard → Bots → bot → Owner controls → Pause. Needs the passphrase. Calls `POST /api/paper/bot-entries {paused:true}` | Refuses **new entries** only. **Exits continue** for open positions. Does **not** cancel an accepted pending order |
| Engine | Add the bot id to `ENGINE_PAUSED_BOTS` in the PC's `engine.env`, e.g. `ENGINE_PAUSED_BOTS=ALPHA-01,ALPHA-03,ALPHA-02,ALPHA-04`, then restart the engine with the existing Windows procedure | Stops new entries and new limit orders. An **unfilled entry** order is cancelled through reconciliation with a recorded reason. **Exits and stops on open positions continue** |

**Recommended order:**
1. Use the Worker pause for ALPHA-02 and ALPHA-04, and also for ALPHA-01 and ALPHA-03 (still OFF in the last pushed
   report).
2. Add both bots to `ENGINE_PAUSED_BOTS`.
3. Re-run `tools/ops/health.mjs`. It should show entries paused on both layers. Any position should still show
   "exits managed".

**Do not:**
- close positions or cancel exits;
- change sizes or allocations.

## 6. Research: where it stands

- **Rounds 1–7 (pushed earlier):** 23 candidates; **0 eligible**, 3 inconclusive, 20 failed. OTE is retired.
  Long-only trend (T1) and momentum (M1) were positive out of sample but concentrated.
- **Round 8 (Mac, pre-registered `2e6affb`, NOT YET RUN).** It tests:
  - whether the $20-per-bot model can execute higher-timeframe signals at all (scenarios A–D);
  - whether T1 / M1 / a new rotation P3 work as one shared $100 portfolio on **20 markets no round has touched**.
- **Why not run:** this Mac session's sandbox refuses connections to `api.exchange.coinbase.com` and `api.kraken.com`.
  The Round 7 candle cache is gitignored on the PC.
- **Analytic feasibility result (no data needed):** at 2% risk, minimum equity per trade = minimum order × stop ÷ 2%.
  - A $10 minimum with a 10% daily stop needs **$50**.
  - With a 15% stop it needs **$75**.
  - So a **$20 wallet cannot take most 4h or daily trend trades**, independent of any strategy edge. This matches the
    earlier 88–92% non-executable finding, and it is why the next strategy needs a shared-account model.
- **Forward shadow:** T1, M1 and P3 are registered (`docs/research/forward/registry.json`) with
  `start_at = 2026-11-18T00:00Z`, before any Round 8 result. Collection has not started.
  - Catch-up makes a late start harmless.
  - **No conclusion is possible before 180 forward days and 30 closed trades.**

**No strategy has demonstrated credible positive net expectancy. Nothing should be activated.**

## 6b. Tests on the Mac (2026-11-17, Node 22.23.5, macOS arm64)

| Suite | Result |
|---|---|
| Engine `npm test` | **302 pass, 0 fail, 7 skipped** (Windows launcher) |
| Research (r7 + r8 + forward + registry + dashboard) | **49/49** |
| Frontend `vitest` | **257/257**; `npm run build` (tsc + vite) OK |
| Worker `npm test` (after the frontend build) | **366/366** |

## 7. Continuing on the Windows PC

```bash
git fetch origin
git log --oneline origin/mission/2026-11-16..origin/development/mac-continuation
git diff --stat <your-local-latest>...origin/development/mac-continuation
```

**To integrate:**
1. Merge `origin/development/mac-continuation` into your newest local branch.
2. Expect conflicts only where Windows-only work also touched these files:
   - `docs/research/FAILED-CANDIDATES.md`
   - `docs/research/registry/*`
   - `engine/src/research/registry.mjs`
3. Before applying either migration `0009`, renumber one (§2).

**Run Round 8 on the PC** (it has network access):

```bash
cd engine
node src/research/r8/download-all.mjs --dir data/research8
node src/research/r8/kraken-minimums.mjs --out data/research8/kraken-minimums.json
ALPHA_RESEARCH_DATA=data/research8 node src/research/r8/run.mjs --prereg 2e6affb --out ../docs/research/round8/r8-results.json
node src/research/registry.mjs --root ../docs/research
node src/research/dashboard.mjs --root ../docs/research
```

On Windows `cmd`, use `set ALPHA_RESEARCH_DATA=data\research8` instead of the inline variable. Then write
`docs/research/round8/REPORT.md`, applying the frozen criteria. **No changes after seeing results.**

**Start the forward shadow** (research folder only, never the engine's):

```bash
node src/research/forward/run.mjs collect
node src/research/forward/run.mjs evaluate --out ../docs/research/forward/report.json
```

Schedule `collect` + `evaluate` daily if you approve (§ "Always-on" in `docs/research/forward/README.md`).

## 8. Unresolved authorization blockers

1. **Worker and engine pauses** for ALPHA-02 and ALPHA-04, and the Worker pause for ALPHA-01 and ALPHA-03 (owner
   passphrase / engine host).
2. **Exchange-data network access** for this Mac session (to run Round 8 and the forward collector here). Allow
   `api.exchange.coinbase.com` and `api.kraken.com` in Claude Code's sandbox network settings, or run on the PC.
3. **`wrangler login`** on the Mac, if read-only production verification from the Mac is wanted (the owner's OAuth).
4. **Push of the Windows-only commits** (§2).
5. **Engine-outage protection:** an independent stop path while the engine is offline. Reviewing it needs
   `docs/ENGINE-OUTAGE-PROTECTION.md` (Windows-only). Do not activate any new strategy before it is resolved.

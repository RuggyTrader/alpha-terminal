# Corrected Stage N4 — combined engine release (mirror ENTRY records + universal funded sizing)

**Status: proposal for approval. Nothing here has been activated.** Production is unchanged:
- engine `0db082fbd044`, PID 15952, mirror on, fixed sizing;
- Worker `63f960a4` (`ffb66bd`), D1 schema 6;
- PAPER only, $10 risk, costs none.

## 1. Why the original N4 was wrong

The running engine release `0db082fbd044` contains no `ENGINE_MIRROR_EVENTS` code. Setting the variable and
restarting would have changed nothing; the implementation lives in later commits.

Separately, the funded track was found to be unusable: every long was refused (estimated $2,228–$3,690 against the
$10 SOLUSD wallet). Both fixes need a new engine release, so they are combined into one controlled restart.

## 2. Proposed release

**Commit `af924ffa4703ffc677c3f81dd5ee7eb7178e067d` → release id `af924ffa4703`.** It is `ffb66bd`, the deployed Worker
and frontend, plus universal sizing.

Release files compared with the running `0db082fbd044` (prepared with the production release tool in a private
root):

| File | Change |
|---|---|
| `ote.mjs` (strategy) | 1 line: the strategy's state records its market symbol for sizing. No strategy logic changed |
| `sizing.mjs` | shared sizing engine: 1% of equity, $10 maximum risk, Worker limits and exposure, instrument rules |
| `instruments.mjs` (new) | verified Kraken specifications: SOLUSD (funded), BTCUSD and ETHUSD (not funded) |
| `config.mjs` | funded default = percent sizing; fixed needs a recorded research reason; `ENGINE_MIRROR_EVENTS`; V2 settings |
| `runner.mjs` | passes instrument, cap, limits and exposure to sizing; reports the full decision; `entryEvents`; V2 mirror-only tick |
| `mirror.mjs` | ENTRY records (flag); the mirror's strategy explicitly keeps fixed sizing |
| `cli/run.mjs` → `run-single.mjs` (new) | `run.mjs` becomes a small dispatcher; `run-single.mjs` is **byte-identical** to the old `run.mjs` |
| `cli/run-markets.mjs`, `markets.mjs` (new) | Multi-Crypto V2. **Dormant**: they run only if `ENGINE_MARKETS` is set, which it is not; BTCUSD/ETHUSD stay off |
| `broker.mjs`, `indicators.mjs`, `kraken.mjs`, `sync_check.mjs`, `sync-setup.mjs`, both profiles, `package.json` | **byte-identical** |

**Validate** (production-style config, private copy of the live state): ok, no problems, profile `solusd-5m`, risk
$10, long and short inputs unchanged, **inputs hash `c826d785d58a4a39` (same account)**, sizing `percent`, state
resumable.

**Selftest:** ok; 720 real candles through the packaged `run.mjs` → `run-single.mjs`; release unchanged.

The Worker and frontend changes (sizing pass-through and dashboard panel) need a Worker deploy: **Stage N5**, below.

## 3. Rehearsals (all private; nothing touched production)

### Production copy

Inputs:
- engine state, mirror state and audit, copied at 2026-11-12 00:50:54 UTC;
- a full D1 export taken 12 s later (read-only, SHA-256 `736440d5…`);
- the 9 real Kraken candles after it (00:50–01:30), replayed identically into each run against the real Worker code
  on a local D1.

| Run | Result |
|---|---|
| Running release `0db082fbd044` | baseline |
| New release forced to fixed sizing | **identical** to the baseline: funded and mirror state equal apart from the sizing-metadata object; funded database rows identical |
| New release, proposed config (percent), flag off | resumed exactly: no warm-up or reset, same pending orders, ledger OK, mirror sequence 11 → continues, contiguous. The resting funded **SHORT** order (12.14 SOL) is cancelled as `SHORT_NOT_ALLOWED`, so no unaffordable or short signal is sent. **Mirror state identical to the baseline**, including its own pending short |
| New release, percent, flag **on** | as above; no mirror entry filled in these 9 candles, so no ENTRY record was due, and none was invented |

### Deterministic (committed real Kraken data, real Worker code, fresh local D1)

| Case | Result |
|---|---|
| C: flag on, 720 candles | 14 trades + 14 ENTRY records, sequence 1–28 contiguous and delivered, 0 duplicates or conflicts; each ENTRY's sequence and event precede its exit's. With percent sizing and an unfunded wallet, the funded track sent **no** signal (`NO_CAPITAL`), against 15 refused signals under fixed sizing |
| E: same-candle trades (150-day data window) | 30 trades + 30 ENTRY records, sequence 1–60 contiguous; all 3 same-candle trades, one of them **live**, have ENTRY immediately before their exit (sequences 55 → 56) |
| D1: flag on → off on the same release (preferred rollback) | ENTRY stops at the switch (0 after); trades continue; sequence 1–21 contiguous |
| D2: an ENTRY left pending (Worker unreachable), then the **old** release resumes the state | the old release delivered the pending ENTRY (stored once), emitted none of its own, sequence 1–19 contiguous, no divergence or reset |

A transient Windows `EPERM` on a state-file rename occurred once in about 2,000 rehearsal steps. It was retried
successfully, exactly as the production loop does (a failed step is logged and retried at the next poll). Production
has logged no failed step.

### Tests

| Suite | Result |
|---|---|
| Engine (incl. the new acceptance and regression gate) | **222/222** |
| Worker | **263/263**, plus **`funded_sizing.test.mjs` 9/9** (end to end at $10–$5,000; price-move cases) |
| Frontend | 142/142, typecheck and build |

## 4. Universal sizing evidence (funded PAPER)

- **Root cause:** production never set `ENGINE_SIZING`, so the engine used the default `fixed` mode: qty = $10 ÷ stop
  distance, i.e. 25–50 SOL, worth thousands. Percent mode existed since 2026-11-09 but was never enabled.
- **`SELL … NO_POSITION`:** these were **short entries**. The strategy allows shorts, and fixed sizing sent them to the
  long-only ledger. They were not orphan exits: exits are sent only for accepted entries the ledger still holds.
  Percent sizing skips shorts before sending; the history is kept.
- **150 days of real SOLUSD data** (2026-06-12 → 11-08), 1% of equity capped at $10, long-only, ledger model:

| Balance | Trades completed | Refused by ledger | P&L (ledger, no fee) | With assumed 0.40%/side fees | Today's fixed sizing: refused |
|---|---|---|---|---|---|
| $10 | 287 | 0 | +$1.32 | −$6.22 | 597 |
| $25 | 287 | 0 | +$3.30 | −$20.53 | 597 |
| $50 | 287 | 0 | +$6.61 | −$44.15 | 597 |
| $100 | 287 | 0 | +$13.22 | −$88.29 | 597 |
| $500 | 287 | 0 | +$66.08 | −$441.46 | 597 |
| $1,000 | 287 | 0 | +$129.15 | −$882.92 | 586 |
| $5,000 | 287 | 0 | +$175.11 | −$4,271.76 | 318 |

**Sizing makes every qualifying long executable. It does not make the strategy profitable.** The PAPER ledger charges
no fee, so PAPER results look positive. At an assumed 0.40% per side, costs exceed the edge at every balance, because
the strategy's tight stops make the round-trip cost larger than its average result.

- **$10 wallet, end to end** with the real Worker code (`funded_sizing.test.mjs`): a long of ≥ 0.05 SOL costing ≤ $10
  is accepted, a restart happens mid-trade, the exit is accepted, and the wallet = $10 + realized P&L. There is no
  refusal, duplicate or orphan exit, and the Strategy Mirror's quantities equal the fixed-$10 strategy's exactly.
- **Price move:** a +0.3% move between fill and ledger is accepted; a +2% jump is refused, the position dropped and no
  exit sent.

## 5. Proposed configuration (`%USERPROFILE%\AlphaTerminal\engine-prod\config\engine.env`)

Append exactly these lines and change nothing else; the diff against the backup must be these four lines:

```
ENGINE_SIZING=percent
ENGINE_RISK_PCT=1
ENGINE_MAX_RISK_USD=setting
ENGINE_MIRROR_EVENTS=on
```

The first three are also the release defaults; writing them down makes the choice explicit, and lets the old release
size affordably after a rollback. `ENGINE_MARKETS` stays absent, so BTCUSD and ETHUSD stay off.

## 6. Order and controlled procedure (each stage a separate approval)

**Stage N5: Worker and frontend `af924ff`.**
- What it changes: the ledger view adds exposure and limits; sizing fields pass through; the dashboard sizing panel.
  No migration. Backward-compatible: the running engine ignores the extra ledger fields.
- Procedure: clean checkout, `npm ci`, tests, dry-run, `versions upload`; verify secrets (8), bindings and variables;
  then `versions deploy <id>@100%`.
- Rollback: `versions deploy 63f960a4-e5ac-41d2-b138-ad5a7325f854@100%`. The new engine treats missing limits as
  absent, sizing from balance and order limit only.

**Stage N4 (corrected): engine release `af924ffa4703`.** Run it right after a candle is processed, at a time the PC
stays on.

1. **Preflight**, as in Stage C: release status, engine PID and log, ledger check OK, mirror sequence contiguous, wallets
   reconcile, Worker version, schema 6.
2. **Backups** (private, outside git): copy `state-SOLUSD-5m.json`, `mirror-SOLUSD-5m.json` and
   `audit-SOLUSD-5m.jsonl` to `%USERPROFILE%\AlphaTerminal\backups\engine-state-before-N4-<UTC>\`, plus
   `engine.env.before-N4`, with SHA-256 of each.
3. **Prepare:**
   `node R\bin\release.mjs prepare --repo <clean checkout> --ref af924ffa4703ffc677c3f81dd5ee7eb7178e067d --root R`.
   Check: 18 files, manifest verifies, and the same changed/new file list as section 2.
4. **Config:** append the four lines (section 5). Diff against the backup = exactly those lines.
5. **Validate and selftest:**
   `validate --root R --release af924ffa4703 --expect-profile solusd-5m --expect-risk 10` must report ok, sizing
   percent, inputs `c826d785d58a4a39` and a resumable state. Then `selftest --root R --release af924ffa4703` must be ok.
6. **Activate and restart:**
   1. `activate --root R --release af924ffa4703`.
   2. `schtasks /End /TN "ALPHA TERMINAL Engine"`.
   3. Stop the remaining supervisor tree: `taskkill /PID <supervisor> /T /F` (Stage C finding).
   4. Confirm no engine is left and the lock is released.
   5. `schtasks /Run /TN "ALPHA TERMINAL Engine"`.
   6. Confirm exactly one supervisor → engine chain.
7. **Verify:**
   - `supervisor.log` shows the active release `af924ffa4703`, and the audit shows `process_start` with
     `resumed: true`.
   - No reset or warm-up; candles on time; ledger check OK.
   - Mirror sequence continues from its current value; mirror heartbeat accepted.
   - Dashboard: sizing `1% OF EQUITY · MAX $10`, capital $10. Short setups show `SHORT_NOT_ALLOWED`; long setups show
     a quantity ≥ 0.05 SOL costing ≤ $10.
   - D1 funded tables unchanged until the first real long.
   - The first mirror fill after activation creates exactly one ENTRY record and one MIRROR_ENTRY event, then one push
     to the subscribed iPhone (live classification only).
8. **Observe** for at least 2 hours, and record the first funded long when one happens.

## 7. Rollback (rehearsed)

| Problem | Action | Evidence |
|---|---|---|
| Entry notifications | set `ENGINE_MIRROR_EVENTS=off`, restart the same release; state kept; pending ENTRY records are still delivered | D1 |
| Engine release | `release.mjs rollback --root R` (→ `0db082fbd044`), restart. Keep `ENGINE_SIZING=percent`: the old release then still sizes affordably (percent, without the $10 cap or exposure inputs). It reads the new state, including pending ENTRY records | D2; old percent mode tested 2026-11-09 |
| Funded sizing | not recommended (fixed recreates the refusals). If required: `ENGINE_SIZING=fixed` plus `ENGINE_SIZING_FIXED_REASON=<why>` | config gate |
| Worker N5 | `versions deploy 63f960a4…@100%` | |

**Never restore D1.** Keep the D1 schema and every trade record.

## 8. Not included

- Multi-Crypto V2 activation (`ENGINE_MARKETS`); funded BTCUSD and ETHUSD.
- Any change to funded capital, strategy inputs, the $10 risk setting, costs or trading flags.
- Real-money trading.

## 9. Related finding: PC network outage of 2026-11-11 23:52–00:16 UTC

- **Not sleep:** Windows logged no sleep, resume or hibernate events. The power plan is High performance, with sleep
  and hibernate Never on both mains and battery; only the display turns off, after 15 minutes. The Wi-Fi adapter's
  power saving is off.
- **No Wi-Fi drop:** no Wi-Fi disconnect was logged. Connectivity was lost upstream (router or ISP) while the PC stayed
  on.
- **Recovery:** the engine caught up 5 candles and the mirror recorded the gap as catch-up. Nothing was lost.
- **Recommendation:** use wired Ethernet if possible; nothing needs changing in Windows.

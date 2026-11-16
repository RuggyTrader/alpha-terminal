# Strict fill timing for the original four bots: exact release and rollout plan (FOR APPROVAL; nothing deployed)

## The candidate

**Branch `candidate/strict-fill-on-trial` at `f1ed77d`.** It contains:
- the deployed production code (release `214551a` = trial commit `951e561`, Worker version `60bbcf3c`);
- the reviewed strict-fill changes;
- one further fix found in round-4 research;
- the test port guard.

No migration and no strategy setting change are included.

## What changes when it is switched on

| Part | Setting | Behaviour |
|---|---|---|
| Engine | `ENGINE_STRICT_FILL=on` (`engine.env`) | A limit order is fillable only on a candle that **starts at or after the ledger's acceptance time** (the ledger's own `received_at`, returned with the order) |
| Ledger (Worker) | `STRICT_FILL_TIMING: "true"` (Worker vars) | A fill's candle must open at or after the order's `placed_at` **and** `received_at`; otherwise `FILL_BEFORE_ORDER` |

**Order identity is side + limit.**
- A size-only change keeps the accepted ledger order and its acceptance time. The ledger fills at most the size it accepted.
- This fix came from round-4 research. With dollar-risk sizing the size changes almost every candle; re-placing the order restarted acceptance each candle, so it could never fill. Today's $20 wallets cap the size, which is why production has not hit it.

**Carried over and unchanged:**
- **Pending orders at the switch:** an order accepted before the switch adopts its acceptance time from the ledger record (`ACCEPTANCE_FROM_LEDGER` audit event), so it stays fillable.
- **History:** existing trades, fills and orders are never re-evaluated or changed.
- **With both settings off:** behaviour and saved state are byte-identical to production.

## Evidence

**Engine tests** (283/283 on the candidate). The end-to-end tests run against a ledger stub that enforces the strict rule:
- every fill comes from a candle starting at or after acceptance, with no refusal;
- this holds across a restart, replacements, expiries, an upgrade with an order pending, and a size that changes every candle;
- the size-change test fails without the identity fix.

**Worker tests:** the strict-mode integration test refuses a candle that opened before acceptance and accepts the next.

**Expected effect** (Aug–Nov 2026 backtest of the original four strategies):
- 2–4% fewer fills (only those on the candle already open at acceptance);
- net change −$0.01 to +$0.28.

**Before rollout:** the full Worker and website suites run on a clean checkout of the candidate, in isolation (no competing workload).

## Rollout (staged so that no genuine fill can be refused)

1. **Approve** this plan. The candidate branch is then merged into the release branch.
2. **Worker without enforcement.** Deploy the merged Worker with `STRICT_FILL_TIMING` absent. The only visible change is `received_at` in the engine's ledger read, which is additive.
   - Verify: all four bots' ledger checks are OK.
3. **Engine strict.**
   - Add `ENGINE_STRICT_FILL=on` to `engine-prod\config\engine.env`.
   - Run `node bin\release.mjs upgrade --root %USERPROFILE%\AlphaTerminal\engine-prod --repo <repo> --ref <merged commit>`. This is graceful, needs no administrator, and takes about 4 seconds.
   - Verify:
     - the engine's audit shows `ACCEPTANCE_FROM_LEDGER` for any order pending at the switch;
     - ledger checks OK;
     - heartbeats fresh.
   - The ledger is still lenient, so nothing can be refused.
4. **Observe for at least 24 hours.** A read-only D1 query confirms that every new fill's candle started at or after its order's `received_at`, and that no order is re-placed for a size-only change.
5. **Worker enforcement.** Set `STRICT_FILL_TIMING: "true"` in `worker/wrangler.jsonc` vars and deploy.
   - Verify: no `FILL_BEFORE_ORDER` refusals; fills continue.

**Rollback** (reverse order, each step reversible):
1. Remove the Worker var and redeploy.
2. Remove `ENGINE_STRICT_FILL` and run a graceful restart.

## Not included

- No change to strategy settings, capital, the trial, or any migration.

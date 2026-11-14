# ALPHA TERMINAL recovery: report (2026-11-14)

**Branch:** `release/alpha-terminal-final`.
- Saved baseline: `c793cde`.
- Final commit: see the git log and the owner message.

**Scope: development only.** Production is unchanged:

| Component | Version |
|---|---|
| Worker | `1b51170c` |
| D1 schema | 6 |
| Engine | `af924ffa4703` |

Nothing was deployed, migrated, activated or funded.

The rollout plan is in `docs/RELEASE-FINAL-PLAN.md`.

## Completed

| Requirement | Implementation | Evidence |
|---|---|---|
| Explicit order actions | The bot ledger takes `PLACE_LIMIT`, `CANCEL_ORDER`, `OPEN_LONG`, `OPEN_SHORT` and `CLOSE` (CLOSE names its position; `POSITION_MISMATCH` otherwise). There is no ambiguous BUY/SELL on this path. | `worker/src/bot_ledger.ts`; tests in `pending_orders`, `multi_bot` |
| LONG and SHORT PAPER execution | Collateralised PAPER SHORTs in the bot's own wallet. Gross is computed per direction, a 0.20% fee is charged on each fill, positive net is swept to MAIN once, and any shortfall is recorded. | `engine_lifecycle` replay: LONG and SHORT executed; `pending_orders` |
| Reduce-to-fit | At placement (at the limit price) and at the fill. Planned figures are recorded. Rejected only when even the venue minimum is unaffordable. | `paper_fill.ts sizeAtLimit`; pending tests |
| Durable pending orders | `bot_pending_orders` (migration 0007): order id, bot, market, timeframe, side, limit, stop, target, requested vs accepted quantity, planned risk, collateral, fee estimate, placed, expires, status, fill trade. One PENDING per bot; idempotent. | `pending_orders` tests; `/api/dashboard/bot-orders` |
| Order lifecycle | PENDING → FILLED → OPEN → CLOSED, or CANCELLED / EXPIRED / REPLACED / REJECTED. A pending order never fills twice. | tests |
| Correct limit semantics, no future data | A strategy fill is accepted only from a **completed** candle that opened **after** the order was placed, with the price inside that candle. A buy limit never fills above its limit; a sell limit never fills below. A gap fills at the open (the better price). | `paper_fill.ts`; unit tests |
| Same-candle events | They follow the engine's TradingView broker emulator: intrabar path open→high→low→close when the open is nearer the high, otherwise open→low→high→close; a bracket can fill on the same candle as its entry. TradingView parity is preserved separately. | `engine/src/broker.mjs`; `tv-parity.test.mjs` |
| Pending orders survive restarts | The engine persists its live order (`liveOrder`), re-sends with deterministic ids, and checks the ledger's pending order after every poll. | replay test: restart with an order pending; placed once |
| Reversals | **The original strategy never reverses.** Pine places entries only when flat (`inPos` / `triggered`, lines 301–304), and the engine's broker fills entries only without a position. The ledger therefore enforces close-then-open: an opposite entry while a position is open is refused (`POSITION_ALREADY_OPEN`); a failed or mismatched close blocks it. | `pending_orders`: SHORT → close → LONG as an independent position; opposite entry refused while open |
| ALPHA-02 SHORTs (S1 switch) | An owner action moves ALPHA-02 to the bot ledger only when it is flat. The legacy route then refuses ALPHA-02 (one route only). The engine setting `ENGINE_LEDGER_ALPHA_02=bot` gives dollar sizing with simulated SHORTs while keeping the same ids, state, profile and wallet. | `pending_orders` S1 test; `fleet` S1 tests |
| Strategy engine status | Seven states from each bot's own heartbeat, last completed candle and ledger check. **Never derived from Alpaca.** The Alpaca route appears only under Settings → Advanced. | `recovery.test.tsx` |
| Mirror out of the main experience | Research (`/research`) via Settings → Advanced. Home performance shows Account / By bot only. Bot cards show no Mirror figures. Activity hides Mirror by default. Mirror records are preserved. | tests; screenshots |
| UI | Navigation: Home · Bots · Trades · Activity · Results · Settings. Six-section Settings. Compact bot cards grouped SOLANA / BITCOIN with View chart. Trades: Pending / Open / Completed / Rejected-Cancelled with LONG/SHORT filters, from durable orders. Charts: direction-aware risk/reward shading drawn only from recorded levels. | screenshots |
| Windows startup | Verified the live task: boot + logon triggers, S4U (no logon needed), correct executable and working directory, restart on failure, duplicate protection. Added a guard so an old task definition can never remove the startup trigger. | `RELEASE-FINAL-PLAN.md` |
| Schema-7 rehearsal | Representative schema-6 fixture built through the real routes, then 0007 applied. Every pre-existing row and balance unchanged; FK check clean; profiles registered; legacy history and performance served unchanged; then a SHORT executes on the migrated database. | `migration-rehearsal-2026-11-14.json`: 31/31 |

## LONG and SHORT, pending orders, restart, accounting (DEMO / historical replay)

**Source:** `docs/recovery/lifecycle-replay-evidence-2026-11-14.json`.

**What ran:**
- The **real engine** (ALPHA-01, profile hash `0932a1a0cfac03f9`, unchanged).
- **Recorded Kraken SOLUSD 1m candles** from 10–12 Nov, one candle per tick.
- A real local Worker with a fresh D1.
- The engine was **restarted while an order was pending**.

**Results:**
- **Both directions** were opened and closed.
- Every fill:
  - names a recorded pending order;
  - respects its limit;
  - lies inside its completed candle;
  - comes from a candle that opened after the order was placed.
- Each order was placed once.
- There is exactly one fill per order and kind, and at most one sweep per trade.
- **The wallet reconciles to the micro-dollar:** available + reserved = allocation + Σ(net − swept) − the open entry fee; MAIN = Σ swept.

## Mirror no longer replaces execution

- Every enabled bot has one execution destination: the bot ledger, or the legacy ledger until its switch.
- Every strategy order is submitted to that destination and ends with an explicit outcome.
- The Mirror is research only. It is never added to account figures and is not shown on Home, Trades, Results or bot cards.
- The 25 historical SHORT refusals stay as recorded (`docs/diagnosis/short-refusals-2026-11-14.json`). No fills are created for them.

## Remaining limitations (stated, not hidden)

**Execution model:**
- The PAPER limit-fill model uses the candle supplied by the authenticated engine. The Worker validates it but does not re-fetch Kraken OHLC.
- No exchange queue position or partial fill is modelled. A fill is not a guaranteed exchange fill.
- **Partial position reduction:** the original strategy has no partial exits (a single TP2/stop bracket), so none is implemented. Inventing one would change the strategy.

**ALPHA-02 and the engine host:**
- ALPHA-02 remains on the long-only legacy ledger in production until Stage C2. Until then its SHORT setups are refused (`SHORT_NOT_ALLOWED`) **because of that path**, not because of risk rules.
- The engine host is this PC. Startup without a logon is configured, but **I have not verified it**, because that needs a reboot. The engine cannot run while the PC is off.

**Not verified here:**
- Production behaviour.
- iPhone Safari (verified in headless Chrome at 360/402 px).
- A rehearsal on a private copy of production data (needs approval for the export).

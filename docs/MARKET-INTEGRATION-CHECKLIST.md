# Market / strategy integration checklist (mandatory before funded activation)

This applies to every new market, instrument type, timeframe and strategy. Rules:
`docs/UNIVERSAL-POSITION-SIZING.md`.

**A market stays unavailable for funded execution (`fundedEligible: false`) until every item below passes and the
owner approves.**

1. **Instrument specification**
   - Add an entry to `engine/src/instruments.mjs` with the provider's published values: tick, quantity step and
     precision, minimum quantity, minimum value, fractional eligibility, multiplier, margin, trading hours, fee model
     and order types.
   - Record the **source and date**.
   - Never copy another market's rules.
   - Where the provider publishes no fee, label the fee an assumption.
2. **Real market data**
   - Connect a real provider feed. For crypto, use Kraken OHLC, as in `src/kraken.mjs`.
   - Cross-check completed candles against the provider's own OHLC.
   - Keep the gap and no-trade handling.
   - No invented or synthetic data.
3. **Strategy verification**
   - Show that the strategy behaves correctly on that instrument (parity or backtest on real data), with the instrument's
     tick and pivots.
4. **Shared sizing engine**
   - Orders are sized only by `sizePosition()` / `sizeOrder()` with the market's own instrument.
   - No fixed-dollar sizing for funded trading.
   - Add a real-price fixture so the acceptance suite covers the market.
5. **Affordable sizing tests**
   - `engine/test/sizing-acceptance.test.mjs` passes for the market at $10, $25, $50, $100, $500, $1,000 and $5,000.
   - Unaffordable cases are refused with documented reasons. Whole-share and contract minimums are explained, not
     bypassed.
6. **Ledger entries and exits**
   - A funded long entry and its exit are accepted by the real Worker code on a local D1.
   - The quantities match, there are no refusals, and exits go only for accepted entries.
7. **Product surfaces**
   - Dashboard sizing panel, Home pipeline, activity, chart and notifications show the market with the correct label
     (funded vs mirror).
8. **Risk limits and reconciliation**
   - Order, position and total exposure, open-position count and wallet reconciliation are tested.
   - Restart resumes without a warm-up or duplicates. Ledger checks are OK.
0. **A bot of its own** (docs/MULTI-BOT-ARCHITECTURE.md)
   - Register it in `engine/src/bots.mjs` (ALPHA-NN, market, timeframe, profile, wallet, priority, risk policy) as
     PROPOSED, and in the ledger's `bots` table only when approved.
   - Its own strategy settings from the owner (never another timeframe's), its own state files, signal ids and mirror
     account. `engine/test/fleet.test.mjs` and `worker/test/multi_bot.test.mjs` must pass.
9. **Capital allocation across funded markets** (required before a *second* funded market)
   - `allocateCapital()` (`engine/src/sizing.mjs`) is a tested helper only. The fleet (development, 2026-11-12) adds the
     execution-path protection instead: the capital book (`engine/src/capital.mjs`) earmarks other bots' resting entries
     on a shared wallet, bots are processed in a fixed allocation order, and the ledger's CHECK constraints (wallet,
     per-bot cap) refuse any fill that would overspend. Not deployed yet.
   - Before any second funded market: call it in the per-candle order path for every funded signal of that candle (or
     prove that each market draws only on its own wallet, which the Worker reserves at order time), and add an
     end-to-end test with two simultaneous signals on the real Worker code showing that capital is never promised twice.
10. **Activation gate**
   - Only after 1–9 pass, set `fundedEligible: true` (with the owner's approval).
   - The regression gate then requires every check to keep passing.

The Strategy Mirror may observe a market earlier (mirror-only), because it trades nothing: the BTCUSD and ETHUSD
pattern. It still needs items 1–3.

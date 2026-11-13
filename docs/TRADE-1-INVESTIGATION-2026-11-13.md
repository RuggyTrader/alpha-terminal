# Production trade #1 — "What was the point of this trade?" (investigated 2026-11-13, read-only)

**Evidence used:**
- Production D1, read-only `SELECT`s: tables `alerts`, `paper_positions`, `paper_fills`, `trades`.
- The production engine's own audit trail and state (`%USERPROFILE%\AlphaTerminal\engine-state\audit-SOLUSD-5m.jsonl`, `state-SOLUSD-5m.json`, `mirror-SOLUSD-5m.json`).
- An independent replay from Kraken trade-built candles.

**Production versions:**

| Component | Version | Schema |
|---|---|---|
| Worker | `1b51170c` (Stage N5, commit `af924ff`) | 6 |
| Engine | release `af924ffa4703` | — |

Nothing was changed.

## The trade

| | Recorded value | Source |
|---|---|---|
| Bot | ALPHA-02 (the legacy single engine), KRAKEN:SOLUSD **5m**, profile `solusd-5m`, inputs hash `c826d785d58a4a39` | engine state, alert id |
| Setup | Bullish swing **81.18 → 81.72**, reported at the close of the 00:20–00:25 UTC candle | audit `SETUP` |
| OTE level | 70.5% retracement of that swing = **81.3393** | computed from the recorded swing (Pine `lvl(0.705)`) |
| Order | **LONG limit 81.34**, stop **81.17**, TP2 **81.59**, confluence score **1**, placed 00:25 UTC | audit `ORDER_PLACED` |
| Qualifying PD array | **Order Block (OB)** | audit `IN_TRADE` tags |
| Strategy fill | The limit filled at **81.34** in the 00:30–00:35 candle (O 81.44 · H 81.53 · L 81.34 · C 81.43) | audit `ENTRY_FILL` |
| Ledger fill | **81.43**: the Kraken reference price when the signal arrived, 00:35:02 UTC (19:35:02 EST) | `paper_fills` |
| Exit | **Stop loss.** The 00:35–00:40 candle (O 81.43 · H 81.45 · **L 81.01** · C 81.17) went through the 81.17 stop | audit `EXIT_FILL kind SL`, `TRADE_FINISHED result SL, exitR −0.98` |
| Ledger exit | **81.17** at 00:40:02 UTC (19:40:02 EST), reference price | `paper_fills` |
| Result | gross −$0.03167912 = (81.17 − 81.43) × 0.12184277; fees $0 (cost profile `none`, legacy) | `trades` #1 |

**In plain words:**
- ALPHA-02 saw SOL make a small bullish swing from 81.18 to 81.72.
- It placed a LONG limit order at the swing's 70.5% retracement (81.34), qualified by an Order Block. The stop sat just below the swing origin (81.17) and the target at 81.59.
- Price dipped to the limit and filled it. Five minutes later the next candle fell to 81.01, through the stop, so the trade was stopped out.
- It was a valid setup that failed. It was not an error.

## Timestamps

| Event | UTC | Note |
|---|---|---|
| Signal id `…T00:30:00Z-BUY` | 00:30 | The **open** time of the candle in which the limit filled |
| Candle close | 00:35:00 | — |
| Engine created the signal | 00:35:05 (engine PC clock) | — |
| Worker received it | 00:35:01.751 (Cloudflare clock) | The engine PC's clock is about 4 s ahead of Cloudflare's |
| Ledger fill | 00:35:02.211 | — |

The owner's display (19:35:02) is UTC−5 (EST), and the conversion is correct.

## Sizing

The production release uses `percent` sizing: 1% of equity, at most $10.

| Quantity | Value |
|---|---|
| Wallet capital | $10.00 |
| Risk target (1% of $10) | $0.10 |
| Quantity that $0.10 risk would need | about 0.58 SOL (about $47) |
| Buying-power cap | $10 ÷ (81.34 × 1.005 price buffer × 1.004 fee headroom) = **0.12184277 SOL** |
| Actual stop risk | about $0.021 |

The order was capped by buying power. That is correct under the production rules.

The quantity respects Kraken's 0.05 SOL minimum. It is not the new dollar-risk model, which is not deployed.

## Fees

- **Recorded:** cost profile `none` (legacy, fee-free). This is preserved and not rewritten.
- **For comparison only, not charged:** at the Ndax-equivalent 0.20% per fill the fees would be
  - entry 0.12184277 × 81.43 × 0.2% = $0.019843;
  - exit 0.12184277 × 81.17 × 0.2% = $0.019780;
  - total **$0.039623**, net **−$0.071302**.

## Strategy Mirror and parity

**Strategy Mirror:**
- The production mirror recorded the **same trade**: LONG 58.006 SOL, 81.34 → 81.17, stop loss, −$9.86 hypothetical at its $10 reference risk.
- An independent replay from Kraken trade-built candles (`solusd-5m`, history from 9 Nov) produces the identical trade.
- The replay's candles match the engine's audit to the cent.

**The one execution difference: the ledger filled at 81.43, not 81.34.**
- The strategy's limit filled inside the candle at 81.34.
- The live engine only learns of the fill at the candle close. The legacy ledger then fills at the current Kraken price.
- That cost $0.011 on this quantity (0.09 per SOL). It is the documented "fill at the reference price on arrival" model, not a defect in the strategy.

## What production did NOT record, and what changed

**Missing from production D1 for this trade:** the swing leg, OTE level, stop, target, PD-array tags, confluence score and exit reason. They exist only in the engine's local audit file. That is why the app could not answer the owner's question.

**Fix, implemented and tested; not yet deployed:**
- The engine now attaches its recorded plan (`plan`) to every entry signal and its exit reason (`exit`) to every close. This is `engine/src/tradeplan.mjs`.
- The Worker returns them with each trade (`worker/src/trade_story.ts`), on the legacy path and the bot path.
- **This needs no migration.** It is stored in the existing `payload_json` columns.
- Older trades show "not recorded" instead of a reconstruction.
- It reaches production only with a new **engine release**, plus the Worker release that displays it; both need approval.

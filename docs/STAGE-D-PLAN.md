# Stage D: four bots on about $100 of PAPER capital (revised 2026-11-15; NOTHING executed)

**The earlier $10,000 proposal is withdrawn. No deposit was made, and none is planned.**

## Starting point (production)

| Wallet | Balance |
|---|---|
| MAIN | $90.000000 |
| SOLUSD (ALPHA-02's wallet) | $9.968321 |
| ALPHA-01, ALPHA-03, ALPHA-04 | $0 |
| **Total** | **$99.968321** |

**Funding:** $100.00 was funded; the difference is trade #1's −$0.031679.

ALPHA-02's pending SHORT keeps its accepted size (0.1396829 SOL). A pending order is **never resized** by a reallocation: its fill uses at most the accepted quantity.

## Exact transactions (owner, passphrase in the app; no deposit)

| # | Action | Result |
|---|---|---|
| 1 | Bots → **Activate** ALPHA-01, ALPHA-03 and ALPHA-04 | ACTIVE with their registered profiles (`0932a1a0cfac03f9`, `d828caa44611ad73`, `a6336dad6ffaed70`); LONG + SHORT by default |
| 2 | Bots → Allocate → **ALPHA 01 only $20.00** | ALPHA-01 $20.00 |
| 3 | Bots → Allocate → **ALPHA 02 only $10.03** | ALPHA-02 $19.998321 |
| 4 | Bots → Allocate → **ALPHA 03 only $20.00** | ALPHA-03 $20.00 |
| 5 | Bots → Allocate → **ALPHA 04 only $20.00** | ALPHA-04 $20.00 |

**Result:**

| Wallet | Balance |
|---|---|
| MAIN | $19.97 |
| ALPHA-01 | $20.00 |
| ALPHA-02 | $20.00 |
| ALPHA-03 | $20.00 |
| ALPHA-04 | $20.00 |
| **Total** | **$99.968321** |

- Every allocation is recorded as a transfer, never as profit.
- Positive net profit is still swept to MAIN at each close.
- The same single-bot allocation is how MAIN's accumulated profit can be reinvested into a bot later, each time with your approval.

## Engine (one consolidated config, one restart, new pinned release)

```
ENGINE_BOTS=ALPHA-02,ALPHA-01,ALPHA-03,ALPHA-04
ENGINE_LEDGER_ALPHA_02=bot
ENGINE_APPROVED_BOTS=ALPHA-01,ALPHA-03,ALPHA-04
```

**Each bot:**
- its own state, lock, wallet, heartbeat and chart;
- LONG and SHORT, reduced to fit its wallet, no leverage, 0.20% fee per fill, fully collateralised SHORTs.

**Load estimate:** about 13,800 Worker requests and about 10,000 D1 writes per day, against free limits of 100,000 each. Real figures will be measured after activation.

## How small capital works (no $2,000 needed)

- **Position value** is at most the bot's available wallet. At $20, positions are about $15–19; Kraken's minimum is about $3.5 (SOL) or about $3.9 (BTC).
- **Actual risk** is about position × stop distance: about $0.10 at a 0.5% stop. The $10 risk target is a ceiling that small wallets never reach.
- **Fees** are 0.20% of the position on entry and on exit: about $0.08 per round trip at $20.

## Can these strategies grow $100 after fees? Evaluation (`docs/recovery/small-capital-evaluation-2026-11-15.json`)

**Data:** recorded Kraken candles, 1–11 Nov 2026 (SOL and BTC, 1m and 5m). Each bot's **exact original profile**, its own wallet, reduce-to-fit sizing, LONG and collateralised SHORT, **0.20% per fill**. Fills at the candle close: a conservative model.

| Bot | Trades (L / S) | Gross before fees | Fees | **Net after fees** ($20 wallet) | Break-even fee per fill* |
|---|---|---|---|---|---|
| ALPHA-01 SOL 1m | 114 (62 / 52) | +$1.27 | $7.32 | **−$6.05** | 0.033% |
| ALPHA-02 SOL 5m | 47 (18 / 29) | +$1.23 | $3.47 | **−$2.24** | 0.035% |
| ALPHA-03 BTC 1m | 95 (42 / 53) | +$1.13 | $6.47 | **−$5.33** | 0.015% |
| ALPHA-04 BTC 5m | 29 (13 / 16) | +$0.39 | $2.18 | **−$1.79** | 0.073% |
| **All four** | 285 | +$4.02 | $19.44 | **−$15.42** (about 19% of $80 in 11 days) | |

\*From the zero-fee TradingView-reference run (limit fills, $10 fixed risk): the per-fill fee at which that run's net profit would be zero.

**Findings:**
1. Before fees, every strategy made a small profit in this period. **After 0.20% per fill, every strategy lost money**, because fees were 3–6 times the gross.
2. The stops are tight (often 0.2–0.6% of price), so the round-trip fee (0.4%) is a large fraction of each trade's risk. **This does not depend on capital**: $50 per bot loses 2.5 times as much as $20.
3. **Break-even** needs fees of about 0.015–0.073% per fill, 3–13 times lower than 0.20%. The 1-minute bots are furthest from viable; ALPHA-04 (BTC 5m) is closest.
4. **No strategy is consistently profitable after fees** on this data.

**Limits of this evaluation:**
- 11 days is a short sample.
- The funded model fills at the candle close (the live ledger uses limit fills, which is better).

The live PAPER run is the honest test, and its results will show on Results and per bot.

**Settings were not changed:** no strategy setting was altered to make these numbers look better.

## Approvals needed

1. Deploy the Worker and website update: Activity order-identity fix, the Activate action, single-bot allocation, and the position / risk text on bot cards.
2. Activate ALPHA-01, ALPHA-03 and ALPHA-04.
3. The four allocations above: $20.00, $10.03, $20.00 and $20.00 from MAIN.
4. Install the new engine release with the consolidated config, with one restart.

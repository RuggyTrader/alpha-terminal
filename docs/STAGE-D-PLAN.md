# Stage D: all four bots (prepared 2026-11-15; NOTHING executed)

## Starting point (production, 07:2x UTC)

| Wallet | Balance |
|---|---|
| MAIN | $90.000000 |
| SOLUSD (ALPHA-02's wallet) | $9.968321 |
| ALPHA-01, ALPHA-03, ALPHA-04 | $0 |

- **Funded total:** $100.00, made of two DEPOSIT/transfer entries.
- **Equity:** $99.968321. The −$0.031679 is trade #1.
- **ALPHA-02:** ACTIVE on the bot ledger, LONG + SHORT. ALPHA-01, ALPHA-03 and ALPHA-04 are PROPOSED and registered with their original hashes.

## The $10,000 account: exact transactions

The target is **$10,000 total funding**, not +$10,000. History is not erased: equity stays $10,000 − $0.031679.

| # | Action (owner, passphrase in the app) | Effect | Ledger record |
|---|---|---|---|
| 1 | **Wallets → Add PAPER capital: $9,900.00** | MAIN $90.00 → **$9,990.00** | `DEPOSIT` entry, "PAPER funding added (not profit)"; `net_funding` +$9,900 |
| 2 | **Bots → ALPHA 01 → Activate** | ALPHA-01 PROPOSED → ACTIVE (profile `0932a1a0cfac03f9`) | `bots.status` |
| 3 | **Bots → Allocate → SOLANA $4,000.00** | Equal split between SOLANA's active bots: ALPHA-01 **$2,000.00**; ALPHA-02 **$2,009.968321** | `ALLOC:` transfer entries |
| 4 | **Bots → ALPHA 03 → Activate**, then **ALPHA 04 → Activate** | Both ACTIVE (profiles `d828caa44611ad73`, `a6336dad6ffaed70`) | `bots.status` |
| 5 | **Bots → Allocate → BITCOIN $4,000.00** | ALPHA-03 **$2,000.00**; ALPHA-04 **$2,000.00** | `ALLOC:` transfer entries |

**Result:**

| Wallet | Balance |
|---|---|
| MAIN | $1,990.00 |
| ALPHA-01 | $2,000.00 |
| ALPHA-02 | $2,009.968321 |
| ALPHA-03 | $2,000.00 |
| ALPHA-04 | $2,000.00 |
| **Total equity** | **$9,999.968321** |
| Total funding | $10,000.00 |

**Why ALPHA-02 ends at $2,009.97 and MAIN at $1,990:**
- An allocation splits equally between a group's active bots, so ALPHA-01 and ALPHA-02 receive the same amount.
- ALPHA-02 keeps its existing $9.968321 on top.
- An exact 2,000/2,000 would need moving cents out of ALPHA-02, which is not worth an extra transfer.

**How returns treat the deposit:**
- Dollar P&L is unchanged: trade #1 stays −$0.031679 in every view.
- The account's "portfolio return" is net P&L ÷ funded capital, so the same −$0.03 becomes −0.0003% of $10,000. The deposit adds no profit; it only enlarges the base.
- Per-bot figures use each bot's own trades and wallet. Evaluation of the four strategies starts from the activation date.

## Engine: one consolidated configuration, ONE restart

`engine-prod\config\engine.env` (owner-approved lines; others unchanged):

```
ENGINE_BOTS=ALPHA-02,ALPHA-01,ALPHA-03,ALPHA-04
ENGINE_LEDGER_ALPHA_02=bot
ENGINE_APPROVED_BOTS=ALPHA-01,ALPHA-03,ALPHA-04
```

**New engine release required.** The running `0a1bc32951f0` refuses PROPOSED bots; this release adds the explicit `ENGINE_APPROVED_BOTS` approval line. Its file is `release/alpha-terminal-final`, which also carries the Worker fixes below.

**Each bot runs:**
- with its own state file, lock and wallet;
- with LONG and SHORT on by default, $10 dollar risk reduced to fit, 0.20% fee per fill, fully collateralised SHORTs and no leverage;
- with its own heartbeat and chart.

One process serves all four; candles are fetched once per market and timeframe per round. A tested fleet case shows each bot ends exactly as it would alone, even through another bot's outage.

**Restart:**
1. Disable the task and stop the engine (administrator command).
2. Back up the state.
3. Activate the new release.
4. Enable and run the task.

ALPHA-02's state and any pending order or open position are kept. The pending order is also stored durably in the ledger, and the engine reconciles with it at start, as verified at the Stage C restart.

## Estimated load (free tier)

**Estimate:** about 4 Worker requests per completed candle per bot (heartbeat, ledger check, research-mirror update, orders). Two 1m bots (1,440 candles/day each) plus two 5m bots (288/day each) come to **about 13,800 requests and about 10,000 D1 writes per day**.

**Free tier:** 100,000 requests/day and 100,000 D1 writes/day. Real figures will be measured after activation.

## Capital effect (why $2,000 per bot)

- **Risk:** about wallet × stop % until it reaches $10. At $2,000 the $10 target binds for stops of 0.5% or more; tighter stops give less.
- **Fees:** a round trip costs about 0.40% of notional, about 0.7 R at a 0.55% stop. That share does not depend on capital.

## Approvals needed

1. Deposit **$9,900.00** of simulated PAPER capital into MAIN.
2. Activate ALPHA-01, ALPHA-03 and ALPHA-04.
3. Allocate **SOLANA $4,000.00** and **BITCOIN $4,000.00**.
4. Deploy the Worker and website fixes: Activity identity fix and the Activate action.
5. Install the new engine release with the consolidated config, with one restart.

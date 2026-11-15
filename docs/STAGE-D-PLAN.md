# Stage D: activating ALPHA-01, ALPHA-03 and ALPHA-04 (prepared 2026-11-15; nothing done)

**Today:** ALPHA-02 trades LONG and SHORT on the bot ledger (Stage C). ALPHA-01, ALPHA-03 and ALPHA-04 are registered with their original profiles, on the same ledger, with **both directions on by default**. They are PROPOSED (not running) with $0 wallets.

**Activating a bot takes four steps, with no direction or ledger settings involved:**
1. Its registry status is set to ACTIVE (owner approval).
2. Capital is allocated from MAIN on **Bots → Allocate**: an equal split within its group, entered with your passphrase.
3. It is added to `ENGINE_BOTS` in the engine config: for example `ENGINE_BOTS=ALPHA-02,ALPHA-01,ALPHA-03,ALPHA-04`. This is one engine process running independent bots, each with its own state, lock and wallet.
4. The engine restarts once, exactly as in Stage C.

**Verify each bot:**
- its own heartbeat and candles (1m bots poll every minute);
- its profile hash (ALPHA-01 `0932a1a0cfac03f9`, ALPHA-03 `d828caa44611ad73`, ALPHA-04 `a6336dad6ffaed70`);
- that its destination is the bot ledger;
- that it reports $10 risk.

## What capital actually buys

**Basic facts:**
- Risk per trade = quantity × stop distance. The quantity is capped by the bot's own wallet, so in practice **risk ≈ wallet × stop %** until it reaches the $10 target.
- Fees are 0.20% per fill, about 0.40% of notional per round trip. **Measured against the stop, fees are about 0.40% ÷ stop %, whatever the capital.**
  - At a 0.55% stop (ALPHA-02's live order today), fees are about 0.7 R.
  - The tighter stops of 1-minute bots make the fee share larger.
- That is a property of the strategy plus the fee model. More capital lets the $10 risk target take effect, but it does not change the fee share.

**Minimum order** (Kraken, prices at 06:5x UTC: SOL $70.68, BTC $64,478):
- SOL bots: 0.05 SOL, about $3.54 including fee.
- BTC bots: 0.00006 BTC, about $3.88.

| Option | Split | Risk per trade at a 0.5% stop | Notes |
|---|---|---|---|
| **A. Existing capital only** ($99.97 total) | SOLANA $40 → ALPHA-01 $20, ALPHA-02 +$20 ($29.97). BITCOIN $40 → $20 each. MAIN keeps $10 | ≈ $0.10–$0.15 | Every bot trades, but at cents of risk; $10 risk never applies. Fine for checking the full lifecycle; results are dominated by rounding and fees |
| **B. Larger simulated account** (recommended for evaluating the strategies) | Add simulated PAPER capital to MAIN (Wallets → deposit; simulated, never real money), for example $10,000. Then $2,500 per bot via SOLANA and BITCOIN allocations | $10 (the target binds at a stop ≥ 0.4%; tighter stops are still capital-capped at $2,500 × stop %) | Positions near the size the $10 rule intends. Each bot's P&L, fees and drawdown are then meaningful |
| **C. Balanced middle** | Deposit to make $4,000; $1,000 per bot | ≈ $5 at a 0.5% stop | A compromise; the $10 target applies only at stops of 1% or more |

**Recommendation:**
- Option B: about $2,500 per bot of simulated capital. Activate one bot at a time (ALPHA-01, then ALPHA-03, then ALPHA-04) and verify each before the next.
- No leverage and no borrowing: SHORTs stay fully collateralised from each bot's own wallet.

**Separate approvals needed:**
- any deposit;
- each allocation;
- each activation.

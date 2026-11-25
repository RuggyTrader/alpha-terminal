# ALPHA TERMINAL research status (updated 2026-11-23)

**2026-11-23 update:**
* **Historical research resumed** at the owner's request, in parallel with the unchanged P1 forward PAPER study (first decision 2026-11-24).
* **Round 10** (drawdown-budget strategies N1–N3 under the 15 % limit): all **REJECTED**. See `round10/REPORT.md`.
* **Strongest candidate remains S3-25:**
  * 7.4 %/yr, DD 13.1 % (2018–26, reused data);
  * now also positive on never-used data (BTC 2014–16: 5.8 %/yr, DD 10.6 %).
* Nothing was deployed or merged. Production, the four bots, S3, balances and settings are unchanged.

**2026-11-25 update:** Jupiter Perps research (Strategies A and B, 16 leveraged long/short candidates): **NONE QUALIFIES**. See `jupiter/REPORT.md`.
* The PAPER engine and the Jupiter adapter are built and tested (observation mode only; not scheduled).
* No wallet, no transactions, nothing deployed.

*Earlier status (2026-11-22), kept for the record:* strategy optimisation and backtesting were paused.

## Rejected (details in `FAILED-CANDIDATES.md`)

| Line | What was tested | Why rejected |
|---|---|---|
| Original OTE bots, rounds 1–9 | intraday Fibonacci/OTE variants, higher timeframes, rotation, tournament | negative or unproven out of sample |
| Spot, 2 % official drawdown | S3, DD2/Phase 3 A–D, drawdown-budget sizing (H-G1), wick capture (H-L1) | only **B** meets the official 2 % (≈ 1 %/yr); a hard 2 % trailing limit causes cash lock (≈ 0.6–1.4 %/yr achievable for every stream tested) |
| Independent signals (round S) | funding, exchange flows, stablecoin supply, Coinbase premium, sentiment | not confirmed on held-out 2022–26 data |
| Futures at $100 | CME Micro Ether one-contract probe; Coinbase nano; Bitnomial perps | whole contracts of $172–$862; margins and liquidation rules exceed a $100 account; perps US-only |
| **Trend-following, leveraged long/short (H1, H2) and relative momentum (H3)** | fractional simulator, BTC/ETH and 10-coin replication | no run within the 15 % ceiling; the BTC/ETH edge is borderline excluding 2017 and does **not** replicate (1/10 coins; pooled p ≈ 0.23) |

## Kept and verified (not deleted)

* **Best execution findings:**
  * Ndax market orders are the cheapest total cost for spot (0.20 % fee + spread);
  * Kraken post-only limit orders are the best method on Kraken.
* **Research infrastructure:**
  * Kraken official-archive loader with validation;
  * observed historical spreads;
  * verified fee and minimum-order history;
  * official high-water-mark drawdown in all backtesters;
  * 5-minute drawdown reconstruction;
  * MET and fractional perp simulators (independently audited);
  * signal screen;
  * **367 tests, all passing**.
* **Branches (local, never pushed):**
  * `research/costs`, `research/liquidity`, `research/futures`, `research/phase3`, `shadow/phase3`;
  * also kept: `research/strategy-select` and `research/dd2` (pushed earlier), `trial/s3-paper`, `lab/stage-0`.
  * Offline backup: `%USERPROFILE%\AlphaTerminal\backups\research-branches-20261122.bundle` (SHA-256 sidecar).
* **Private data** (outside Git): `%USERPROFILE%\AlphaTerminal\research\` (Kraken archive extracts with checksums, Tardis book summaries, Ndax history, signal datasets).

## Unresolved

1. **Strategy B (spot, official 2 %)** is compliant but earns ≈ 1 %/yr. It was never moved to forward PAPER.
2. **Yield on idle cash** (Kraken QCAD rewards, ~1.4 % net reported): an unverified lead, with peg risk counted in drawdown and a proposed federal ban on stablecoin rewards.
3. **Bitnomial "Small Size" perpetuals:** contract size and Ontario eligibility are unverified. They are listed by NinjaTrader with ~$1 margins and are likely US-only.
4. **Cash-and-carry funding capture:** excluded by an earlier owner instruction; not tested.
5. **The S3 shadow** keeps running unchanged. Its cost setting (0.20 % + 0.05 %) is about 1.4 pp/yr more optimistic than measured Ndax costs (documented).

## What would justify restarting research

Either of these:
* **A fundamentally different hypothesis with credible independent evidence**, meaning:
  * a published or otherwise documented effect not derived from our own backtests;
  * a plausible economic mechanism;
  * data that has not been used for our selections (e.g. a new market, or new forward data);
  * a return-to-worst-loss profile that could fit the risk targets (screen with `lab/efficiency.mjs` before any full test).
* **An explicit owner change** to:
  * **capital** (e.g. ≥ $1,600 for an unlevered ETF route; ≈ $4,200–21,000 for futures);
  * **execution route** (e.g. a verified Ontario-eligible product with fractional leveraged long/short);
  * **risk constraints** (the official 2 % spot limit; the 10 % / 15 % futures-research targets).

**Rejected ideas are not to be retested with different parameters to improve historical results.**

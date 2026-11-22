# Futures research, Phase 1: NinjaTrader feasibility for automated crypto futures from Ontario with $100 (2026-11-22)

**Scope:**
* Read-only research.
* No account was opened and nothing was traded.
* No production bot, S3 setting, balance or risk setting was touched, and nothing was deployed.

**Sources:** NinjaTrader's official pages, read 2026-11-22: eligibility, margins ("as of 2026-11-22"), commissions, account fees, pricing FAQ. Where only forum or third-party sources exist, this is stated.

**Drawdown targets:**
* The owner set this futures research line's targets: **preferred < 10 %, ceiling 15 %**.
* The official **2 %** requirement of the existing spot research is unchanged and not affected.

## Verdict

**$100 is NOT sufficient** for automated crypto-futures trading on NinjaTrader with compounding and a drawdown below 10–15 %. The platform and the Ontario eligibility are fine. The account size is the problem.

1. **No position sizing is possible.**
   * The smallest contract that can be held overnight with $100 is CME Micro Ether (MET, 0.1 ETH ≈ $172).
   * Each step is a whole contract, so exposure is either 0 % or ~170 % of equity, with nothing in between.
   * Compounding can only happen in jumps of one contract, which needs about another $100–170 of equity.
2. **One contract already exceeds the drawdown targets.**
   * At 1.7× effective leverage, an ETH fall of 6 % costs ~10 % of equity, and a 9 % fall costs ~15 %.
   * ETH has fallen more than that in a day many times. The worst Kraken day since 2018 was −64 % (Mar 2020).
   * The loss is **not** limited to the margin posted: a large gap can take the balance below zero.
3. **The broker's liquidation and fee rules bind immediately.**
   * NinjaTrader states that an account trading a $25-margin contract is liquidated **below $50**, i.e. at 2× intraday margin.
   * For MET's $50 day margin, a $100 balance sits at that same 2× level.
   * A margin call costs **$50**, and a forced liquidation **$10–$50**: up to half the account.
4. **Trading costs are large relative to equity.**
   * MET costs $0.69 per side all-in on the Free plan, so $1.38 per round trip = **1.4 % of equity per trade**.
   * 25 round trips a year would cost ~35 % of the account.
5. **Fixed and funding costs are disproportionate.**
   * Currency conversion: 1 %, **minimum 10 units** (10 % of a $100 CAD deposit).
   * Outgoing international wire: 30 units.
   * $35 inactivity fee per 30 days without a live trade (Free plan).
   * The Canadian bank's own wire fee comes on top.
6. **Unattended PAPER operation on NinjaTrader is not possible without opening an account.**
   * Real-time simulation data is free for **14 days**, then delayed. Sim+ ($35/month) is for **US residents only**.
   * Continuous real-time PAPER therefore requires a funded live account, which is not allowed now.
   * Unattended operation also needs an always-on Windows computer. This PC powers off daily, and a VPS would be a paid service.

**Estimated minimum realistic capital** (assumptions stated, not a recommendation):
* **MET (ETH):** about **$850–1,700**, so that one contract risks ~1–2 % of equity at a 5 % stop and position counts can scale.
* **MBT (BTC):** **$2,500–5,000**, given the $1,284 initial margin plus a buffer.

## 1. Ontario availability (VERIFIED, official)

* NinjaTrader: "Canadian residents of Ontario can open a live futures account with NinjaTrader." All other provinces and territories are excluded.
* The account is held by **NinjaTrader Clearing, LLC** (CFTC-registered FCM, NFA member).
* Funding is by wire unless the client has a US bank (ACH). Tax form W-8BEN.
* Policy page "last updated in April 2025".
* [Trade U.S. futures from Canada](https://ninjatrader.com/futures/trade-us-futures-from-canada/)

## 2. Crypto contracts, margins and costs (VERIFIED: margins page "as of 2026-11-22", commission schedule)

Notional uses Kraken prices on 2026-11-22: BTC ≈ $61,083, ETH ≈ $1,720.

| Contract | Exchange | Size | Notional | Day margin | Maintenance | Initial (overnight) | All-in fee per side (Free / Monthly / Lifetime) |
|---|---|---|---|---|---|---|---|
| **MET** Micro Ether | CME | 0.1 ETH | ~$172 | $50 | $45 | **$49.50** | $0.69 / $0.59 / $0.39 |
| MBT Micro Bitcoin | CME | 0.1 BTC | ~$6,108 | $100 | $1,167 | $1,283.70 | $1.74 / $1.64 / $1.44 |
| ET nano Ether | Coinbase Derivatives | 0.1 ETH* | ~$172 | $25 | $148 | $162.80 | $0.50 / $0.45 / $0.35 |
| BIT nano Bitcoin | Coinbase Derivatives | 0.01 BTC* | ~$611 | $25 | $345 | $379.50 | $0.50 / $0.45 / $0.35 |
| ETP nano Ether perp-style | Coinbase Derivatives | 0.1 ETH* | ~$172 | $85 | $170 | $170 | $0.50 / $0.50 / $0.35 |
| BIP nano Bitcoin perp-style | Coinbase Derivatives | 0.01 BTC (CFTC filing) | ~$611 | $130 | $260 | $260 | $0.50 / $0.45 / $0.35 |
| MSL Micro Solana | CME | — | — | $50 | $605 | $665.50 | $1.74 / $1.46 / $1.44 |
| BTC / ETH (standard) | CME | 5 BTC / 50 ETH | — | $20,000 / $2,500 | $58,305 / $22,366 | $64,136 / $24,603 | — |

\* Contract size per the exchange's published specs; not re-verified here.

**Notes:**
* **Long and short** are both allowed on all futures. Leverage is implied by margin, e.g. MET day margin $50 on $172 notional.
* **Margins change without notice.** The page states the risk team adjusts them in real time, and two reads of it on the same day returned different figures before settling.
* **Bitnomial "Small Size" US-dollar perpetuals** (margins $0.12–$2.94) appear on the margins page but **not** on the commission schedule. Other sources tie them to Kraken Derivatives US customers. Availability to an Ontario NinjaTrader account is **UNVERIFIED**, so they are excluded from the verdict. If they were available, their tiny contract sizes would remove obstacle 1 and must be checked first.
* **Spreads:** not published by NinjaTrader. They must be measured from market data (not done; a funded account or a data vendor is required).
* [Margins](https://ninjatrader.com/pricing/margins/) · [Commissions](https://ninjatrader.com/pricing/commissions/) · [Pricing and FAQ](https://ninjatrader.com/pricing/)

## 3. Fees and market data (VERIFIED, official account-fees page)

* **Plans:** Free ($0; $0.39/side micro) · Monthly ($99/month) · Lifetime ($1,499).
* **Deposits:** any amount > $0 unlocks plan features (ACH/debit $5 minimum).
* **Market data:** CME Level I, non-professional: $12/month bundle or $4/month per exchange, **free when the account is funded**. Level II is $48/month.
* **Treasury:**
  * currency conversion 1 % (minimum 10 units);
  * incoming wire free;
  * international outgoing wire 30 units;
  * account-closure fee if the balance is below the minimum wire withdrawal.
* **Trade management:** margin call $50; liquidation $10 (e-Nanos and perp-style) or $25 / $50 (first / repeat violation).
* **Minimum account activity fee:** $35 per 30 days on Free plans that log in but do not trade live.
* [Account and exchange fees](https://ninjatrader.com/pricing/account-fees/)

## 4. Historical data

**NinjaTrader:**
* Market Replay and historical data come with a funded account. Depth by instrument is not published on the pages read: **UNVERIFIED**.
* Free alternatives: contract-specific CME / Coinbase Derivatives history (basis, rolls, perp funding) is **not** freely available in our current sources.

**For research:**
* The underlying spot path can use Kraken's official archive, already held, which spans several cycles.
* Futures-specific costs (basis, roll, funding) would need to be modelled and labelled as estimates. This is possible, but contract-specific evidence needs a data vendor or a funded account.

## 5. Automation, risk controls, disconnect recovery

**Officially supported automation:**
* NinjaScript (C#) strategies in **NinjaTrader Desktop (Windows)**.
* ATM strategies (bracket stops and targets); server-side ATM since 8.1 (forum, NinjaTrader staff).

**Not confirmed:**
* Whether the **Free plan** may run fully automated strategies *live*. Older licences excluded it; recent forum answers say 8.1+ allows it.
* **UNVERIFIED**: to be confirmed with NinjaTrader before any live use. It does not matter for PAPER.

**Disconnect handling (official help guide):**
* Each strategy chooses Recalculate / Keep Running / Stop Strategy after a set disconnect delay, with restart attempts.
* Working orders accepted by the broker or exchange stay live while the PC is offline.
* Locally simulated orders, OCO links and trailing/ATM logic stop working unless server-side.
* Help guide: [ConnectionLossHandling](https://ninjatrader.com/support/helpGuides/nt8/connectionlosshandling.htm). Stop/order residency per forum (staff); varies by order type and version.

**Account-level risk controls:**
* Broker-side auto-liquidation exists (margin violations), and partner documentation mentions trailing-drawdown and daily-loss limits.
* Retail configurability for an Ontario NinjaTrader account is **UNVERIFIED**.

**Fully unattended PAPER:**
* Possible only on the built-in simulation (Sim101) with real-time data during a **14-day trial**. After that, data is delayed for non-US users unless the account is funded.
* It also requires a Windows machine running continuously. This PC is powered off regularly, and a VPS would be a paid service.

## 6. What would make this research line workable (decisions for the owner)

1. **Account size:**
   * keep $100 and accept that only one fixed-size contract (~1.7×) is possible, which conflicts with the 10–15 % drawdown target; **or**
   * research at a realistic simulated size, $1,000–5,000.
2. **Verify Bitnomial small-size perpetuals** for Ontario NinjaTrader accounts. If available, they would allow fine position sizing at $100. This needs a support question to NinjaTrader; it is the owner's call.
3. **PAPER architecture:** our own simulator on free public data (Kraken spot paths plus modelled futures costs) avoids opening an account. NinjaTrader's own simulator needs a funded account beyond 14 days.

No new strategy has been developed. This verdict precedes strategy work, as requested.

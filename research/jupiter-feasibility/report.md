# Jupiter Perps historical data feasibility (SOL / ETH / wBTC)

Date: 2026-11-25. Branch `research/jupiter-feasibility`. Read-only, keyless, one small sample per source. Raw samples are in `raw/`, all under 1 MB. Program: `PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu`.

## Table

| Field | Source / endpoint | History depth | Granularity | Cost | Verified |
|---|---|---|---|---|---|
| Candles (price) | Jupiter perps-api `/v1/market-stats` (24h only). `lite-api price/v3` (spot, current). No perps candle endpoint in the OpenAPI spec (`/trading-view/history` returned 404). | None (snapshot) | 24h aggregate | Free | Y (no history) |
| Candles (external) | Pyth Benchmarks returned an empty 404 on one try, so untested. The Jupiter oracle is Pyth (the sampled tx shows `UpdateManyWithPythLazer`). | Unknown | Unknown | Unknown | N |
| Long/short OI | None in the perps-api spec. The on-chain Custody account has `guaranteedUsd` (long) and global short sizes, per the docs. | Current state only. History needs account-state snapshots or tx replay. | – | RPC | N (docs read, no account decoded) |
| Borrow rate (hourly) | `/v1/pool-info?mint=` returns `longBorrowRatePercent` and `shortBorrowRatePercent`. Sample: SOL long 0.0015%, short 0.0006%. | Snapshot only | Current | Free | Y (snapshot) |
| Utilization / liquidity | `/v1/pool-info` (utilization %, available liquidity). `/v1/jlp-info` (AUM, per-custody AUM, APR). | Snapshot only | Current | Free | Y (snapshot) |
| Liquidations | `/v1/trades` has `orderType=Liquidation` and `liquidationFee`. | Unknown | Per event | Free | N. The endpoint returned 400 "walletAddress is required", so there's no market-wide query. |
| Fees: open/close, borrow, price impact | `/v1/trades` fields `baseFee`, `borrowFee`, `priceImpactFee`, `fee`. `/v1/pool-info` has `openFeePercent` 0.06 and `maxPriceImpactFeePercent` 0.94 (snapshots). | Per-wallet only | Per trade | Free | Partly. The current fee schedule is verified. Realized per-trade fees are not, because they need a wallet address. |
| On-chain tx history | Solana public RPC `getSignaturesForAddress` on the program. `api.mainnet-beta` gave 429 once, then 200 on retry. `solana-rpc.publicnode.com` gave 200. | Unknown. The retention limit was not tested. | Per tx | Free, rate-limited | Partly. Recent sigs work. The sampled tx was a keeper price/AUM refresh, not a trade or liquidation. |
| Dune | `api.dune.com` returned 401 (API key required). | – | – | Key needed | N, blocked |
| Flipside | Connection failed (HTTP 000) once. Not retried further. | – | – | – | N |
| DefiLlama | `api.llama.fi/summary/derivatives/...` returned 402 (paid). `summary/fees/jupiter-perpetual` returned 400 (slug not found). | – | – | Paid or unknown slug | N |
| Coinalyze | 401, API key required. It also covers CEX perps, not Jupiter. | – | – | Key needed | N, blocked |

## Confirmed vs assumed

**Confirmed**
- The official perps-api (OpenAPI at `https://perps-api.jup.ag/v1/docs`, no key) offers only current snapshots for market stats, pool info and JLP info.
- Its only historical endpoint, `/trades`, requires a wallet address.
- The Custody account docs list the on-chain fields that matter: `cumulativeInterestRate`, `hourlyFundingDbps`, `tradeImpactFeeScalar`, `assets.owned`, `assets.locked` and `guaranteedUsd`.
- Public RPC serves recent program signatures without a key.

**Assumed (not tested)**
- The RPC can serve program history back to launch. Retention and rate limits on bulk pulls are unknown.
- Trade and liquidation events can be decoded from tx logs or inner instructions using the IDL. The IDL itself was not fetched.
- OI and utilization history could be rebuilt from Custody account snapshots or historical tx replay. That is bulk indexing, which is out of scope here.
- Pyth Benchmarks could supply SOL, ETH and BTC price candles. Its one sample failed.
- The "history start" for every field is unknown.

## Decision: NO-GO on a keyless, free path

No free, keyless source gives observed history for OI, borrow rates, utilization, liquidations or realized market-wide fees. Every Jupiter API field I verified is a current snapshot. Every aggregator I tried (Dune, Coinalyze, DefiLlama derivatives) needs a key or payment. The only possible real history is on-chain, which means decoding raw transactions. That is bulk indexing, which is out of scope here, and it's unproven. Candles are an exception: they probably come from a Pyth or CEX price proxy, but that is also untested.

Don't backtest on Jupiter-specific borrow, OI or fee history yet. Fabricating it or using the current snapshot as history would be invalid.

## Next step (needs approval, pick one)

1. **Smallest:** approve a bounded on-chain probe. Fetch the IDL once, then decode about 20 trades and liquidations from one short slot window. Also test how far back public RPC history goes. This would settle the "assumed" list above.
2. **Also cheap:** approve starting a read-only snapshot logger for `pool-info` and `jlp-info`, run outside the bot. It would build real forward history of borrow rate and utilization (about 1 call/hour per market, free).
3. **Paid alternatives:** a free Dune key or a paid indexer (Dune, Helius or Flipside with a key). I did not sign up for any.

---

# Probe (on-chain, public RPC only)

Date: 2026-11-25/26 (RPC clock). RPC: `solana-rpc.publicnode.com`, no key. Samples are in `raw/probe/`, each under 1 MB. The decoder is `decode_events.py`; its output is `raw/probe/decoded_events.txt`.

## 1. IDL
- I fetched it from the community repo that Jupiter's docs point to: `julianfssen/jupiter-perps-anchor-idl-parsing`, `src/idl/jupiter-perpetuals-idl-json.json` (152 KB, 51 instructions). The GitHub API call was rate-limited once, so I used the raw URL.
- I did **not** fetch the on-chain IDL account, so I can't say this copy matches the deployed program.
- It defines the events I needed: `IncreasePositionEvent`, `DecreasePositionEvent`, `InstantIncrease/DecreasePositionEvent`, `LiquidateFullPositionEvent`. All carry `price`, `sizeUsdDelta`, `positionSide`, `feeUsd`, `positionFeeUsd`, `fundingFeeUsd` (the borrow fee), `priceImpactFeeUsd` and a timestamp. `LiquidateFullPositionEvent` also has `liquidationFeeUsd`.

## 2. Decoded transactions (19 of the 20 allowed)
- **Source:** the 200 most recent signatures of the SOL custody account. Only about half of them were trades; the rest were keeper `RefreshAssetsUnderManagement` calls.
- **Decoding:** events are emitted as self-CPI inner instructions with tag `e445a52e51cb9a1d` and an 8-byte event discriminator. A hand-written borsh decoder driven by the IDL decoded all of them, with no unknown events.
- **What I found:**

| Tx | Event | Count |
|---|---|---|
| tx_02, 12, 13, 18 | `InstantDecreasePositionEvent` (plus a `PoolSwapEvent` in tx_02) | 4 |
| tx_08, 11, 14 | `InstantCreateLimitOrderEvent` | 3 |
| tx_07, 15 | `ClosePositionRequestEvent` | 2 |
| the rest | `RefreshAssetsUnderManagement` (keeper) | 10 |

- **Not observed:** no `IncreasePosition` event and **no liquidation**. A liquidation needs a different instruction (`liquidateFullPosition4`), and I couldn't find one cheaply.
- **Decoded fields (3 SOL decreases that closed size):**

| Tx | Side | Price | Size closed | Total fee | Position fee | Borrow fee | Price impact |
|---|---|---|---|---|---|---|---|
| tx_12 | Short | 71.12 | $3,568 | $2.528 | $2.498 (about 0.07%) | $0.030 | $0.357 (0.01%) |
| tx_13 | Short | 71.11 | $7,890 | $6.261 | $5.523 | $0.739 | $0.789 |
| tx_18 | Long | 71.12 | $3,179 | $2.375 | $2.225 | $0.150 | $0.318 |

- **Units and timestamps:** USD values are scaled by 1e6. `openTime` is a unix timestamp in seconds, 2026-11-26 04:03–04:04 UTC.
- **tx_02:** a collateral-only decrease on a long, with `sizeUsdDelta` 0 and $0.0102 of borrow fee.
- **Fee arithmetic:** `feeUsd` = position fee + borrow fee (2.497692 + 0.029919 = 2.527611). Price impact is reported separately and isn't in `feeUsd`.

## 3. How far back RPC history goes
- **Paging:** `getSignaturesForAddress` on the program worked for 4 pages of 1,000 (about 4,000 signatures). The oldest I retrieved was 2026-11-26 01:56 UTC, about 2 hours before the newest. That is **not** a 2024 transaction.
- **Node retention:** `getBlockTime` for slot 267,000,000 (about mid-2024) returned "cleaned up, does not exist on node. First available block: 473472840". `getFirstAvailableBlock` returned 473,474,615. That's about 530k slots behind the tip, or roughly 2.5 days. **Publicnode keeps only about 2.5 days of history.**
- **Program-data account:** `getSignaturesForAddress` on it returned an empty list, so I couldn't use upgrade transactions to find an old signature.
- **`api.mainnet-beta`:** 429 on both tries, so it's untested and I stopped. Whether the Foundation endpoint reaches back to 2024 is unknown.
- **Old transaction:** no 2024 transaction was retrieved. I had no valid 2024 signature and found no safe cheap way to get one.
- **Volume:** about 1,000 program signatures per 30–35 minutes, so about 45–50k a day.

## 4. Pyth Benchmarks candles
- `benchmarks.pyth.network/v1/shims/tradingview/history` with `symbol=Crypto.SOL/USD`, resolution 60 and a 2024-06-01 window returned an empty 404 twice. The earlier probe tried it unencoded and this one URL-encoded.
- I stopped per the two-failure rule. **Pyth candle history is unverified.** I don't know whether the cause is the endpoint, the symbol or my network.

## Confirmed vs assumed

| Confirmed | Assumed or unknown |
|---|---|
| The IDL events decode real mainnet transactions. | The IDL copy matches the deployed program. |
| Price, size, side, fees, borrow fee, price impact and timestamp are all in the events. | Liquidation events decode correctly (none seen). |
| `IncreasePosition` events decode (none seen). | Pre-2026-11 history exists on any free RPC. |
| Free RPC works for recent data. | Pyth Benchmarks works. |
| Publicnode retains only about 2.5 days. | OI, utilization and borrow rate can be rebuilt from events. These are account state, not event fields. |

## Estimated requests to rebuild 1 year (rough)
- About 16–18M program signatures a year (about 48k a day × 365).
- Listing them takes about 17,000 `getSignaturesForAddress` pages of 1,000.
- About half of the SOL-custody transactions were trades. The program-wide share is unknown, since keeper refreshes dominate the program signatures.
- Decoding every trade means at least 1 `getTransaction` call per trade, in the millions. That is bulk indexing.
- Even a single-market subset is millions of calls. A free public RPC can't do it, and it has no history that far back anyway.

## Updated decision: NO-GO on free RPC for history. Narrow GO only for forward capture.

**Reason:** the data is decodable, but the free public RPC I could reach doesn't hold it. Publicnode has only about 2.5 days, and a year of history needs an archival provider or an indexer. The Foundation endpoint is untested. Candle history is unverified. Open interest, utilization and borrow-rate history can't come from trade events alone.

**Next step (needs approval):** pick one.
1. **Forward capture:** run a read-only collector outside the bot. It would poll `pool-info` and `jlp-info` hourly and decode new trade and liquidation events from public RPC. This builds real observed history from now on, with no cost.
2. **Archival access:** approve either a free-tier archival RPC or indexer account, or a paid Dune plan. That's the only route to 2024-2025 backfill, and I haven't signed up for any.
3. **Candles:** approve one more candle source, such as Binance or Coinbase public klines or Pyth via another host, to price-proxy SOL, ETH and BTC. These are not Jupiter's own prices.

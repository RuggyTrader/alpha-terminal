# ALPHA TERMINAL — development instructions (permanent)

- **Universal position sizing is mandatory.** Every funded PAPER strategy, market, timeframe and instrument sizes from
  its wallet's available equity through `engine/src/sizing.mjs` (`sizePosition`), using its own entry in
  `engine/src/instruments.mjs`.
  - Defaults: 1% of equity, at most the risk setting ($10), fully paid, no shorts.
  - Never add fixed-dollar sizing for funded trading. Never reuse another market's rules.
  - Never raise a quantity to reach a risk target or minimum.
  - See `docs/UNIVERSAL-POSITION-SIZING.md`.
- **Regression gate:** `engine/test/sizing-acceptance.test.mjs` must pass. It covers every registry market
  automatically.
- **Adding a market or strategy:** follow `docs/MARKET-INTEGRATION-CHECKLIST.md`. Funded execution stays disabled until
  every item passes and the owner approves.
- **The Strategy Mirror is the exception:** hypothetical research with the original fixed risk and unlimited buying
  power. Keep it separate from funded positions, balances, records, performance and notifications.
- **Production:**
  - PAPER only; `ENABLE_TRADING=false`.
  - No deployment, migration, engine restart or configuration change without the owner's separate approval.
  - Never print or commit secrets. Never restore D1 as a recovery step.

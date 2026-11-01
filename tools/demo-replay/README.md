# DEMO_UI_REPLAY — local visual demo (development only)

A deterministic, in-memory replay of two **simulated** PAPER trades so you can watch the ALPHA TERMINAL
dashboard animate. It is a UI test tool, not trading.

* No database: everything lives in memory in `server.mjs` and resets when it stops.
* No broker, no TradingView, no Worker: the server makes no outbound requests and listens on 127.0.0.1 only.
* Every record is tagged `DEMO_UI_REPLAY` / `[SIM_TEST]`; every price is a **SIMULATED DEMO PRICE**.
* The demo banner and controls (`frontend/src/terminal/demo/`) load only in the Vite **dev** server with
  `VITE_DEMO_UI=1`, and only render on localhost. Production builds drop them (`import.meta.env.DEV` is false),
  even if `VITE_DEMO_UI=1` is set. The deployed Worker has no `/api/__demo` routes. Nothing here is deployed.

## Run

Two terminals:

```bash
node tools/demo-replay/server.mjs
```

```bash
cd frontend
ALPHA_BACKEND_URL=http://127.0.0.1:8799 VITE_DEMO_UI=1 npx vite --port 5182
```

Open http://127.0.0.1:5182 (phone size ≈ 402 × 874 in your browser's device mode), then use:

| Control | Does |
|---|---|
| **START DEMO** | plays from the current step (from the beginning when idle or finished) |
| **FULL REPLAY** | resets and plays both trades, ~80 s |
| **WINNING TRADE** / **LOSING TRADE** | plays only that trade |
| **PAUSE** | stops the timer at the current step |
| **RESET DEMO** | back to step 0 |

`DEMO_STEP_MS` changes the step length (default 4000 ms); `DEMO_PORT` the port (default 8799).

## Isolation tests

```bash
node --test "tools/demo-replay/test/*.test.mjs"
```

13 checks: loopback-only bind; no outbound network, database or broker code; every record marked
`DEMO_UI_REPLAY` / `[SIM_TEST]` and every price `SIMULATED DEMO PRICE`; no outbound calls while running;
production frontend builds (with and without `VITE_DEMO_UI=1`) contain none of the demo markers; the demo module
is imported only behind the dev guard; the Worker source and dry-run deploy bundle have no demo route or marker,
`ENABLE_TRADING` is `"false"`, and there is no `/v2/orders` or non-GET broker call.

## Timeline (20 steps)

| Steps | Winning trade — SPY BUY 10 @ $500.00 |
|---|---|
| 1–4 | alert received → validation passed → risk APPROVED → dry-run order intent |
| 5 | position opens, unrealized +$0.00 |
| 6–9 | simulated price 500.42 / 500.875 / 501.34 / 501.86 → +$4.20 / +$8.75 / +$13.40 / +$18.60 |
| 10 | closed in profit +$18.60 → Trade History; equity $25,018.60 |

| Steps | Losing trade — QQQ BUY 5 @ $420.00 |
|---|---|
| 11–14 | alert → validation → risk APPROVED → dry-run order intent |
| 15 | position opens |
| 16–19 | simulated price 419.58 / 418.94 / 418.32 / 417.46 → −$2.10 / −$5.30 / −$8.40 / −$12.70 |
| 20 | simulated stop, closed −$12.70 → Trade History; equity $25,005.90 |

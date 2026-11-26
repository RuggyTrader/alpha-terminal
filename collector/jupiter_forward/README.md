# Jupiter Perps forward collector (read-only)

Hourly snapshot of perps-api `pool-info` / `market-stats` (per SOL, ETH, BTC mint) and `jlp-info`, plus decoded
trade/liquidation events from public RPC (max 200 getTransaction per run). SQLite: `/workspace/ruggy/data/jupiter/jupiter.db`,
log: `collector.log` there. Public endpoints only, no keys/wallets/signing, no LLM calls.

- Tables: runs, pool_info, market_stats, jlp_info, jlp_custody, events, gaps, kv. Raw JSON kept in `raw_json`; all timestamps UTC.
- Never backfills. `gaps` records failed endpoints, missed hourly runs (>90 min), listing-cap overflow, and signatures
  skipped by the 200-tx cap. Event capture is therefore a SAMPLE (~10-25% of program txs/hour, most are keeper refreshes), not complete.
- `long_guaranteed_usd` (custody `guaranteedUsd`) is a long-side proxy, not exact long OI; `short_oi_usd` = `globalShortSizes`.
- Tests (offline): `python3 -I -m unittest discover -s collector/jupiter_forward/tests`
- Cron: `./install_cron.sh` (suggested line: `7 * * * * python3 -I .../collect.py >> .../cron.log 2>&1`).
- Decoder adapted from research/jupiter-feasibility/raw/decode_events.py; IDL is the community copy (unverified against deployed program).

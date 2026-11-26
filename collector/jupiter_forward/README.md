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

## Scheduled GitHub Action (`.github/workflows/jupiter-collector.yml`)

Runs `ndjson_export.py` hourly (`7 * * * *`) plus manual `workflow_dispatch`. Uses only the default `GITHUB_TOKEN`
and public keyless endpoints. `collect.py` is unchanged; each run uses a throwaway SQLite DB and exports to dated NDJSON
(`<table>_<UTC-day>.ndjson`) under `data/jupiter/` on the orphan branch `data-jupiter` (created by the first run), plus
`state.json` (event cursor, last successful run, run-id counter) so ephemeral runs behave like the continuous box loop.
Failed/partial runs and gaps are exported as `runs`/`gaps` rows. Pushes retry on conflict; runs never overlap (`concurrency`).

**Caveats**
- GitHub cron is best-effort: scheduled runs can start late (often by many minutes under load) or be skipped entirely.
  A pause > 90 min is recorded as a `missed_schedule` gap on the next run; it is never backfilled.
- Scheduled workflows are automatically disabled after 60 days without repository activity (commits to the data branch
  by the workflow itself may not count as activity; re-enable in the Actions tab or push a commit to the default branch).
- Event capture from GitHub-hosted runner IPs depends on the public RPC not rate-limiting them; failures show up as gaps.
- Tests: `python3 -I -m unittest discover -s collector/jupiter_forward/tests` (includes `test_export.py`).

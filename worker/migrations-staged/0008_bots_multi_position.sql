-- STAGED (worker/migrations-staged/): deliberately NOT in migrations/, so `wrangler d1 migrations apply` can never apply
-- it by accident. Stage M2 moves it into migrations/ (or runs it with `d1 execute --file`) after its own approval.
-- Independent bots, step 2 (docs/MULTI-BOT-ARCHITECTURE.md stage M2). NOT APPLIED: only when a SECOND bot on the same
-- market (e.g. ALPHA-01 SOLUSD 1m next to ALPHA-02 SOLUSD 5m) is approved, and only after the fleet Worker (which
-- upserts on (bot_id, symbol)) is live.
-- Removes the old one-open-position-per-symbol rule; ux_paper_positions_open_owner (one per bot and symbol, 0007)
-- remains, and owner '' (no bot) keeps exactly the old rule through it.
-- After this migration a Worker older than the fleet release must NOT be redeployed (its upsert targets the dropped
-- index): roll back with entries paused instead (docs/MULTI-BOT-ARCHITECTURE.md §9).
DROP INDEX IF EXISTS ux_paper_positions_open_symbol;

INSERT INTO app_meta (key, value) VALUES ('schema_version', '8')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

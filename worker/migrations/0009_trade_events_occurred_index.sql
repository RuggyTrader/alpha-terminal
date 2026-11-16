-- 0009 (candidate, 2026-11-16): bounded older-history pages for ALPHA Activity.
-- GET /api/dashboard/events?before=<time> orders trade_events by (occurred_at, id). Without this index each older page
-- scans the rows before the cursor and sorts them (about N/2 rows at N events; 50,000 at 100,000 events, measured
-- locally by tools/ops/activity-index-model.mjs); with it, a page visits about 30 rows. Purely additive: one index,
-- no table or data change. The newest-page query (ORDER BY id) is unaffected.
CREATE INDEX IF NOT EXISTS idx_trade_events_occurred ON trade_events(occurred_at, id);

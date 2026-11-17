-- 0009 (candidate, 2026-11-17): engine outage detection, run by the Worker's existing one-minute cron on Cloudflare (not
-- on the engine's PC). PURELY ADDITIVE: one new table and one index; no existing table, row or index is touched.
-- One row per outage episode per bot and kind:
--   ENGINE_OFFLINE    the bot's engine has sent no report for longer than its threshold (stops are not managed)
--   REPORT_DELAYED    reports are late (more than 2 candles + 2 min) but not yet offline: recorded, NOT pushed
--   MARKET_DATA_STALE the engine reports, but its candles have stopped advancing
-- A paused bot that keeps reporting is NOT an outage. Alerts are push notifications to enabled devices.
CREATE TABLE IF NOT EXISTS engine_outages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ENGINE_OFFLINE', 'REPORT_DELAYED', 'MARKET_DATA_STALE')),
  started_at TEXT NOT NULL,
  last_report_at TEXT,
  ended_at TEXT,
  alerted_at TEXT,
  alert_devices INTEGER NOT NULL DEFAULT 0,
  recovery_alerted_at TEXT,
  UNIQUE (bot_id, kind, started_at)
);
CREATE INDEX IF NOT EXISTS idx_engine_outages_open ON engine_outages (bot_id, kind, ended_at);

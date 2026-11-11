-- Trade events, the activity feed and Web Push notifications (worker/src/events.ts, worker/src/webpush.ts).
-- Additive only: new tables. No existing table, row, balance, position, fill or trade is changed.
--   mirror_open_events   explicit, durable Strategy Mirror ENTRY records from the engine (an entry is notified only
--                        when the engine confirms the hypothetical fill; never inferred from a pending order)
--   trade_events         one row per genuine trade event (funded PAPER fill, mirror entry, mirror close), unique key
--   push_subscriptions   devices that enabled notifications (endpoint + public keys; no secret of ours)
--   push_deliveries      one row per event and device: at most one notification per event per device
--   event_cursors        how far each source table has been turned into events
-- The cursors start at the CURRENT end of each source, so records that existed before this migration never become
-- notifications (no flood after a deploy).

CREATE TABLE IF NOT EXISTS mirror_open_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES mirror_accounts(account_id),
  event_id TEXT NOT NULL,                       -- <trade_id>:ENTRY
  trade_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  qty REAL NOT NULL CHECK (qty > 0),
  entry_time TEXT NOT NULL,
  entry_price REAL NOT NULL CHECK (entry_price > 0),
  stop_price REAL,
  tp2_price REAL,
  classification TEXT NOT NULL CHECK (classification IN ('historical', 'catch_up', 'live')),
  entry_candle_json TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  UNIQUE (account_id, event_id),
  UNIQUE (account_id, seq)
);

CREATE TABLE IF NOT EXISTS trade_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,               -- FILL:<paper_fills.id> | MOPEN:<mirror_open_events.id> | MCLOSE:<mirror_trades.id> | TEST:<sub>:<n>
  kind TEXT NOT NULL CHECK (kind IN ('FUNDED_ENTRY', 'FUNDED_ADD', 'FUNDED_REDUCE', 'FUNDED_CLOSE', 'MIRROR_ENTRY', 'MIRROR_CLOSE', 'TEST')),
  source TEXT NOT NULL CHECK (source IN ('funded', 'mirror', 'system')),
  symbol TEXT,
  side TEXT,
  qty REAL,
  price REAL,
  pnl REAL,                                     -- funded: realized P&L recorded by the ledger; mirror: hypothetical gross
  pnl_net REAL,                                 -- mirror: modelled net (comparison); funded: same as pnl
  fees REAL,
  classification TEXT NOT NULL DEFAULT 'live' CHECK (classification IN ('historical', 'catch_up', 'live')),
  ref TEXT,                                     -- trade id / mirror trade id
  account_id TEXT,
  url TEXT,                                     -- in-app page that proves the event
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT,
  prefs_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT,
  disabled_reason TEXT
);

CREATE TABLE IF NOT EXISTS push_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES trade_events(id),
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'expired', 'skipped')),  -- sending: claimed, outcome not yet recorded
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_attempt_at TEXT,
  sent_at TEXT,
  error TEXT,
  UNIQUE (event_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_push_deliveries_pending ON push_deliveries (status, id);

CREATE TABLE IF NOT EXISTS event_cursors (
  name TEXT PRIMARY KEY,
  last_id INTEGER NOT NULL
);
INSERT OR IGNORE INTO event_cursors (name, last_id) VALUES ('paper_fills', (SELECT COALESCE(MAX(id), 0) FROM paper_fills));
INSERT OR IGNORE INTO event_cursors (name, last_id) VALUES ('mirror_trades', (SELECT COALESCE(MAX(id), 0) FROM mirror_trades));
INSERT OR IGNORE INTO event_cursors (name, last_id) VALUES ('mirror_open_events', 0);

INSERT INTO app_meta (key, value) VALUES ('schema_version', '6')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

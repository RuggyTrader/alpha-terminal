CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  source_ip TEXT,
  symbol TEXT,
  action TEXT,
  strategy TEXT,
  order_type TEXT,
  requested_qty TEXT,
  accepted_qty TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  validation_result TEXT,
  response_code TEXT,
  http_status INTEGER,
  rejection_reason TEXT,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  last_duplicate_at TEXT
);

CREATE TABLE IF NOT EXISTS risk_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_fk INTEGER,
  decided_at TEXT NOT NULL,
  approved INTEGER NOT NULL,
  code TEXT NOT NULL,
  reason TEXT NOT NULL,
  side TEXT,
  final_qty TEXT,
  reference_price TEXT,
  reference_price_time TEXT,
  estimated_notional TEXT,
  checks_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (alert_fk) REFERENCES alerts(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_fk INTEGER,
  source TEXT NOT NULL DEFAULT 'webhook',
  client_order_id TEXT NOT NULL UNIQUE,
  alpaca_order_id TEXT UNIQUE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty TEXT NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'market',
  time_in_force TEXT NOT NULL DEFAULT 'day',
  status TEXT NOT NULL DEFAULT 'submitting',
  market_open_at_submit INTEGER,
  submitted_at TEXT NOT NULL,
  alpaca_created_at TEXT,
  filled_qty TEXT NOT NULL DEFAULT '0',
  filled_avg_price TEXT,
  filled_at TEXT,
  canceled_at TEXT,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT,
  error_detail TEXT,
  FOREIGN KEY (alert_fk) REFERENCES alerts(id)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  strategy TEXT,
  open_alert_id TEXT,
  open_order_id TEXT,
  close_order_id TEXT,
  entry_qty TEXT NOT NULL,
  entry_avg_price TEXT NOT NULL,
  exit_qty TEXT NOT NULL DEFAULT '0',
  exit_avg_price TEXT,
  open_qty TEXT NOT NULL,
  closed_cost_basis TEXT NOT NULL DEFAULT '0',
  realized_pnl TEXT NOT NULL DEFAULT '0',
  return_pct TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  leg_order_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  category TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  alert_id TEXT,
  symbol TEXT,
  action TEXT,
  strategy TEXT,
  qty TEXT,
  validation_result TEXT,
  risk_result TEXT,
  rejection_reason TEXT,
  alpaca_order_id TEXT,
  alpaca_status TEXT,
  error_detail TEXT
);

CREATE TABLE IF NOT EXISTS engine_state (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'STOPPED',
  kill_switch INTEGER NOT NULL DEFAULT 0,
  killed_at TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_received_at
  ON alerts(received_at);

CREATE INDEX IF NOT EXISTS idx_activity_ts
  ON activity_events(ts);

CREATE INDEX IF NOT EXISTS idx_orders_status
  ON orders(status);

CREATE INDEX IF NOT EXISTS idx_trades_status
  ON trades(status);

INSERT OR IGNORE INTO engine_state (
  id, state, kill_switch, updated_at, updated_by
) VALUES (
  1, 'STOPPED', 0, datetime('now'), 'migration'
);

INSERT OR IGNORE INTO app_meta (key, value)
VALUES ('schema_version', '1');
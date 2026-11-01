-- ALPHA PAPER ledger: internal simulated positions built from accepted DRY-RUN order intents.
-- Not broker positions. Fill prices are the truthful reference price used by the risk decision.

-- One row per position lifecycle (OPEN -> CLOSED). Long only: short selling is disabled.
CREATE TABLE IF NOT EXISTS paper_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT 'long' CHECK (side = 'long'),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  qty REAL NOT NULL CHECK (qty >= 0),
  avg_entry_price REAL NOT NULL CHECK (avg_entry_price > 0),
  multiplier REAL NOT NULL CHECK (multiplier > 0),
  strategy TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  -- Totals for the trade record: every buy and every sell over the lifecycle.
  entry_qty_total REAL NOT NULL,
  entry_value_total REAL NOT NULL,
  exit_qty_total REAL NOT NULL DEFAULT 0,
  exit_value_total REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  -- Last truthful mark. Never estimated; kept when a refresh fails.
  mark_price REAL,
  mark_at TEXT,
  mark_source TEXT,
  mark_error TEXT,
  mark_error_at TEXT,
  -- Unrealized P&L last written to activity_events (to avoid one event per poll).
  logged_unrealized_pnl REAL,
  open_alert_id TEXT NOT NULL,
  open_order_id TEXT NOT NULL,
  last_order_id TEXT NOT NULL,
  close_alert_id TEXT,
  close_order_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK (status = 'CLOSED' OR qty > 0),
  CHECK (status = 'OPEN' OR (qty = 0 AND closed_at IS NOT NULL))
);

-- At most one OPEN position per symbol.
CREATE UNIQUE INDEX IF NOT EXISTS ux_paper_positions_open_symbol
  ON paper_positions(symbol) WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_paper_positions_status
  ON paper_positions(status);

-- One simulated fill per accepted DRY-RUN order intent (UNIQUE order_fk): a duplicate alert or a
-- retried request can never apply the same intent to a position twice.
CREATE TABLE IF NOT EXISTS paper_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_fk INTEGER NOT NULL UNIQUE,
  client_order_id TEXT NOT NULL UNIQUE,
  alert_id TEXT NOT NULL,
  risk_decision_fk INTEGER,
  position_fk INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  kind TEXT NOT NULL CHECK (kind IN ('OPEN', 'ADD', 'REDUCE', 'CLOSE')),
  qty REAL NOT NULL CHECK (qty > 0),
  price REAL NOT NULL CHECK (price > 0),
  price_source TEXT NOT NULL,
  price_at TEXT NOT NULL,
  realized_pnl REAL NOT NULL DEFAULT 0,
  position_qty_after REAL NOT NULL,
  avg_entry_after REAL NOT NULL,
  filled_at TEXT NOT NULL,
  FOREIGN KEY (order_fk) REFERENCES orders(id),
  FOREIGN KEY (position_fk) REFERENCES paper_positions(id)
);

CREATE INDEX IF NOT EXISTS idx_paper_fills_position
  ON paper_fills(position_fk);

-- Trades: a closed ALPHA PAPER position becomes one trade (UNIQUE position_fk).
-- source has no default: the ledger always writes 'ALPHA_PAPER' explicitly; other rows stay NULL (unspecified).
ALTER TABLE trades ADD COLUMN source TEXT;
ALTER TABLE trades ADD COLUMN position_fk INTEGER;
ALTER TABLE trades ADD COLUMN close_alert_id TEXT;
ALTER TABLE trades ADD COLUMN price_sources TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_trades_position
  ON trades(position_fk) WHERE position_fk IS NOT NULL;

-- Activity: link ledger events to their position.
ALTER TABLE activity_events ADD COLUMN position_fk INTEGER;

-- Alerts: retry bookkeeping. An alert whose attempt committed nothing (status 'error', or stuck in
-- 'processing') can be resent and processed again; attempt_count records how many times.
ALTER TABLE alerts ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE alerts ADD COLUMN last_attempt_at TEXT;

UPDATE app_meta SET value = '2' WHERE key = 'schema_version';

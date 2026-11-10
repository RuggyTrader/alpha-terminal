-- Strategy Mirror V1 (worker/src/mirror.ts, engine/src/mirror.mjs): the original strategy's HYPOTHETICAL
-- TradingView-style trades (margin 0 = unlimited buying power), recorded apart from the funded ALPHA PAPER ledger.
-- Additive only: three new tables. No existing table, row, balance, position, fill or trade is touched, and the
-- funded ledger never reads these tables. Workers released before this migration ignore them.

CREATE TABLE IF NOT EXISTS mirror_accounts (
  account_id TEXT PRIMARY KEY,                 -- MIRROR-<symbol>-<tf>m-<strategy inputs hash>
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  profile TEXT,
  strategy TEXT,
  inputs_hash TEXT NOT NULL,
  engine_version TEXT,
  engine_release TEXT,
  engine_commit TEXT,
  created_at TEXT NOT NULL,                     -- first seen by the Worker
  engine_created_at TEXT,
  activated_at TEXT,                            -- engine-reported start of live observation (set once)
  reporting_equity_usd REAL NOT NULL DEFAULT 10000 CHECK (reporting_equity_usd > 0), -- reporting baseline only
  cost_profile TEXT NOT NULL DEFAULT 'ndax',    -- cost-model COMPARISON only; never charged to any balance
  last_contiguous_seq INTEGER NOT NULL DEFAULT 0,
  max_seq_seen INTEGER NOT NULL DEFAULT 0,
  engine_last_seq INTEGER,
  conflicts INTEGER NOT NULL DEFAULT 0,
  last_conflict_json TEXT,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_candle_time TEXT,
  last_candle_close REAL,
  candles_processed INTEGER,
  risk_usd REAL,
  open_position_json TEXT,
  engine_health_json TEXT                       -- pending/refused counts, resets, interruptions, last error
);

CREATE TABLE IF NOT EXISTS mirror_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES mirror_accounts(account_id),
  trade_id TEXT NOT NULL,                       -- MIR-<symbol>-<tf>-<entry candle>-<LONG|SHORT>, unique per account
  seq INTEGER NOT NULL CHECK (seq > 0),
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  qty REAL NOT NULL CHECK (qty > 0),
  entry_time TEXT NOT NULL,
  entry_price REAL NOT NULL CHECK (entry_price > 0),
  exit_time TEXT NOT NULL,
  exit_price REAL NOT NULL CHECK (exit_price > 0),
  stop_price REAL,                              -- initial stop of the bracket the entry filled with
  tp2_price REAL,
  exit_kind TEXT NOT NULL CHECK (exit_kind IN ('TP', 'SL', 'CLOSE_ALL')),
  result TEXT NOT NULL CHECK (result IN ('TP2', 'SL', 'BREAK_EVEN', 'TRAILING_SL', 'TIME_EXIT', 'SAME_BAR', 'UNLABELLED')),
  exit_r REAL,
  gross_pnl REAL NOT NULL,                      -- TradingView-style gross P&L (0% commission, as configured)
  risk_usd REAL,
  notional_usd REAL NOT NULL,
  entry_order_type TEXT,
  entry_liquidity TEXT NOT NULL CHECK (entry_liquidity IN ('maker', 'taker')), -- inferred from order type
  exit_liquidity TEXT NOT NULL CHECK (exit_liquidity IN ('maker', 'taker')),   -- inferred from exit kind
  cost_profile TEXT NOT NULL,                   -- comparison model used for the estimates below
  est_fees REAL NOT NULL,
  est_slippage REAL NOT NULL,
  net_modelled_pnl REAL NOT NULL,               -- gross - est_fees - est_slippage (comparison only)
  classification TEXT NOT NULL CHECK (classification IN ('historical', 'catch_up', 'live')),
  entry_candle_json TEXT,
  exit_candle_json TEXT NOT NULL,
  entry_processed_at TEXT,
  processed_at TEXT NOT NULL,                   -- when the engine processed the exit candle
  exit_late INTEGER NOT NULL DEFAULT 0,
  provenance_complete INTEGER NOT NULL DEFAULT 1,
  received_at TEXT NOT NULL,
  reference_price REAL,                         -- Kraken price when a LIVE trade was received (comparison only)
  reference_price_at TEXT,
  engine_release TEXT,
  inputs_hash TEXT NOT NULL,
  profile TEXT,
  payload_hash TEXT NOT NULL,                   -- sha-256 of the engine's record: a retry must match it exactly
  UNIQUE (account_id, trade_id),
  UNIQUE (account_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_mirror_trades_account_exit ON mirror_trades (account_id, exit_time);

-- Hypothetical equity journal: baseline + every trade's gross P&L, plus recorded interruptions (no P&L).
-- Equity of a category = reporting baseline + SUM(amount_usd) of its REALIZED_GROSS_PNL entries.
CREATE TABLE IF NOT EXISTS mirror_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES mirror_accounts(account_id),
  entry_key TEXT NOT NULL UNIQUE,               -- PNL:<account>:<trade_id> | EVENT:<event id (starts with the account)>
  seq INTEGER CHECK (seq IS NULL OR seq > 0),
  kind TEXT NOT NULL CHECK (kind IN ('REALIZED_GROSS_PNL', 'POSITION_INTERRUPTED')),
  amount_usd REAL NOT NULL DEFAULT 0,
  trade_id TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('historical', 'catch_up', 'live')),
  created_at TEXT NOT NULL,
  detail_json TEXT,
  payload_hash TEXT,
  CHECK (kind = 'REALIZED_GROSS_PNL' OR amount_usd = 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mirror_entries_seq ON mirror_entries (account_id, seq) WHERE kind = 'POSITION_INTERRUPTED';

INSERT INTO app_meta (key, value) VALUES ('schema_version', '5')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

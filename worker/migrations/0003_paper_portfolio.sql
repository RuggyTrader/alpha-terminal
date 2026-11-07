-- ALPHA PAPER portfolio: one simulated portfolio made of the unallocated MAIN balance and one balance per
-- supported cryptocurrency strategy. PAPER money only: nothing here moves real funds or talks to a broker.
--
-- Amounts are INTEGER micro-dollars (1 USD = 1,000,000) so every sum is exact. The CHECK constraints make
-- negative available or reserved balances impossible, including under concurrent requests: a transfer or a
-- reservation that would overdraw a balance fails its whole D1 batch (one transaction) and changes nothing.

CREATE TABLE IF NOT EXISTS portfolio_wallets (
  wallet TEXT PRIMARY KEY,                       -- 'MAIN' (unallocated) or a strategy symbol
  kind TEXT NOT NULL CHECK (kind IN ('MAIN', 'STRATEGY')),
  available_micro INTEGER NOT NULL DEFAULT 0 CHECK (available_micro >= 0),
  reserved_micro INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0),   -- cost basis of open PAPER positions
  realized_pnl_micro INTEGER NOT NULL DEFAULT 0,                          -- closed PAPER trades only
  net_funding_micro INTEGER NOT NULL DEFAULT 0,                           -- deposits/transfers in minus out; never P&L
  updated_at TEXT NOT NULL,
  CHECK (kind = 'STRATEGY' OR (reserved_micro = 0 AND realized_pnl_micro = 0))
);

INSERT OR IGNORE INTO portfolio_wallets (wallet, kind, updated_at) VALUES
  ('MAIN', 'MAIN', '2026-11-07T00:00:00Z'),
  ('SOLUSD', 'STRATEGY', '2026-11-07T00:00:00Z'),
  ('ETHUSD', 'STRATEGY', '2026-11-07T00:00:00Z'),
  ('BTCUSD', 'STRATEGY', '2026-11-07T00:00:00Z'),
  ('HYPEUSD', 'STRATEGY', '2026-11-07T00:00:00Z'),
  ('KAITOUSD', 'STRATEGY', '2026-11-07T00:00:00Z');

-- Append-only accounting history. Every balance change is one row; a transfer is two rows sharing group_key.
-- For each wallet: available = SUM(available_change), reserved = SUM(reserved_change). entry_key is UNIQUE,
-- so a retried request or a duplicate signal can never apply twice.
CREATE TABLE IF NOT EXISTS portfolio_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_key TEXT NOT NULL UNIQUE,
  group_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT', 'TRANSFER_IN', 'RESERVE', 'RELEASE', 'REALIZED_PNL')),
  wallet TEXT NOT NULL REFERENCES portfolio_wallets(wallet),
  available_change_micro INTEGER NOT NULL,
  reserved_change_micro INTEGER NOT NULL DEFAULT 0,
  counterparty TEXT,          -- the other wallet of a transfer
  ref TEXT,                   -- alert id (fills) or request id (transfers, funding)
  position_fk INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_portfolio_entries_wallet ON portfolio_entries(wallet, id);

-- Which wallet funds a PAPER position and how much of its cost basis is still reserved. NULL wallet: the
-- position was opened before the portfolio was funded and is not part of it.
ALTER TABLE paper_positions ADD COLUMN wallet TEXT;
ALTER TABLE paper_positions ADD COLUMN reserved_micro INTEGER NOT NULL DEFAULT 0;

-- Versioned risk per trade for each strategy. A new version is PENDING until the engine confirms it has
-- applied it (APPLIED); older versions become SUPERSEDED. Fixed USD risk: never compounding.
CREATE TABLE IF NOT EXISTS strategy_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,                 -- strategy wallet symbol, e.g. 'SOLUSD'
  version INTEGER NOT NULL,
  risk_usd REAL NOT NULL CHECK (risk_usd > 0),
  compounding INTEGER NOT NULL DEFAULT 0 CHECK (compounding = 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPLIED', 'SUPERSEDED')),
  requested_at TEXT NOT NULL,
  applied_at TEXT,
  request_key TEXT UNIQUE,
  note TEXT,
  UNIQUE (strategy, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_strategy_settings_pending ON strategy_settings(strategy) WHERE status = 'PENDING';

-- SOLUSD starts at the solusd-5m profile's $10. It shows as Applied only after the engine confirms it.
INSERT OR IGNORE INTO strategy_settings (strategy, version, risk_usd, status, requested_at, request_key, note)
VALUES ('SOLUSD', 1, 10, 'PENDING', '2026-11-07T00:00:00Z', 'initial-solusd-5m', 'initial solusd-5m profile setting');

-- Verified engine backtests, cached for the dashboard (uploaded by the engine; computed off the request path).
CREATE TABLE IF NOT EXISTS backtest_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data_from TEXT NOT NULL,
  data_to TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE (strategy, config_hash, data_from, data_to)
);

INSERT INTO app_meta (key, value) VALUES ('schema_version', '3')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

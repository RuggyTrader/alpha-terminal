-- 0008: an ISOLATED forward PAPER research account for Candidate B (BTCUSD daily 50-day trend, LONG only).
-- Separate tables only: nothing here references or changes the production portfolio (portfolio_wallets, bots,
-- bot_positions, trades, funding). Its $100 is a research starting balance, not a deposit into the PAPER portfolio,
-- and its results are never part of the portfolio's P&L, balances or funding. Purely additive: no existing table changes.
-- The account starts PROPOSED; it runs only after the owner's one-time activation.

CREATE TABLE IF NOT EXISTS trial_accounts (
  account_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL,
  params_json TEXT NOT NULL,                       -- the frozen settings (worker/src/trial/ma50.ts PARAMS)
  start_equity_micro INTEGER NOT NULL CHECK (start_equity_micro > 0),
  cash_micro INTEGER NOT NULL CHECK (cash_micro >= 0), -- no leverage: cash never goes negative
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'ACTIVE', 'STOPPED')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  last_daily_t INTEGER,                            -- open time (ms) of the last daily candle processed
  last_minute_t INTEGER,                           -- end (ms) of the last intraday candle checked for fills / stops
  lock_until INTEGER,                              -- overlapping scheduled runs never act twice
  last_run_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS trial_orders (
  order_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES trial_accounts(account_id),
  kind TEXT NOT NULL CHECK (kind IN ('ENTRY', 'EXIT')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type TEXT NOT NULL DEFAULT 'MARKET' CHECK (order_type = 'MARKET'),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'FILLED', 'CANCELLED')),
  reason TEXT NOT NULL,
  signal_candle_t INTEGER NOT NULL,                -- the completed daily candle whose close produced the signal
  signal_close REAL NOT NULL,
  signal_sma REAL,
  atr_signal REAL,                                 -- ATR(14) at the signal close (entry: protective stop distance)
  created_at TEXT NOT NULL,                        -- submission
  accepted_at TEXT NOT NULL,                       -- acceptance by this ledger; a fill needs a candle starting at or after it
  fill_candle_t INTEGER, fill_interval_min INTEGER, ref_price REAL, fill_price REAL, slip_pct REAL,
  qty REAL, fee_micro INTEGER, filled_at TEXT, recorded_at TEXT, code TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_trial_orders_status ON trial_orders(account_id, status);

CREATE TABLE IF NOT EXISTS trial_positions (
  position_id TEXT PRIMARY KEY,                    -- = the entry order id
  account_id TEXT NOT NULL REFERENCES trial_accounts(account_id),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  side TEXT NOT NULL DEFAULT 'LONG' CHECK (side = 'LONG'),   -- LONG only: no SHORT, no borrowing
  qty REAL NOT NULL CHECK (qty > 0),
  entry_price REAL NOT NULL CHECK (entry_price > 0),
  entry_fee_micro INTEGER NOT NULL,
  cost_micro INTEGER NOT NULL,                     -- cash paid for the coins (fully paid)
  initial_stop REAL NOT NULL,
  stop REAL NOT NULL,
  stop_active_from INTEGER NOT NULL,               -- ms: the current stop applies to candles starting at or after this
  best_close REAL NOT NULL,
  risk_usd REAL NOT NULL,                          -- qty x (entry - initial stop): the actual risk taken
  opened_candle_t INTEGER NOT NULL,
  opened_at TEXT NOT NULL,
  exit_price REAL, exit_fee_micro INTEGER, exit_reason TEXT, exit_candle_t INTEGER, exit_interval_min INTEGER,
  closed_at TEXT, gross_micro INTEGER, net_micro INTEGER, recorded_late_min INTEGER,
  CHECK (stop >= initial_stop),                    -- a stop is never loosened below its initial level
  CHECK (status = 'OPEN' OR (closed_at IS NOT NULL AND exit_price IS NOT NULL AND net_micro IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_trial_positions_open ON trial_positions(account_id) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS trial_stop_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id TEXT NOT NULL REFERENCES trial_positions(position_id),
  at_candle_t INTEGER NOT NULL, old_stop REAL NOT NULL, new_stop REAL NOT NULL CHECK (new_stop > old_stop),
  best_close REAL NOT NULL, atr REAL NOT NULL, recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trial_equity (
  account_id TEXT NOT NULL REFERENCES trial_accounts(account_id),
  day_t INTEGER NOT NULL,                          -- daily candle open time; equity marked at its close
  close REAL NOT NULL,
  cash_micro INTEGER NOT NULL, position_qty REAL NOT NULL, equity_micro INTEGER NOT NULL,
  PRIMARY KEY (account_id, day_t)
);

CREATE TABLE IF NOT EXISTS trial_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT
);

INSERT OR IGNORE INTO trial_accounts (account_id, name, strategy, params_json, start_equity_micro, cash_micro, status, created_at)
VALUES ('TRIAL-BTC-MA50', 'BTC 50-day trend (forward PAPER trial)', 'BTC-MA50-LONG v1',
  '{"strategy":"BTC-MA50-LONG","version":1,"symbol":"BTCUSD","pair":"XBTUSD","timeframe":"1d","sma":50,"atr":14,"stopAtr":3,"trailAtr":3,"riskPct":2,"feePct":0.2,"slipPct":0.05,"minQty":0.00005,"minCost":0.5,"qtyStep":1e-8,"startEquityUsd":100,"long":true,"short":false,"leverage":false}',
  100000000, 100000000, 'PROPOSED', '2026-11-15T00:00:00Z');

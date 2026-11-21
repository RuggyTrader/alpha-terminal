-- 0010: S3 research-only forward SHADOW test (worker/src/trial/s3_runner.ts). A fully SIMULATED $100 account,
-- BTC $50 + ETH $50 sleeves, re-sized daily by the frozen S3 rule (worker/src/trial/s3.ts).
-- Separate tables only: nothing here references or changes the production portfolio, the funded PAPER ledgers
-- (portfolio_wallets, portfolio_entries, bots, bot_positions, trades), the mirror, or the 0008 trial's own rows.
-- Purely additive: no existing table or index changes. The account row reuses trial_accounts (status, lock, run log);
-- it starts PROPOSED and runs only after the owner's one-time activation.
-- Drawdown ALERTS at 2 % and 30 % are reporting thresholds only. Neither is an approved trading risk limit, and
-- neither stops or changes the simulation.

CREATE TABLE IF NOT EXISTS trial_alloc_sleeves (
  account_id TEXT NOT NULL REFERENCES trial_accounts(account_id),
  asset TEXT NOT NULL CHECK (asset IN ('BTC', 'ETH')),
  pair TEXT NOT NULL,                              -- Kraken pair (XBTUSD, ETHUSD)
  capital_usd REAL NOT NULL CHECK (capital_usd > 0),
  cash_usd REAL NOT NULL CHECK (cash_usd >= -1e-9), -- simulated; no leverage, no borrowing
  qty REAL NOT NULL CHECK (qty >= 0),              -- long only
  last_target REAL NOT NULL DEFAULT 0,             -- the target weight of the last EXECUTED order
  PRIMARY KEY (account_id, asset)
);

CREATE TABLE IF NOT EXISTS trial_alloc_orders (
  order_id TEXT PRIMARY KEY,                       -- account-asset-signal day: one decision per asset per day
  account_id TEXT NOT NULL REFERENCES trial_accounts(account_id),
  asset TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'FILLED', 'SKIPPED_MIN', 'MISSED', 'CANCELLED')),
  signal_candle_t INTEGER NOT NULL,                -- the completed daily candle whose close produced the decision
  signal_close REAL NOT NULL, sma REAL, vol REAL,
  target REAL NOT NULL, actual_weight REAL NOT NULL,
  accepted_at TEXT NOT NULL,                       -- a fill needs a candle STARTING at or after acceptance
  side TEXT CHECK (side IN ('BUY', 'SELL')),
  fill_candle_t INTEGER, fill_interval_min INTEGER, ref_open REAL, fill_price REAL,
  qty_raw REAL, qty REAL,                          -- before / after rounding to the exchange lot step
  notional_usd REAL, fee_usd REAL,
  min_qty REAL, min_cost REAL, min_usd REAL, full_exit INTEGER,
  recorded_at TEXT, recorded_late_min INTEGER, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_trial_alloc_orders_status ON trial_alloc_orders(account_id, status);

CREATE TABLE IF NOT EXISTS trial_alloc_days (      -- per asset, per completed daily close: the signal and the sleeve
  account_id TEXT NOT NULL REFERENCES trial_accounts(account_id),
  asset TEXT NOT NULL,
  day_t INTEGER NOT NULL,
  close REAL NOT NULL, sma REAL, vol REAL, target REAL, actual_weight REAL NOT NULL,
  cash_usd REAL NOT NULL, qty REAL NOT NULL, equity_usd REAL NOT NULL,
  PRIMARY KEY (account_id, asset, day_t)
);

CREATE TABLE IF NOT EXISTS trial_alloc_equity (    -- the whole simulated account, per completed daily close
  account_id TEXT NOT NULL REFERENCES trial_accounts(account_id),
  day_t INTEGER NOT NULL,
  equity_usd REAL NOT NULL, peak_usd REAL NOT NULL, drawdown_pct REAL NOT NULL, return_pct REAL,
  PRIMARY KEY (account_id, day_t)
);

INSERT OR IGNORE INTO trial_accounts (account_id, name, strategy, params_json, start_equity_micro, cash_micro, status, created_at)
VALUES ('TRIAL-S3-SHADOW', 'S3 shadow test (simulated $100, research only)', 'S3-SMA200-VOL40 v1',
  '{"strategy":"S3-SMA200-VOL40","version":1,"timeframe":"1d","assets":{"BTC":{"pair":"XBTUSD","minQty":0.00006,"minCost":0.5,"qtyStep":1e-8},"ETH":{"pair":"ETHUSD","minQty":0.002,"minCost":0.5,"qtyStep":1e-8}},"sma":200,"volDays":30,"volTarget":0.4,"band":0.1,"feePct":0.2,"slipPct":0.05,"startEquityUsd":100,"long":true,"short":false,"leverage":false,"alertsDrawdownPct":[2,30]}',
  100000000, 0, 'PROPOSED', '2026-11-21T00:00:00Z');   -- cash_micro 0: the cash is held per sleeve (trial_alloc_sleeves)

INSERT OR IGNORE INTO trial_alloc_sleeves (account_id, asset, pair, capital_usd, cash_usd, qty) VALUES
  ('TRIAL-S3-SHADOW', 'BTC', 'XBTUSD', 50, 50, 0),
  ('TRIAL-S3-SHADOW', 'ETH', 'ETHUSD', 50, 50, 0);

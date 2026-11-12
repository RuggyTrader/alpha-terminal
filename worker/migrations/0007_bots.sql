-- Independent bot fleet (docs/MULTI-BOT-ARCHITECTURE.md). NOT APPLIED to production: needs its own approval (stage M1).
-- ADDITIVE (new tables and columns), plus ONE lossless rebuild of the derived trade_events table (see below). No existing row's value, balance, quantity, price, P&L, fee or status
-- changes; existing indexes and constraints stay, so the Worker running today (and a rollback to it) keeps working.
--
--   allocation_groups  SOLANA, BITCOIN (ETHEREUM inactive): money allocated to a group is split equally between its
--                      ACTIVE funded bots, each into the bot's OWN wallet (portfolio_wallets row named by the bot id).
--   bots               the bots the ledger accepts orders from, with their own dollar risk, wallet and status.
--   bot_settings       versioned per-bot dollar-risk settings (requested on the website, confirmed by the bot's engine).
--   bot_orders         one row per engine order id (idempotency: a retried or duplicated order is never applied twice).
--   bot_positions      LONG or SHORT, owned by one bot; at most one OPEN per bot (pyramiding 0 per strategy instance).
--   bot_fills          one authoritative fee record per simulated fill (Ndax-equivalent 0.20% of the fill notional).
--   allocation_events  every owner allocation from MAIN to a group, with its exact per-bot split.
-- The legacy single-engine path (SOLUSD 5m via /webhook/dry-run, paper_positions) is unchanged; its rows get an owner
-- column (ALPHA-02's rows are labelled ALPHA-02, everything else stays unowned '').

CREATE TABLE IF NOT EXISTS allocation_groups (
  group_id TEXT PRIMARY KEY CHECK (group_id GLOB '[A-Z]*'),
  name TEXT NOT NULL,
  symbol TEXT NOT NULL UNIQUE
);
INSERT OR IGNORE INTO allocation_groups (group_id, name, symbol) VALUES
  ('SOLANA', 'Solana', 'SOLUSD'), ('BITCOIN', 'Bitcoin', 'BTCUSD'), ('ETHEREUM', 'Ethereum', 'ETHUSD');

CREATE TABLE IF NOT EXISTS bots (
  bot_id TEXT PRIMARY KEY CHECK (bot_id GLOB 'ALPHA-[0-9][0-9]'),
  name TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES allocation_groups(group_id),
  symbol TEXT NOT NULL,
  timeframe_min INTEGER NOT NULL CHECK (timeframe_min IN (1, 5, 15, 30, 60)),
  profile TEXT,
  inputs_hash TEXT,
  wallet TEXT NOT NULL UNIQUE,                       -- the bot's own wallet; never shared
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PROPOSED', 'DISABLED')),
  ledger_api TEXT NOT NULL CHECK (ledger_api IN ('bot', 'legacy')),
  legacy_default INTEGER NOT NULL DEFAULT 0 CHECK (legacy_default IN (0, 1)), -- owner of pre-fleet engine requests
  entries_paused INTEGER NOT NULL DEFAULT 0 CHECK (entries_paused IN (0, 1)), -- 1: new entries refused; exits still processed
  risk_usd REAL NOT NULL CHECK (risk_usd > 0),       -- dollar risk per trade for NEW orders (bot_settings history)
  priority INTEGER NOT NULL DEFAULT 99,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (symbol, timeframe_min, profile)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bots_legacy_default ON bots(symbol) WHERE legacy_default = 1;

-- The four bots. Only ALPHA-02 (today's production engine, legacy path, SOLUSD wallet) is ACTIVE; the others are
-- registered as PROPOSED with their exact profiles and inputs hashes, and trade nothing until approved.
INSERT OR IGNORE INTO bots (bot_id, name, group_id, symbol, timeframe_min, profile, inputs_hash, wallet, status, ledger_api, legacy_default, risk_usd, priority, created_at, updated_at) VALUES
  ('ALPHA-02', 'ALPHA 02', 'SOLANA', 'SOLUSD', 5, 'solusd-5m', 'c826d785d58a4a39', 'SOLUSD', 'ACTIVE', 'legacy', 1, 10, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ALPHA-01', 'ALPHA 01', 'SOLANA', 'SOLUSD', 1, 'solusd-1m', '0932a1a0cfac03f9', 'ALPHA-01', 'PROPOSED', 'bot', 0, 10, 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ALPHA-03', 'ALPHA 03', 'BITCOIN', 'BTCUSD', 1, 'btcusd-1m', 'd828caa44611ad73', 'ALPHA-03', 'PROPOSED', 'bot', 0, 10, 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ALPHA-04', 'ALPHA 04', 'BITCOIN', 'BTCUSD', 5, 'btcusd-5m', 'a6336dad6ffaed70', 'ALPHA-04', 'PROPOSED', 'bot', 0, 10, 4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
-- Their own wallets (empty: no capital is created; money arrives only through owner-approved allocations).
INSERT OR IGNORE INTO portfolio_wallets (wallet, kind, updated_at) VALUES
  ('ALPHA-01', 'STRATEGY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ALPHA-02', 'STRATEGY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ALPHA-03', 'STRATEGY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ALPHA-04', 'STRATEGY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
-- An uncovered loss (a simulated short moving beyond its collateral and the bot's cash) is recorded, never hidden:
-- identity per wallet: available + reserved = net funding + realized P&L - fees (realized = what the wallet paid);
-- shortfall_micro is the part of a loss the wallet could not pay (a liability; the bot's entries are paused).
ALTER TABLE portfolio_wallets ADD COLUMN shortfall_micro INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS bot_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(bot_id),
  version INTEGER NOT NULL CHECK (version > 0),
  risk_usd REAL NOT NULL CHECK (risk_usd > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPLIED', 'SUPERSEDED')),
  request_key TEXT UNIQUE,
  requested_at TEXT NOT NULL,
  applied_at TEXT,
  note TEXT,
  UNIQUE (bot_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bot_settings_pending ON bot_settings(bot_id) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS bot_orders (
  order_id TEXT PRIMARY KEY,                         -- the engine's signal id (ENG-ALPHA-01-SOLUSD-1-…-OPEN_LONG)
  bot_id TEXT NOT NULL REFERENCES bots(bot_id),
  action TEXT NOT NULL CHECK (action IN ('OPEN_LONG', 'OPEN_SHORT', 'CLOSE')),
  symbol TEXT NOT NULL,
  requested_qty REAL,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'REJECTED')),
  code TEXT NOT NULL,
  message TEXT,
  trade_id TEXT,
  received_at TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_orders_bot ON bot_orders(bot_id, received_at);

CREATE TABLE IF NOT EXISTS bot_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL UNIQUE,                     -- = the opening order id
  bot_id TEXT NOT NULL REFERENCES bots(bot_id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  qty REAL NOT NULL CHECK (qty > 0),
  entry_price REAL NOT NULL CHECK (entry_price > 0),  -- simulated fill (Kraken reference at arrival)
  entry_fee_micro INTEGER NOT NULL CHECK (entry_fee_micro >= 0),
  collateral_micro INTEGER NOT NULL CHECK (collateral_micro >= 0), -- cash reserved: purchase cost (LONG) or collateral (SHORT)
  stop REAL, tp REAL,                                -- the strategy's levels at entry (trade proof)
  risk_usd REAL,                                     -- the dollar-risk target the order was sized with
  profile TEXT, inputs_hash TEXT, fee_model TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  exit_price REAL, exit_fee_micro INTEGER, closed_at TEXT, close_order_id TEXT,
  gross_pnl_micro INTEGER, net_pnl_micro INTEGER,    -- net = gross - entry fee - exit fee (the trade's full result)
  swept_micro INTEGER NOT NULL DEFAULT 0,            -- positive net profit moved to MAIN at the close
  shortfall_micro INTEGER NOT NULL DEFAULT 0,        -- part of a loss the bot's wallet could not pay
  mark_price REAL, mark_at TEXT,
  CHECK (status = 'OPEN' OR (closed_at IS NOT NULL AND exit_price IS NOT NULL AND net_pnl_micro IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bot_positions_open ON bot_positions(bot_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_bot_positions_bot ON bot_positions(bot_id, status);

CREATE TABLE IF NOT EXISTS bot_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id TEXT NOT NULL UNIQUE,                      -- = the order id: one fill per order, ever
  bot_id TEXT NOT NULL REFERENCES bots(bot_id),
  trade_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ENTRY', 'EXIT')),
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  qty REAL NOT NULL CHECK (qty > 0),
  price REAL NOT NULL CHECK (price > 0),
  notional_micro INTEGER NOT NULL,
  fee_rate_pct REAL NOT NULL,
  fee_micro INTEGER NOT NULL CHECK (fee_micro >= 0),
  fee_currency TEXT NOT NULL,
  fee_model TEXT NOT NULL,
  price_source TEXT NOT NULL,
  price_at TEXT NOT NULL,
  filled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_fills_trade ON bot_fills(trade_id);

CREATE TABLE IF NOT EXISTS allocation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_key TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL REFERENCES allocation_groups(group_id),
  amount_micro INTEGER NOT NULL CHECK (amount_micro > 0),
  split_json TEXT NOT NULL,                          -- [{bot_id, amount_micro}] summing exactly to amount_micro
  created_at TEXT NOT NULL,
  note TEXT
);

-- Legacy path ownership (labels only, no value changes).
ALTER TABLE alerts ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE paper_positions ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE paper_fills ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE trades ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE mirror_accounts ADD COLUMN bot_id TEXT;
UPDATE alerts SET bot_id = 'ALPHA-02' WHERE alert_id LIKE 'ENG-SOLUSD-5-%';
UPDATE orders SET bot_id = 'ALPHA-02' WHERE alert_fk IN (SELECT id FROM alerts WHERE bot_id = 'ALPHA-02');
UPDATE paper_positions SET bot_id = 'ALPHA-02' WHERE open_alert_id LIKE 'ENG-SOLUSD-5-%';
UPDATE paper_fills SET bot_id = 'ALPHA-02' WHERE position_fk IN (SELECT id FROM paper_positions WHERE bot_id = 'ALPHA-02');
UPDATE trades SET bot_id = 'ALPHA-02' WHERE open_alert_id LIKE 'ENG-SOLUSD-5-%';
UPDATE mirror_accounts SET bot_id = 'ALPHA-02' WHERE account_id LIKE 'MIRROR-SOLUSD-5m-%';
CREATE UNIQUE INDEX IF NOT EXISTS ux_paper_positions_open_owner ON paper_positions(bot_id, symbol) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_alerts_bot ON alerts(bot_id);

-- Notifications per bot: which bot an event belongs to, and the recorded figures shown in it (entry/stop/target, or
-- gross/fees/net/transferred to MAIN). The bot_fills cursor starts at its current end (empty): no backlog flood.
--
-- trade_events also gains bot lifecycle notifications (pending limit order, order cancelled, stop moved to break-even,
-- trailing stop moved). SQLite cannot widen a CHECK in place, so the table is REBUILT with every row copied unchanged
-- (same ids, same values; push_deliveries keeps pointing at the same ids). trade_events is derived (rebuilt by cursors
-- from the authoritative ledger and mirror rows); no financial record lives in it. The wider CHECK is a superset, so the
-- Worker running today keeps working against it.
PRAGMA defer_foreign_keys = true;
CREATE TABLE trade_events_v7 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('FUNDED_ENTRY', 'FUNDED_ADD', 'FUNDED_REDUCE', 'FUNDED_CLOSE', 'MIRROR_ENTRY', 'MIRROR_CLOSE', 'TEST',
                                     'ORDER_PENDING', 'ORDER_CANCELLED', 'STOP_TO_BREAK_EVEN', 'TRAILING_STOP_MOVED')),
  source TEXT NOT NULL CHECK (source IN ('funded', 'mirror', 'system')),
  symbol TEXT,
  side TEXT,
  qty REAL,
  price REAL,
  pnl REAL,
  pnl_net REAL,
  fees REAL,
  classification TEXT NOT NULL DEFAULT 'live' CHECK (classification IN ('historical', 'catch_up', 'live')),
  ref TEXT,
  account_id TEXT,
  url TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  bot_id TEXT,
  detail_json TEXT
);
INSERT INTO trade_events_v7 (id, event_key, kind, source, symbol, side, qty, price, pnl, pnl_net, fees, classification, ref, account_id, url, occurred_at, created_at)
  SELECT id, event_key, kind, source, symbol, side, qty, price, pnl, pnl_net, fees, classification, ref, account_id, url, occurred_at, created_at FROM trade_events;
DROP TABLE trade_events;
ALTER TABLE trade_events_v7 RENAME TO trade_events;
CREATE INDEX IF NOT EXISTS idx_trade_events_bot ON trade_events(bot_id, id);
INSERT OR IGNORE INTO event_cursors (name, last_id) VALUES ('bot_fills', (SELECT COALESCE(MAX(id), 0) FROM bot_fills));

INSERT INTO app_meta (key, value) VALUES ('schema_version', '7')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

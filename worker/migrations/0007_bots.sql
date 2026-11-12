-- Independent bots (docs/MULTI-BOT-ARCHITECTURE.md). NOT APPLIED to production: needs its own approval (stage M1).
-- ADDITIVE: the old one-open-position-per-symbol index stays, so the Worker that runs today (and a rollback to it) keeps
-- working on schema 7. 0008 removes it, only when a second bot on the same market is approved.
--
-- * bots: the bots the ledger accepts signals from. Only ALPHA-02 (today's production SOLUSD 5m engine) is registered
--   here; every other bot is added later, one approval at a time. A bot's allocation cap and its reserved capital are
--   guarded by CHECK constraints, so a fill that would exceed the cap fails its whole D1 transaction.
-- * Ownership: every ledger row gets bot_id. '' = no bot (TradingView alerts and other single-owner callers): their
--   behaviour is exactly as before, one open position per symbol. A registered bot owns its own positions: two bots can
--   hold separate positions in the same symbol, and one bot's exit can never touch another bot's position.
-- * Existing rows: the funded SOLUSD 5m engine's rows (ids ENG-SOLUSD-5-…) and its mirror account become ALPHA-02's.
--   No balance, quantity, price, P&L or status changes.

CREATE TABLE IF NOT EXISTS bots (
  bot_id TEXT PRIMARY KEY CHECK (bot_id GLOB 'ALPHA-[0-9][0-9]'),
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe_min INTEGER NOT NULL CHECK (timeframe_min IN (1, 5, 15, 30, 60)),
  profile TEXT,
  wallet TEXT NOT NULL,                              -- capital source (portfolio_wallets.wallet), shared by default
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PROPOSED', 'DISABLED')),
  legacy_default INTEGER NOT NULL DEFAULT 0 CHECK (legacy_default IN (0, 1)), -- owner of requests without bot_id (pre-fleet engine)
  entries_paused INTEGER NOT NULL DEFAULT 0 CHECK (entries_paused IN (0, 1)), -- 1: new entries refused, exits still managed
  allocation_cap_micro INTEGER CHECK (allocation_cap_micro IS NULL OR allocation_cap_micro > 0),
  reserved_micro INTEGER NOT NULL DEFAULT 0,          -- cost basis this bot holds reserved in open positions
  risk_pct REAL NOT NULL DEFAULT 1 CHECK (risk_pct > 0 AND risk_pct <= 10),
  max_risk_usd REAL NOT NULL DEFAULT 10 CHECK (max_risk_usd > 0),
  priority INTEGER NOT NULL DEFAULT 99,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT bot_reserved_nonnegative CHECK (reserved_micro >= 0),
  CONSTRAINT bot_allocation_cap CHECK (allocation_cap_micro IS NULL OR reserved_micro <= allocation_cap_micro),
  UNIQUE (symbol, timeframe_min, profile)
);
-- At most one legacy bot per market: the pre-fleet engine's requests (some carry no timeframe) map to it unambiguously.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bots_legacy_default ON bots(symbol) WHERE legacy_default = 1;

INSERT OR IGNORE INTO bots (bot_id, name, symbol, timeframe_min, profile, wallet, status, legacy_default, entries_paused,
  allocation_cap_micro, reserved_micro, risk_pct, max_risk_usd, priority, created_at, updated_at)
VALUES ('ALPHA-02', 'ALPHA 02', 'SOLUSD', 5, 'solusd-5m', 'SOLUSD', 'ACTIVE', 1, 0, NULL, 0, 1, 10, 1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE alerts ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE paper_positions ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE paper_fills ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE trades ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE mirror_accounts ADD COLUMN bot_id TEXT;

-- The production SOLUSD 5m engine's existing records belong to ALPHA-02 (ownership only; no value changes).
UPDATE alerts SET bot_id = 'ALPHA-02' WHERE alert_id LIKE 'ENG-SOLUSD-5-%';
UPDATE orders SET bot_id = 'ALPHA-02' WHERE alert_fk IN (SELECT id FROM alerts WHERE bot_id = 'ALPHA-02');
UPDATE paper_positions SET bot_id = 'ALPHA-02' WHERE open_alert_id LIKE 'ENG-SOLUSD-5-%';
UPDATE paper_fills SET bot_id = 'ALPHA-02' WHERE position_fk IN (SELECT id FROM paper_positions WHERE bot_id = 'ALPHA-02');
UPDATE trades SET bot_id = 'ALPHA-02' WHERE open_alert_id LIKE 'ENG-SOLUSD-5-%';
UPDATE mirror_accounts SET bot_id = 'ALPHA-02' WHERE account_id LIKE 'MIRROR-SOLUSD-5m-%';
UPDATE bots SET reserved_micro = (SELECT COALESCE(SUM(reserved_micro), 0) FROM paper_positions WHERE bot_id = 'ALPHA-02' AND status = 'OPEN')
  WHERE bot_id = 'ALPHA-02';

-- One OPEN position per owner and symbol (owner '' = exactly the old one-per-symbol rule). The fleet Worker's upsert
-- targets this index. ux_paper_positions_open_symbol (one per symbol) is KEPT until 0008.
CREATE UNIQUE INDEX IF NOT EXISTS ux_paper_positions_open_owner ON paper_positions(bot_id, symbol) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_paper_positions_bot ON paper_positions(bot_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_bot ON alerts(bot_id);
CREATE INDEX IF NOT EXISTS idx_trades_bot ON trades(bot_id);

INSERT INTO app_meta (key, value) VALUES ('schema_version', '7')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

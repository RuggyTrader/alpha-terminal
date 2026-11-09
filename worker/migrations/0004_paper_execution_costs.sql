-- ALPHA PAPER execution costs: simulated exchange fees and slippage on every PAPER fill (worker/src/costs.ts).
-- Additive only. Existing positions, fills, trades, entries and balances are NOT changed: their new cost columns
-- stay NULL / 0, which the dashboard shows as "no costs recorded" (they were simulated before costs existed).

-- 1. portfolio_entries: allow kind 'FEE'. SQLite cannot change a CHECK constraint in place, so the table is
--    rebuilt with the same columns and every existing row is copied unchanged (same ids, keys and amounts).
CREATE TABLE portfolio_entries_v4 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_key TEXT NOT NULL UNIQUE,
  group_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT', 'TRANSFER_IN', 'RESERVE', 'RELEASE', 'REALIZED_PNL', 'FEE')),
  wallet TEXT NOT NULL REFERENCES portfolio_wallets(wallet),
  available_change_micro INTEGER NOT NULL,
  reserved_change_micro INTEGER NOT NULL DEFAULT 0,
  counterparty TEXT,
  ref TEXT,
  position_fk INTEGER,
  note TEXT
);
INSERT INTO portfolio_entries_v4
  (id, entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, counterparty, ref, position_fk, note)
  SELECT id, entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, counterparty, ref, position_fk, note
  FROM portfolio_entries;
DROP TABLE portfolio_entries;
ALTER TABLE portfolio_entries_v4 RENAME TO portfolio_entries;
CREATE INDEX IF NOT EXISTS idx_portfolio_entries_wallet ON portfolio_entries(wallet, id);

-- 2. Wallets: total simulated fees paid (a cost, kept apart from realized P&L so both stay auditable).
--    Identity: available + reserved = net funding + realized P&L - fees.
ALTER TABLE portfolio_wallets ADD COLUMN fees_micro INTEGER NOT NULL DEFAULT 0;

-- 3. Fills: the observed market price, the simulated execution price (in `price`), and its costs.
ALTER TABLE paper_fills ADD COLUMN reference_price REAL;          -- market observation (Kraken) before slippage
ALTER TABLE paper_fills ADD COLUMN liquidity TEXT;                -- 'MAKER' or 'TAKER' (NULL: before costs existed)
ALTER TABLE paper_fills ADD COLUMN fee_micro INTEGER;             -- simulated exchange fee, micro-USD
ALTER TABLE paper_fills ADD COLUMN slippage_micro INTEGER;        -- |execution - reference| x qty, micro-USD
ALTER TABLE paper_fills ADD COLUMN cost_profile TEXT;             -- e.g. 'ndax', 'kraken_pro_t1', 'none'

-- 4. Positions: costs accumulated over the lifecycle (copied to the trade on close).
ALTER TABLE paper_positions ADD COLUMN fees_micro INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_positions ADD COLUMN slippage_micro INTEGER NOT NULL DEFAULT 0;

-- 5. Trades: gross P&L at market prices, fees, slippage. realized_pnl is NET for trades closed from now on.
ALTER TABLE trades ADD COLUMN gross_pnl TEXT;
ALTER TABLE trades ADD COLUMN fees_usd TEXT;
ALTER TABLE trades ADD COLUMN slippage_usd TEXT;
ALTER TABLE trades ADD COLUMN cost_profile TEXT;

INSERT INTO app_meta (key, value) VALUES ('schema_version', '4')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

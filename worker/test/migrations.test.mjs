// Migrations applied in order to a fresh SQLite database (D1 is SQLite), with a legacy row in between.
//   node --test test/migrations.test.mjs
// (The Worker suites also apply them with `wrangler d1 migrations apply --local`.)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const sql = (name) => readFileSync(join(DIR, name), "utf8");
const cols = (db, t) => Object.fromEntries(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c]));

describe("migrations from a fresh 0001", () => {
  it("are exactly 0001 to 0004", () => {
    assert.deepEqual(readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort(),
      ["0001_initial.sql", "0002_alpha_paper_ledger.sql", "0003_paper_portfolio.sql", "0004_paper_execution_costs.sql"]);
  });

  it("0002 applies on top of 0001 with existing rows, and does not label legacy trades ALPHA PAPER", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(sql("0001_initial.sql"));
    db.prepare(`INSERT INTO trades (symbol, direction, status, entry_qty, entry_avg_price, open_qty, opened_at)
                VALUES ('LEGACY', 'LONG', 'OPEN', '1', '10', '1', '2026-10-30T00:00:00Z')`).run();
    db.prepare(`INSERT INTO alerts (alert_id, received_at, status) VALUES ('legacy-alert', '2026-10-30T00:00:00Z', 'dry_run')`).run();
    db.exec(sql("0002_alpha_paper_ledger.sql"));

    const t = cols(db, "trades");
    for (const c of ["source", "position_fk", "close_alert_id", "price_sources"]) assert.ok(t[c], c);
    assert.equal(t.source.notnull, 0, "trades.source is nullable");
    assert.equal(t.source.dflt_value, null, "trades.source has no default");
    assert.equal(db.prepare(`SELECT source FROM trades WHERE symbol = 'LEGACY'`).get().source, null);

    const a = cols(db, "alerts");
    assert.ok(a.attempt_count && a.last_attempt_at);
    assert.equal(db.prepare(`SELECT attempt_count FROM alerts WHERE alert_id = 'legacy-alert'`).get().attempt_count, 1);
    assert.ok(cols(db, "activity_events").position_fk);
    for (const tbl of ["paper_positions", "paper_fills"]) assert.ok(Object.keys(cols(db, tbl)).length > 0, tbl);
    assert.equal(db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get().value, "2");
  });

  it("the ledger writes source = 'ALPHA_PAPER' explicitly", () => {
    const src = readFileSync(join(DIR, "..", "src", "paper_ledger.ts"), "utf8");
    assert.match(src, /'ALPHA_PAPER', p\.id, p\.close_alert_id/);
  });

  it("ledger constraints reject impossible positions", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(sql("0001_initial.sql"));
    db.exec(sql("0002_alpha_paper_ledger.sql"));
    const now = "2026-11-01T00:00:00Z";
    const ins = (status, qty, closedAt) => () => db.prepare(
      `INSERT INTO paper_positions (symbol, status, qty, avg_entry_price, multiplier, opened_at, closed_at,
         entry_qty_total, entry_value_total, open_alert_id, open_order_id, last_order_id, updated_at)
       VALUES ('SOLUSD', ?, ?, 100, 1, ?, ?, 1, 100, 'a', 'o', 'o', ?)`).run(status, qty, now, closedAt, now);
    ins("OPEN", 1, null)();
    assert.throws(ins("OPEN", 1, null), /UNIQUE/); // a second OPEN SOLUSD
    assert.throws(ins("CLOSED", 1, now), /CHECK/); // CLOSED with qty left
    assert.throws(() => db.prepare(`UPDATE paper_positions SET qty = -1`).run(), /CHECK/);
    assert.throws(() => db.prepare(`UPDATE paper_positions SET qty = 0`).run(), /CHECK/); // OPEN and empty
  });

  it("0003 applies on top of existing ledger rows, leaves old positions outside the portfolio, and forbids negative balances", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(sql("0001_initial.sql"));
    db.exec(sql("0002_alpha_paper_ledger.sql"));
    const now = "2026-11-01T00:00:00Z";
    db.prepare(`INSERT INTO paper_positions (symbol, status, qty, avg_entry_price, multiplier, opened_at, entry_qty_total, entry_value_total,
       open_alert_id, open_order_id, last_order_id, updated_at) VALUES ('SOLUSD', 'OPEN', 1, 100, 1, ?, 1, 100, 'a', 'o', 'o', ?)`).run(now, now);
    db.exec(sql("0003_paper_portfolio.sql"));
    assert.equal(db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get().value, "3");
    const pos = db.prepare(`SELECT wallet, reserved_micro FROM paper_positions`).get();
    assert.deepEqual([pos.wallet, pos.reserved_micro], [null, 0]);
    assert.deepEqual(db.prepare(`SELECT wallet FROM portfolio_wallets ORDER BY wallet`).all().map((r) => r.wallet),
      ["BTCUSD", "ETHUSD", "HYPEUSD", "KAITOUSD", "MAIN", "SOLUSD"]);
    assert.throws(() => db.prepare(`UPDATE portfolio_wallets SET available_micro = -1 WHERE wallet = 'MAIN'`).run(), /CHECK/);
    assert.throws(() => db.prepare(`UPDATE portfolio_wallets SET reserved_micro = 5 WHERE wallet = 'MAIN'`).run(), /CHECK/);
    assert.throws(() => db.prepare(`UPDATE strategy_settings SET compounding = 1`).run(), /CHECK/);
    const s = db.prepare(`SELECT version, risk_usd, status FROM strategy_settings WHERE strategy = 'SOLUSD'`).get();
    assert.deepEqual([s.version, s.risk_usd, s.status], [1, 10, "PENDING"]);
    // The same entry key can never be booked twice.
    const ins = () => db.prepare(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro) VALUES ('k', 'g', ?, 'DEPOSIT', 'MAIN', 1)`).run(now);
    ins();
    assert.throws(ins, /UNIQUE/);
  });

  it("0004 keeps every existing entry, fill, trade and balance unchanged, and allows FEE entries", () => {
    const db = new DatabaseSync(":memory:");
    for (const f of ["0001_initial.sql", "0002_alpha_paper_ledger.sql", "0003_paper_portfolio.sql"]) db.exec(sql(f));
    const now = "2026-11-08T00:00:00Z";
    db.prepare("UPDATE portfolio_wallets SET available_micro = 12000000, reserved_micro = 0, realized_pnl_micro = 2000000, net_funding_micro = 10000000 WHERE wallet = 'SOLUSD'").run();
    const entry = db.prepare("INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, note) VALUES (?, ?, ?, ?, 'SOLUSD', ?, 0, ?)");
    entry.run("seed", "seed", now, "TRANSFER_IN", 10000000, "funding");
    entry.run("PNL:x", "x", now, "REALIZED_PNL", 2000000, "win");
    db.prepare(`INSERT INTO paper_positions (symbol, status, qty, avg_entry_price, multiplier, opened_at, closed_at, entry_qty_total, entry_value_total,
       open_alert_id, open_order_id, last_order_id, updated_at, realized_pnl) VALUES ('SOLUSD', 'CLOSED', 0, 100, 1, ?, ?, 1, 100, 'a', 'o', 'c', ?, 2)`).run(now, now, now);
    db.prepare("INSERT INTO orders (client_order_id, symbol, side, qty, submitted_at, updated_at) VALUES ('c', 'SOLUSD', 'sell', '1', ?, ?)").run(now, now);
    db.prepare(`INSERT INTO paper_fills (order_fk, position_fk, client_order_id, alert_id, symbol, kind, side, qty, price, price_source, price_at, realized_pnl,
       position_qty_after, avg_entry_after, filled_at) VALUES (1, 1, 'c', 'x', 'SOLUSD', 'CLOSE', 'sell', 1, 102, 'kraken:SOLUSD', ?, 2, 0, 100, ?)`).run(now, now);
    db.prepare(`INSERT INTO trades (symbol, direction, status, entry_qty, entry_avg_price, open_qty, opened_at, realized_pnl, source)
       VALUES ('SOLUSD', 'LONG', 'CLOSED', '1', '100', '0', ?, '2', 'ALPHA_PAPER')`).run(now);
    const snap = () => ({
      entries: db.prepare("SELECT id, entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, note FROM portfolio_entries ORDER BY id").all().map((r) => ({ ...r })),
      wallets: db.prepare("SELECT wallet, available_micro, reserved_micro, realized_pnl_micro, net_funding_micro FROM portfolio_wallets ORDER BY wallet").all().map((r) => ({ ...r })),
      fills: db.prepare("SELECT id, price, realized_pnl FROM paper_fills").all().map((r) => ({ ...r })),
      trades: db.prepare("SELECT id, realized_pnl FROM trades").all().map((r) => ({ ...r })),
    });
    const before = snap();
    db.exec(sql("0004_paper_execution_costs.sql"));
    assert.deepEqual(snap(), before, "no existing row changed");
    assert.equal(db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get().value, "4");
    assert.equal(db.prepare("SELECT fees_micro FROM portfolio_wallets WHERE wallet = 'SOLUSD'").get().fees_micro, 0);
    const f = db.prepare("SELECT reference_price, liquidity, fee_micro, slippage_micro, cost_profile FROM paper_fills").get();
    assert.deepEqual({ ...f }, { reference_price: null, liquidity: null, fee_micro: null, slippage_micro: null, cost_profile: null });
    const t = db.prepare("SELECT gross_pnl, fees_usd, slippage_usd, cost_profile FROM trades").get();
    assert.deepEqual({ ...t }, { gross_pnl: null, fees_usd: null, slippage_usd: null, cost_profile: null }, "old trades stay gross, no cost record");
    // FEE entries are now allowed; unknown kinds and duplicate keys are still refused.
    entry.run("FEE:o", "o", now, "FEE", -32000, "fee");
    assert.throws(() => entry.run("FEE:o", "o", now, "FEE", -32000, "again"), /UNIQUE/);
    assert.throws(() => entry.run("X:o", "o", now, "BONUS", 1, "x"), /CHECK/);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_portfolio_entries_wallet'").get());
    // Negative balances are still impossible.
    assert.throws(() => db.prepare("UPDATE portfolio_wallets SET available_micro = -1 WHERE wallet = 'SOLUSD'").run(), /CHECK/);
  });

  it("two fills that both passed the balance pre-check: the second one's transaction overdraws, fails and leaves no trace", () => {
    // The Worker checks the balance first, then commits the fill as ONE D1 batch (one transaction) that also reserves
    // the position value. If another fill used the money in between, the reserve UPDATE violates
    // CHECK (available_micro >= 0) and the whole batch, fill and position included, rolls back. Same SQL as
    // src/portfolio.ts (asserted below), run here as SQLite transactions like a D1 batch.
    const RESERVE = "UPDATE portfolio_wallets SET available_micro = available_micro - ?, reserved_micro = reserved_micro + ?, updated_at = ? WHERE wallet = ?";
    assert.ok(readFileSync(join(DIR, "..", "src", "portfolio.ts"), "utf8").includes(RESERVE), "the reserve SQL under test is the Worker's");
    const db = new DatabaseSync(":memory:");
    for (const f of ["0001_initial.sql", "0002_alpha_paper_ledger.sql", "0003_paper_portfolio.sql"]) db.exec(sql(f));
    const now = "2026-11-08T00:00:00Z";
    db.prepare("UPDATE portfolio_wallets SET available_micro = 30000000, net_funding_micro = 30000000 WHERE wallet = 'SOLUSD'").run();
    db.prepare("INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro) VALUES ('seed', 'seed', ?, 'TRANSFER_IN', 'SOLUSD', 30000000)").run(now);
    const balance = () => db.prepare("SELECT available_micro AS a, reserved_micro AS r FROM portfolio_wallets WHERE wallet = 'SOLUSD'").get();
    // Both fills read the balance before either commits: $30 covers $20 for each of them.
    const seenA = balance().a, seenB = balance().a;
    assert.ok(seenA >= 20e6 && seenB >= 20e6);
    const fillBatch = (id) => {
      db.exec("BEGIN");
      try {
        db.prepare(`INSERT INTO paper_positions (symbol, status, qty, avg_entry_price, multiplier, opened_at, entry_qty_total, entry_value_total,
           open_alert_id, open_order_id, last_order_id, updated_at, wallet, reserved_micro) VALUES ('SOLUSD', 'OPEN', 0.2, 100, 1, ?, 0.2, 20, ?, ?, ?, ?, 'SOLUSD', 20000000)
           ON CONFLICT(symbol) WHERE status = 'OPEN' DO UPDATE SET qty = qty + 0.2, reserved_micro = reserved_micro + 20000000, last_order_id = excluded.last_order_id`)
          .run(now, id, id, id, now);
        db.prepare(RESERVE).run(20e6, 20e6, now, "SOLUSD");
        db.prepare("INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro) VALUES (?, ?, ?, 'RESERVE', 'SOLUSD', -20000000, 20000000)")
          .run(`RESERVE:${id}`, id, now);
        db.exec("COMMIT");
        return "committed";
      } catch (e) {
        db.exec("ROLLBACK");
        return String(e.message);
      }
    };
    assert.equal(fillBatch("A"), "committed");
    assert.match(fillBatch("B"), /CHECK constraint failed/);
    assert.deepEqual({ ...balance() }, { a: 10e6, r: 20e6 });
    const pos = db.prepare("SELECT qty, reserved_micro, last_order_id FROM paper_positions WHERE status = 'OPEN'").get();
    assert.deepEqual([pos.qty, pos.reserved_micro, pos.last_order_id], [0.2, 20e6, "A"], "fill B left no position change");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM portfolio_entries WHERE entry_key = 'RESERVE:B'").get().n, 0);
    const sums = db.prepare("SELECT SUM(available_change_micro) AS a, SUM(reserved_change_micro) AS r FROM portfolio_entries WHERE wallet = 'SOLUSD'").get();
    assert.deepEqual([sums.a, sums.r], [10e6, 20e6], "history still equals the balance");
  });
});

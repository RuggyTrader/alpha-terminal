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
const sql = (name) => readFileSync(join(name.startsWith("0008") ? join(DIR, "..", "migrations-staged") : DIR, name), "utf8");
const cols = (db, t) => Object.fromEntries(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c]));

describe("migrations from a fresh 0001", () => {
  it("are exactly 0001 to 0007; 0008 is staged separately so a plain `migrations apply` can never apply it", () => {
    assert.deepEqual(readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort(),
      ["0001_initial.sql", "0002_alpha_paper_ledger.sql", "0003_paper_portfolio.sql", "0004_paper_execution_costs.sql", "0005_strategy_mirror.sql", "0006_events_and_push.sql", "0007_bots.sql"]);
    assert.deepEqual(readdirSync(join(DIR, "..", "migrations-staged")).sort(), ["0008_bots_multi_position.sql"]);
  });

  it("0007 keeps the old one-per-symbol index (today's Worker and a rollback keep working); 0008 removes it", () => {
    const db = new DatabaseSync(":memory:");
    for (const f of ["0001_initial.sql", "0002_alpha_paper_ledger.sql", "0003_paper_portfolio.sql", "0004_paper_execution_costs.sql", "0005_strategy_mirror.sql", "0006_events_and_push.sql", "0007_bots.sql"]) db.exec(sql(f));
    const idx = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'paper_positions'").all().map((r) => r.name);
    assert.ok(idx().includes("ux_paper_positions_open_symbol") && idx().includes("ux_paper_positions_open_owner"));
    // The PRE-FLEET Worker's upsert (ON CONFLICT(symbol)) still works on schema 7; its rows default to owner ''.
    const now = "2026-11-12T00:00:00Z";
    const oldUpsert = db.prepare(`INSERT INTO paper_positions (symbol, side, status, qty, avg_entry_price, multiplier, opened_at, entry_qty_total, entry_value_total,
      open_alert_id, open_order_id, last_order_id, updated_at) VALUES ('SOLUSD', 'long', 'OPEN', 1, 80, 1, ?, 1, 80, 'a', 'a', 'a', ?)
      ON CONFLICT(symbol) WHERE status = 'OPEN' DO UPDATE SET qty = qty + excluded.qty`);
    oldUpsert.run(now, now); oldUpsert.run(now, now);
    assert.deepEqual(db.prepare("SELECT qty, bot_id FROM paper_positions").all().map((r) => ({ ...r })), [{ qty: 2, bot_id: "" }]);
    // The fleet Worker's upsert (ON CONFLICT(bot_id, symbol)) works on schema 7 as well.
    const newUpsert = db.prepare(`INSERT INTO paper_positions (symbol, side, status, qty, avg_entry_price, multiplier, opened_at, entry_qty_total, entry_value_total,
      open_alert_id, open_order_id, last_order_id, updated_at, bot_id) VALUES ('ETHUSD', 'long', 'OPEN', 1, 80, 1, ?, 1, 80, 'b', 'b', 'b', ?, 'ALPHA-02')
      ON CONFLICT(bot_id, symbol) WHERE status = 'OPEN' DO UPDATE SET qty = qty + excluded.qty`);
    newUpsert.run(now, now); newUpsert.run(now, now);
    assert.equal(db.prepare("SELECT qty FROM paper_positions WHERE symbol = 'ETHUSD'").get().qty, 2);
    db.exec(sql("0008_bots_multi_position.sql"));
    assert.ok(!idx().includes("ux_paper_positions_open_symbol") && idx().includes("ux_paper_positions_open_owner"));
    assert.equal(db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get().value, "8");
    assert.throws(() => oldUpsert.run(now, now), /ON CONFLICT clause does not match/, "why a pre-fleet Worker must not be redeployed after 0008");
  });

  it("0007 (bots) adds ownership only: every value unchanged, the engine's rows become ALPHA-02's, others stay unowned", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    for (const f of ["0001_initial.sql", "0002_alpha_paper_ledger.sql", "0003_paper_portfolio.sql", "0004_paper_execution_costs.sql", "0005_strategy_mirror.sql", "0006_events_and_push.sql"]) db.exec(sql(f));
    const now = "2026-11-12T00:00:00Z";
    // Production-shaped rows: the 5m engine's alerts (one refused, one that opened a still-open position), a TradingView
    // alert with its own closed position in another symbol, and the SOLUSD 5m mirror account.
    const alert = db.prepare("INSERT INTO alerts (alert_id, received_at, symbol, action, status) VALUES (?, ?, ?, ?, ?)");
    alert.run("ENG-SOLUSD-5-2026-11-11T14:20:00Z-BUY", now, "SOLUSD", "buy", "rejected");
    alert.run("ENG-SOLUSD-5-2026-11-12T01:00:00Z-BUY", now, "SOLUSD", "buy", "dry_run");
    alert.run("TV-1", now, "ETHUSD", "buy", "dry_run");
    const pos = db.prepare(`INSERT INTO paper_positions (symbol, status, qty, avg_entry_price, multiplier, opened_at, closed_at, entry_qty_total, entry_value_total,
      open_alert_id, open_order_id, last_order_id, updated_at, wallet, reserved_micro) VALUES (?, ?, ?, 80, 1, ?, ?, 1, 80, ?, 'o', 'o', ?, ?, ?)`);
    pos.run("SOLUSD", "OPEN", 0.1, now, null, "ENG-SOLUSD-5-2026-11-12T01:00:00Z-BUY", now, "SOLUSD", 8000000);
    pos.run("ETHUSD", "CLOSED", 0, now, now, "TV-1", now, "ETHUSD", 0);
    db.prepare("INSERT INTO mirror_accounts (account_id, symbol, timeframe, inputs_hash, created_at, updated_at) VALUES ('MIRROR-SOLUSD-5m-c826d785d58a4a39', 'SOLUSD', '5m', 'c8', ?, ?)").run(now, now);
    const tablesWithRows = ["alerts", "orders", "paper_positions", "paper_fills", "trades", "mirror_accounts", "portfolio_wallets", "portfolio_entries", "mirror_trades", "trade_events"];
    const dump = () => Object.fromEntries(tablesWithRows.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))]));
    const before = dump();
    db.exec(sql("0007_bots.sql"));
    const after = dump();
    for (const t of tablesWithRows) {
      const strip = (rows) => rows.map(({ bot_id: _b, ...r }) => r);
      assert.deepEqual(strip(after[t]), strip(before[t]), `${t}: no value changed`);
    }
    assert.deepEqual(after.alerts.map((r) => [r.alert_id, r.bot_id]), [["ENG-SOLUSD-5-2026-11-11T14:20:00Z-BUY", "ALPHA-02"], ["ENG-SOLUSD-5-2026-11-12T01:00:00Z-BUY", "ALPHA-02"], ["TV-1", ""]]);
    assert.deepEqual(after.paper_positions.map((r) => [r.symbol, r.bot_id]), [["SOLUSD", "ALPHA-02"], ["ETHUSD", ""]]);
    assert.equal(after.mirror_accounts[0].bot_id, "ALPHA-02");
    assert.equal(db.prepare("SELECT reserved_micro FROM bots WHERE bot_id = 'ALPHA-02'").get().reserved_micro, 8000000, "the bot's reservation = its open position");
    assert.equal(db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get().value, "7");
    db.exec(sql("0008_bots_multi_position.sql"));
    // One open position per (owner, symbol): another bot may open SOLUSD; the same owner may not open a second one.
    const open = db.prepare(`INSERT INTO paper_positions (symbol, status, qty, avg_entry_price, multiplier, opened_at, entry_qty_total, entry_value_total,
      open_alert_id, open_order_id, last_order_id, updated_at, bot_id) VALUES ('SOLUSD', 'OPEN', 1, 80, 1, ?, 1, 80, 'x', 'x', 'x', ?, ?)`);
    open.run(now, now, "ALPHA-01");
    assert.throws(() => open.run(now, now, "ALPHA-02"), /UNIQUE/);
    open.run(now, now, "");
    assert.throws(() => open.run(now, now, ""), /UNIQUE/, "unowned callers keep the one-per-symbol rule");
    // bots constraints
    assert.throws(() => db.prepare("UPDATE bots SET allocation_cap_micro = 1000000 WHERE bot_id = 'ALPHA-02'").run(), /bot_allocation_cap/);
    assert.throws(() => db.prepare("UPDATE bots SET reserved_micro = -1 WHERE bot_id = 'ALPHA-02'").run(), /bot_reserved_nonnegative/);
    const bot = db.prepare(`INSERT INTO bots (bot_id, name, symbol, timeframe_min, profile, wallet, status, legacy_default, created_at, updated_at) VALUES (?, 'x', ?, ?, ?, 'SOLUSD', 'PROPOSED', ?, ?, ?)`);
    assert.throws(() => bot.run("BOT-1", "SOLUSD", 1, "p", 0, now, now), /CHECK/, "bot ids look like ALPHA-NN");
    assert.throws(() => bot.run("ALPHA-07", "SOLUSD", 1, "p", 1, now, now), /UNIQUE/, "one legacy bot per market");
    assert.throws(() => bot.run("ALPHA-08", "SOLUSD", 5, "solusd-5m", 0, now, now), /UNIQUE/, "the same profile twice on one market and timeframe");
    bot.run("ALPHA-01", "SOLUSD", 1, null, 0, now, now);
  });

  it("0006 (events and push) only adds tables; existing rows unchanged; cursors start at the current end (no backlog)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    for (const f of ["0001_initial.sql", "0002_alpha_paper_ledger.sql", "0003_paper_portfolio.sql", "0004_paper_execution_costs.sql", "0005_strategy_mirror.sql"]) db.exec(sql(f));
    const now = "2026-11-10T00:00:00Z";
    db.prepare("INSERT INTO mirror_accounts (account_id, symbol, timeframe, inputs_hash, created_at, updated_at) VALUES ('A', 'SOLUSD', '5m', 'ab', ?, ?)").run(now, now);
    for (let i = 1; i <= 3; i++) db.prepare(`INSERT INTO mirror_trades (account_id, trade_id, seq, side, qty, entry_time, entry_price, exit_time, exit_price, exit_kind, result, gross_pnl,
      notional_usd, entry_liquidity, exit_liquidity, cost_profile, est_fees, est_slippage, net_modelled_pnl, classification, exit_candle_json, processed_at, received_at, inputs_hash, payload_hash)
      VALUES ('A', ?, ?, 'LONG', 1, ?, 100, ?, 101, 'TP', 'TP2', 1, 100, 'maker', 'maker', 'ndax', 0.4, 0, 0.6, 'live', '{}', ?, ?, 'ab', 'h')`).run(`T${i}`, i, now, now, now, now);
    const NEW = ["event_cursors", "mirror_open_events", "push_deliveries", "push_subscriptions", "trade_events"];
    const tables = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all().map((r) => ({ ...r }))
      .filter((t) => !NEW.some((n) => t.name === n || t.name.includes(n)) && t.name !== "idx_push_deliveries_pending");
    const dump = () => Object.fromEntries(tables().filter((t) => t.sql && t.sql.startsWith("CREATE TABLE")).map((t) => [t.name, db.prepare(`SELECT * FROM ${t.name}`).all().map((r) => ({ ...r }))]));
    const schemaBefore = tables(), rowsBefore = dump();
    db.exec(sql("0006_events_and_push.sql"));
    assert.deepEqual(tables(), schemaBefore, "no existing table or index definition changed");
    const after = dump();
    for (const d of [after, rowsBefore]) d.app_meta = d.app_meta.filter((r) => r.key !== "schema_version");
    assert.deepEqual(after, rowsBefore, "no existing row changed");
    assert.equal(db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get().value, "6");
    const cur = Object.fromEntries(db.prepare("SELECT name, last_id FROM event_cursors").all().map((r) => [r.name, r.last_id]));
    assert.deepEqual(cur, { paper_fills: 0, mirror_trades: 3, mirror_open_events: 0 });
    // constraints
    const ev = db.prepare("INSERT INTO trade_events (event_key, kind, source, classification, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    ev.run("K1", "MIRROR_CLOSE", "mirror", "live", now, now);
    assert.throws(() => ev.run("K1", "MIRROR_CLOSE", "mirror", "live", now, now), /UNIQUE/, "one event per source row");
    assert.throws(() => ev.run("K2", "PROFIT", "mirror", "live", now, now), /CHECK/);
    assert.throws(() => ev.run("K3", "MIRROR_CLOSE", "broker", "live", now, now), /CHECK/);
    db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, prefs_json, created_at, updated_at) VALUES ('https://web.push.apple.com/x', 'p', 'a', '{}', ?, ?)").run(now, now);
    const dl = db.prepare("INSERT INTO push_deliveries (event_id, subscription_id, status, created_at) VALUES (1, 1, ?, ?)");
    dl.run("pending", now);
    assert.throws(() => dl.run("pending", now), /UNIQUE/, "at most one notification per event per device");
    // re-running the migration is harmless
    db.exec(sql("0006_events_and_push.sql"));
    assert.equal(db.prepare("SELECT last_id FROM event_cursors WHERE name = 'mirror_trades'").get().last_id, 3);
  });

  it("0005 (Strategy Mirror) only adds tables: every existing table and row is unchanged; its constraints hold", () => {
    const db = new DatabaseSync(":memory:");
    for (const f of ["0001_initial.sql", "0002_alpha_paper_ledger.sql", "0003_paper_portfolio.sql", "0004_paper_execution_costs.sql"]) db.exec(sql(f));
    const now = "2026-11-10T00:00:00Z";
    db.prepare("UPDATE portfolio_wallets SET available_micro = 90000000, net_funding_micro = 90000000 WHERE wallet = 'MAIN'").run();
    db.prepare("UPDATE portfolio_wallets SET available_micro = 10000000, net_funding_micro = 10000000 WHERE wallet = 'SOLUSD'").run();
    db.prepare("INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, note) VALUES ('d', 'd', ?, 'DEPOSIT', 'MAIN', 100000000, 0, 'x')").run(now);
    const tables = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'mirror_%' AND name NOT LIKE 'idx_mirror_%' AND name NOT LIKE 'sqlite_autoindex_mirror_%' ORDER BY name").all().map((r) => ({ ...r }));
    const dump = () => Object.fromEntries(tables().filter((t) => t.sql && !t.name.startsWith("sqlite_") && t.sql.startsWith("CREATE TABLE")).map((t) => [t.name, db.prepare(`SELECT * FROM ${t.name}`).all().map((r) => ({ ...r }))]));
    const schemaBefore = tables(), rowsBefore = dump();
    db.exec(sql("0005_strategy_mirror.sql"));
    assert.deepEqual(tables(), schemaBefore, "no existing table or index definition changed");
    const after = dump();
    after.app_meta = after.app_meta.filter((r) => r.key !== "schema_version");
    rowsBefore.app_meta = rowsBefore.app_meta.filter((r) => r.key !== "schema_version");
    assert.deepEqual(after, rowsBefore, "no existing row changed");
    assert.equal(db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get().value, "5");
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mirror_%' ORDER BY name").all().map((r) => r.name), ["mirror_accounts", "mirror_entries", "mirror_trades"]);
    db.prepare("INSERT INTO mirror_accounts (account_id, symbol, timeframe, inputs_hash, created_at, updated_at) VALUES ('A', 'SOLUSD', '5m', 'ab', ?, ?)").run(now, now);
    assert.equal(db.prepare("SELECT reporting_equity_usd, cost_profile FROM mirror_accounts").get().cost_profile, "ndax");
    const trade = db.prepare(`INSERT INTO mirror_trades (account_id, trade_id, seq, side, qty, entry_time, entry_price, exit_time, exit_price, exit_kind, result, gross_pnl,
      notional_usd, entry_liquidity, exit_liquidity, cost_profile, est_fees, est_slippage, net_modelled_pnl, classification, exit_candle_json, processed_at, received_at, inputs_hash, payload_hash)
      VALUES ('A', ?, ?, ?, 1, ?, 100, ?, 101, 'TP', 'TP2', 1, 100, 'maker', 'maker', 'ndax', 0.4, 0, 0.6, ?, '{}', ?, ?, 'ab', 'h')`);
    trade.run("T1", 1, "LONG", now, now, "live", now, now);
    assert.throws(() => trade.run("T1", 2, "LONG", now, now, "live", now, now), /UNIQUE/, "trade id is unique within an account");
    db.prepare("INSERT INTO mirror_accounts (account_id, symbol, timeframe, inputs_hash, created_at, updated_at) VALUES ('B', 'SOLUSD', '5m', 'cd', ?, ?)").run(now, now);
    db.prepare(`INSERT INTO mirror_trades (account_id, trade_id, seq, side, qty, entry_time, entry_price, exit_time, exit_price, exit_kind, result, gross_pnl,
      notional_usd, entry_liquidity, exit_liquidity, cost_profile, est_fees, est_slippage, net_modelled_pnl, classification, exit_candle_json, processed_at, received_at, inputs_hash, payload_hash)
      VALUES ('B', 'T1', 1, 'LONG', 1, ?, 100, ?, 101, 'TP', 'TP2', 1, 100, 'maker', 'maker', 'ndax', 0.4, 0, 0.6, 'live', '{}', ?, ?, 'cd', 'h')`).run(now, now, now, now); // same id, another account
    assert.throws(() => trade.run("T2", 1, "LONG", now, now, "live", now, now), /UNIQUE/, "sequence is unique per account");
    assert.throws(() => trade.run("T3", 3, "BOTH", now, now, "live", now, now), /CHECK/);
    assert.throws(() => trade.run("T4", 4, "SHORT", now, now, "funded", now, now), /CHECK/, "only historical, catch_up or live");
    const e = db.prepare("INSERT INTO mirror_entries (account_id, entry_key, seq, kind, amount_usd, classification, created_at) VALUES ('A', ?, ?, ?, ?, 'live', ?)");
    assert.throws(() => e.run("EVENT:x", 5, "POSITION_INTERRUPTED", 3, now), /CHECK/, "an interruption carries no P&L");
    assert.throws(() => e.run("FEE:x", null, "FEE", -1, now), /CHECK/, "no fee entries in the mirror journal");
    // The funded ledger is untouched by mirror rows.
    assert.deepEqual(db.prepare("SELECT wallet, available_micro FROM portfolio_wallets WHERE wallet IN ('MAIN', 'SOLUSD') ORDER BY wallet").all().map((r) => [r.wallet, r.available_micro]), [["MAIN", 90000000], ["SOLUSD", 10000000]]);
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

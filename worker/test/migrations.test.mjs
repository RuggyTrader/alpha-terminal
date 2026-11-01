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
  it("are exactly 0001 and 0002", () => {
    assert.deepEqual(readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort(), ["0001_initial.sql", "0002_alpha_paper_ledger.sql"]);
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
});

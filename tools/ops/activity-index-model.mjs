#!/usr/bin/env node
// Activity history growth model (local SQLite with the real migrations; no production access). For N events, the cost of
// the newest page (unchanged path) and of an OLDER page (?before=) with and without an index on trade_events(occurred_at, id).
// "rows examined" counts the rows the query actually visits (sqlite stmt.all with a counting function), the quantity D1
// bills as rows_read.
//   node tools/ops/activity-index-model.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "worker");
function db(n, indexed) {
  const d = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => /^\d{4}_/.test(f)).sort()) d.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  if (indexed) d.exec("CREATE INDEX IF NOT EXISTS idx_trade_events_occurred ON trade_events(occurred_at, id)");
  let visits = 0;
  d.function("visit", { deterministic: false }, () => { visits++; return 1; });
  const ins = d.prepare(`INSERT INTO trade_events (event_key, kind, source, symbol, side, classification, occurred_at, created_at) VALUES (?, 'ORDER_PENDING', 'funded', 'SOLUSD', 'LONG', 'live', ?, 'x')`);
  d.exec("BEGIN");
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  // mostly in order, with some out-of-order inserts (late catch-up records), as production has
  for (let i = 0; i < n; i++) ins.run(`k${i}`, new Date(t0 + i * 60_000 - (i % 97 === 0 ? 3_600_000 : 0)).toISOString());
  d.exec("COMMIT");
  return { d, visits: () => visits, reset: () => { visits = 0; } };
}
const T0 = Date.parse("2026-01-01T00:00:00Z");
const rows = [];
for (const n of [216, 5000, 20000, 100000]) {
  for (const indexed of [false, true]) {
    const x = db(n, indexed);
    const before = new Date(T0 + Math.floor(n / 2) * 60_000).toISOString();
    const q = (sql, ...a) => { x.reset(); const t = performance.now(); const r = x.d.prepare(sql).all(...a); return { ms: +(performance.now() - t).toFixed(2), rows: r.length, visited: x.visits() }; };
    const newest = q(`SELECT e.id FROM trade_events e WHERE e.kind <> 'TEST' AND visit() ORDER BY e.id DESC LIMIT 30`);
    const older = q(`SELECT e.id FROM trade_events e WHERE e.kind <> 'TEST' AND e.occurred_at <= ? AND visit() ORDER BY e.occurred_at DESC, e.id DESC LIMIT 30`, before);
    const plan = x.d.prepare(`EXPLAIN QUERY PLAN SELECT e.id FROM trade_events e WHERE e.kind <> 'TEST' AND e.occurred_at <= ? ORDER BY e.occurred_at DESC, e.id DESC LIMIT 30`).all(before).map((r) => r.detail).join("; ");
    rows.push({ events: n, index: indexed, newest_visited: newest.visited, older_visited: older.visited, older_ms: older.ms, plan });
  }
}
console.table(rows);

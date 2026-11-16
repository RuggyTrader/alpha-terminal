#!/usr/bin/env node
// Strict-fill observation (docs/STRICT-FILL-ROLLOUT.md step 4). READ-ONLY: SELECT queries against production D1 via
// wrangler; prints no secrets. For every fleet order accepted since the engine switch it checks:
//   * a fill's candle started at or after the order's ledger acceptance (received_at)  → "strict-compatible"
//   * no order was replaced by one with the same side and limit (a size-only re-placement)
//   * at most one ENTRY fill per order and per trade (no duplicates)
//   node scripts/strict-fill-observe.mjs --since 2026-11-16T03:19:37Z
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const since = arg("since", "2026-11-16T03:19:37Z");
if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(since)) throw new Error("--since must be an ISO UTC time");
// wrangler is run by node directly, never through npx: on Windows the npx launcher hangs on some argument strings
// before wrangler starts (diagnosed 2026-11-16; the same query returns in ~2 s this way). No shell, so no quoting.
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const q = (sql) => JSON.parse(execFileSync(process.execPath, [WRANGLER, "d1", "execute", "alpha-terminal-db", "--remote", "--json", "--command", sql.replace(/\s+/g, " ")],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 }))[0].results;

const orders = q(`SELECT order_id, bot_id, side, limit_price, requested_qty, accepted_qty, placed_at, received_at, status, code, fill_trade_id, updated_at
  FROM bot_pending_orders WHERE received_at >= '${since}' OR updated_at >= '${since}' OR status = 'PENDING' ORDER BY received_at`);
// price_at is the fill candle's CLOSE; the candle's start is recorded as the position's opened_at (bot_ledger.ts fillAt).
const fills = q(`SELECT f.id, f.fill_id, f.bot_id, f.trade_id, f.kind, f.side, f.qty, f.price, f.price_at, f.filled_at, p.opened_at AS candle_start
  FROM bot_fills f LEFT JOIN bot_positions p ON p.trade_id = f.trade_id WHERE f.filled_at >= '${since}' ORDER BY f.id`);
const out = { since, checked_at: new Date().toISOString(), orders: orders.length, entry_fills: 0, exit_fills: 0, strict_ok: 0, strict_violations: [], size_only_replacements: [], duplicates: [] };

for (const f of fills) {
  if (f.kind !== "ENTRY") { out.exit_fills++; continue; }
  out.entry_fills++;
  const o = orders.find((x) => x.fill_trade_id === f.trade_id);
  if (!o) { out.strict_violations.push({ fill: f.fill_id, reason: "entry fill without a matching limit order since the switch (market entry or older order)" }); continue; }
  const candle = Date.parse(f.candle_start), accepted = Date.parse(o.received_at);
  if (candle >= accepted) out.strict_ok++;
  else out.strict_violations.push({ fill: f.fill_id, order: o.order_id, candle: f.candle_start, accepted: o.received_at, early_s: (accepted - candle) / 1000 });
  if (Number(f.qty) > Number(o.accepted_qty ?? o.requested_qty) + 1e-12) out.strict_violations.push({ fill: f.fill_id, reason: `filled ${f.qty} > accepted ${o.accepted_qty}` });
}
const byBot = {};
for (const o of orders) (byBot[o.bot_id] ??= []).push(o);
for (const list of Object.values(byBot)) for (let i = 1; i < list.length; i++) {
  const a = list[i - 1], b = list[i];
  if (a.status === "REPLACED" && a.side === b.side && Number(a.limit_price) === Number(b.limit_price)) out.size_only_replacements.push({ replaced: a.order_id, by: b.order_id, qty: [a.requested_qty, b.requested_qty] });
}
const seen = new Map();
for (const f of fills) { const k = `${f.trade_id}:${f.kind}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
for (const [k, n] of seen) if (n > 1) out.duplicates.push({ fill: k, count: n });
out.pending = orders.filter((o) => o.status === "PENDING").map((o) => ({ order: o.order_id, side: o.side, limit: o.limit_price, accepted_at: o.received_at, updated_at: o.updated_at }));
out.verdict = out.strict_violations.length || out.size_only_replacements.length || out.duplicates.length ? "ISSUES" : out.entry_fills === 0 ? "NO GENUINE FILL YET (nothing proven)" : "OK";
console.log(JSON.stringify(out, null, 1));

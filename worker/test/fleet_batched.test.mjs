// /api/dashboard/bots performance (2026-11-16): fleetSection reads with a FIXED number of statements (1 + one batch of
// 11) instead of ~9 per bot. It must return exactly what the per-bot reference returns, on varied data: bot and legacy
// ledgers, the legacy bot after its switch (pre-switch trades merged), a PROPOSED bot, a bot with no ledger entries,
// ties in close time, open legacy trades, settings versions, malformed engine reports, mirror accounts.
//   node --test test/fleet_batched.test.mjs
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const esbuild = require(join(ROOT, "node_modules", "esbuild"));
const work = mkdtempSync(join(tmpdir(), "alpha-fleet-")); after(() => rmSync(work, { recursive: true, force: true }));
let M;
before(async () => {
  const out = join(work, "bots.mjs");
  await esbuild.build({ stdin: { contents: `export { fleetSection, fleetSectionPerBot } from "./src/bots";`, resolveDir: ROOT, loader: "ts" }, bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
  M = await import(pathToFileURL(out).href);
});

function makeD1() {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => /^\d{4}_/.test(f)).sort()) raw.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  raw.exec("PRAGMA foreign_keys = OFF");
  const counter = { statements: 0, batches: 0, awaits: 0 };
  const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a.map((v) => (v === undefined ? null : v))),
    all: async () => { counter.statements++; counter.awaits++; return { results: raw.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
    first: async () => { counter.statements++; counter.awaits++; const r = raw.prepare(sql).get(...args); return r ? { ...r } : null; },
    run: async () => { counter.statements++; counter.awaits++; raw.prepare(sql).run(...args); return { meta: {} }; } });
  return { raw, counter, prepare: (sql) => stmt(sql),
    batch: async (list) => { counter.batches++; counter.awaits++; return list.map((s) => { counter.statements++; return /^\s*SELECT/i.test(s.sql) ? { results: raw.prepare(s.sql).all(...s.args).map((r) => ({ ...r })) } : (raw.prepare(s.sql).run(...s.args), { meta: {} }); }); } };
}

function seed(db, { variant = 0 } = {}) {
  const x = (sql, ...a) => db.raw.prepare(sql).run(...a);
  // the legacy bot has moved to the bot ledger (stage S1) and keeps its legacy trades; ALPHA-04 stays PROPOSED; ALPHA-05 is new
  x(`UPDATE bots SET ledger_api = 'bot', status = 'ACTIVE' WHERE bot_id IN ('ALPHA-01', 'ALPHA-02', 'ALPHA-03')`);
  if (variant === 1) x(`UPDATE bots SET ledger_api = 'legacy' WHERE bot_id = 'ALPHA-02'`);
  x(`UPDATE bots SET entries_paused = 1 WHERE bot_id = 'ALPHA-03'`);
  x(`INSERT INTO bots (bot_id, name, group_id, symbol, timeframe_min, profile, inputs_hash, wallet, status, ledger_api, legacy_default, risk_usd, priority, created_at, updated_at)
     VALUES ('ALPHA-05', 'ALPHA 05', 'SOLANA', 'SOLUSD', 15, 'solusd-15m', 'h5', 'ALPHA-05', 'ACTIVE', 'bot', 0, 3, 5, 'now', 'now')`);
  x(`INSERT OR IGNORE INTO portfolio_wallets (wallet, kind, updated_at) VALUES ('ALPHA-05', 'STRATEGY', 'now')`);
  x(`UPDATE portfolio_wallets SET available_micro = 19986617, reserved_micro = 5000000 WHERE wallet = 'ALPHA-01'`);
  x(`UPDATE portfolio_wallets SET available_micro = 19991371 WHERE wallet = 'MAIN'`);
  let e = 0;
  const entry = (wallet, kind, group, amount) => x(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro) VALUES (?, ?, 'now', ?, ?, ?)`, `k${++e}`, group, kind, wallet, amount);
  for (const w of ["ALPHA-01", "ALPHA-02", "ALPHA-03", "ALPHA-04"]) { entry(w, "TRANSFER_IN", `ALLOC:${w}`, 20_000_000); entry(w, "TRANSFER_IN", `TOPUP:${w}`, 1_000_000); }
  entry("ALPHA-01", "TRANSFER_OUT", "SWEEP:1", -23_050); entry("MAIN", "TRANSFER_IN", "SWEEP:1", 23_050); entry("ALPHA-03", "WITHDRAW", "W:1", -500_000); entry("ALPHA-03", "TRANSFER_OUT", "MOVE:1", -100_000);
  x(`INSERT INTO bot_settings (bot_id, version, risk_usd, status, requested_at, applied_at) VALUES ('ALPHA-01', 1, 10, 'SUPERSEDED', 't1', 't1'), ('ALPHA-01', 2, 2.5, 'APPLIED', 't2', 't3'), ('ALPHA-03', 1, 4, 'PENDING', 't4', NULL)`);
  x(`INSERT INTO app_meta (key, value) VALUES ('engine_status:ALPHA-01', '{"status_text":"Scanning","received_at":"2026-11-16T19:00:00Z"}'), ('engine_status:ALPHA-03', '{not json'), ('engine_status:ALPHA-99', '{"x":1}')`);
  let n = 0;
  const pos = (bot, side, status, net, closedAt, o = {}) => x(`INSERT INTO bot_positions (trade_id, bot_id, symbol, side, status, qty, entry_price, entry_fee_micro, collateral_micro, stop, tp, risk_usd, fee_model, opened_at, exit_price, exit_fee_micro, closed_at, gross_pnl_micro, net_pnl_micro, swept_micro, mark_price, mark_at)
      VALUES (?, ?, 'SOLUSD', ?, ?, 0.27, 72.3, 39721, 19860000, 72.8, 70.2, 10, 'ndax', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `T${++n}`, bot, side, status, o.opened ?? `2026-11-16T0${n % 10}:00:00Z`, status === "CLOSED" ? 72 : null, status === "CLOSED" ? 39590 : null, status === "CLOSED" ? closedAt : null,
    status === "CLOSED" ? net + 79311 : null, status === "CLOSED" ? net : null, net > 0 ? net : 0, o.mark ?? null, o.markAt ?? null);
  for (const [i, v] of [-108833, -121054, -12070, 23050, -135196, 0, 41234, -9999].entries()) pos(i % 2 ? "ALPHA-03" : "ALPHA-01", i % 3 ? "SHORT" : "LONG", "CLOSED", v, `2026-11-16T0${Math.floor(i / 2)}:30:00Z`);
  pos("ALPHA-01", "LONG", "CLOSED", 5000, "2026-11-16T00:30:00Z"); // a close-time tie
  pos("ALPHA-02", "LONG", "CLOSED", -79446, "2026-11-16T01:20:00Z"); pos("ALPHA-02", "LONG", "CLOSED", -70855, "2026-11-13T04:40:00Z");
  pos("ALPHA-03", "SHORT", "OPEN", 0, null, { mark: 64700, markAt: "2026-11-16T19:00:00Z" });
  // legacy ALPHA PAPER ledger rows of ALPHA-02 (one closed before its switch, one still open)
  x(`INSERT INTO trades (symbol, direction, status, entry_qty, entry_avg_price, open_qty, opened_at, closed_at, realized_pnl, fees_usd, gross_pnl, source, bot_id)
     VALUES ('SOLUSD', 'long', 'CLOSED', '0.12', '81.43', '0', '2026-11-13T00:35:00Z', '2026-11-13T00:40:00Z', '-0.03167912', '0', '-0.03167912', 'ALPHA_PAPER', 'ALPHA-02'),
            ('SOLUSD', 'long', 'OPEN', '0.1', '80', '0.1', '2026-11-13T02:00:00Z', NULL, '0', NULL, NULL, 'ALPHA_PAPER', 'ALPHA-02')`);
  x(`INSERT INTO mirror_accounts (account_id, symbol, timeframe, inputs_hash, created_at, updated_at, bot_id) VALUES ('MIR-A', 'SOLUSD', '5m', 'h', 'now', 'now', 'ALPHA-02'), ('MIR-B', 'BTCUSD', '1m', 'h', 'now', 'now', 'ALPHA-03'), ('MIR-C', 'ETHUSD', '5m', 'h', 'now', 'now', NULL)`);
  for (const [k, acc] of [[1, "MIR-A"], [2, "MIR-A"], [3, "MIR-B"]]) x(`INSERT INTO mirror_trades (account_id, trade_id, seq, side, qty, entry_time, entry_price, exit_time, exit_price, exit_kind, result, gross_pnl, notional_usd, entry_liquidity, exit_liquidity, cost_profile, est_fees, est_slippage, net_modelled_pnl, classification, exit_candle_json, processed_at, received_at, inputs_hash, payload_hash)
      VALUES (?, ?, ?, 'SHORT', 2, 't', 150, 't', 143, 'TP', 'TP2', ?, 300, 'maker', 'maker', 'ndax', 0.1, 0, ?, 'live', '{}', 'now', 'now', 'h', 'h')`, acc, `MT${k}`, k, k * 1.5, k * 1.2);
}

const norm = (r) => JSON.stringify({ ...r, generated_at: "X" });

describe("fleet section: batched reads", () => {
  for (const variant of [0, 1]) {
    it(`returns exactly the per-bot reference result (variant ${variant})`, async () => {
      const a = makeD1(), b = makeD1(); seed(a, { variant }); seed(b, { variant });
      const ref = await M.fleetSectionPerBot(a), got = await M.fleetSection(b);
      assert.equal(norm(got), norm(ref));
      assert.equal(got.bots.length, 5);
    });
  }
  it("statement count is fixed (12) and independent of the number of bots; the reference grows ~9 per bot", async () => {
    const a = makeD1(), b = makeD1(); seed(a); seed(b);
    await M.fleetSectionPerBot(a); await M.fleetSection(b);
    assert.equal(b.counter.statements, 12);
    assert.equal(b.counter.batches, 1);
    assert.ok(a.counter.statements >= 5 * 7, `reference: ${a.counter.statements}`);
    // add 15 more bots: the batched version still issues 12 statements
    for (let i = 6; i <= 20; i++) b.raw.prepare(`INSERT INTO bots (bot_id, name, group_id, symbol, timeframe_min, profile, inputs_hash, wallet, status, ledger_api, legacy_default, risk_usd, priority, created_at, updated_at) VALUES (?, ?, 'SOLANA', 'SOLUSD', 60, ?, 'h', ?, 'ACTIVE', 'bot', 0, 2, 9, 'now', 'now')`).run(`ALPHA-${String(i).padStart(2, "0")}`, `ALPHA ${i}`, `p${i}`, `W${i}`);
    b.counter.statements = 0;
    const r = await M.fleetSection(b);
    assert.equal(r.bots.length, 20);
    assert.equal(b.counter.statements, 12);
  });
  it("no registry: same answer as before", async () => {
    const raw = makeD1(); raw.raw.exec("DROP TABLE bots");
    assert.deepEqual(await M.fleetSection(raw), { available: false, groups: [], bots: [] });
  });
});

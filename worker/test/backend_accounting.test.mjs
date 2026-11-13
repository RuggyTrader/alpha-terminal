// Labelled TEST prices and funding, real Worker modules and migration SQL. No production connections.
import assert from 'node:assert/strict';
import { before, after, it, mock } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { sqliteD1 } from './lib/sqlite-d1.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'alpha-backend-audit-'));
let M, seq = 0;
const quotes = { SOLUSD: 80, XXBTZUSD: 100000 };
before(async () => {
  const require = createRequire(import.meta.url);
  await require(join(ROOT, 'node_modules/esbuild')).build({
    stdin: { contents: 'export * from "./src/bot_ledger"; export { portfolioSection } from "./src/portfolio"; export { fleetSection } from "./src/bots"; export { lifetimePerformance } from "./src/performance"; export { refreshMarks } from "./src/paper_ledger";', resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', outfile: join(work, 'audit.mjs'), logLevel: 'silent',
  });
  M = await import(pathToFileURL(join(work, 'audit.mjs')).href);
  mock.method(globalThis, 'fetch', async () => Response.json({ error: [], result: Object.fromEntries(Object.entries(quotes).map(([k, v]) => [k, { c: [String(v), '1'] }])) }));
});
after(() => { mock.restoreAll(); rmSync(work, { recursive: true, force: true }); });

function fixture(upTo = 7) {
  const db = sqliteD1(join(ROOT, 'migrations'), upTo);
  if (upTo >= 7) db.raw.exec("UPDATE bots SET status = 'ACTIVE' WHERE bot_id != 'ALPHA-02'");
  db.raw.exec("UPDATE portfolio_wallets SET available_micro = 1000000000, net_funding_micro = 1000000000 WHERE wallet = 'MAIN'; INSERT INTO portfolio_entries(entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro) VALUES ('TEST-DEPOSIT', 'TEST-DEPOSIT', '2026-11-13T00:00:00Z', 'DEPOSIT', 'MAIN', 1000000000, 0)");
  const env = { DB: db, WEBHOOK_SECRET: 'TEST-ONLY', KRAKEN_API_BASE: 'http://127.0.0.1:1' };
  const act = async (path, data) => (await M.handleBotOwnerAction(env, `/api/paper/${path}`, { request_id: `TEST-REQUEST-${++seq}`, ...data })).json();
  const order = async (action, data = {}) => {
    const body = { secret: 'TEST-ONLY', bot_id: 'ALPHA-01', order_id: `TEST-ORDER-${++seq}`, action, symbol: 'SOLUSD', timeframe: '1', qty: 0.1, stop: 70, config_hash: '0932a1a0cfac03f9', ...data };
    return (await M.handleBotOrder(new Request('http://test/webhook/bot-order', { method: 'POST', body: JSON.stringify(body) }), env)).json();
  };
  const row = (sql, ...args) => ({ ...db.raw.prepare(sql).get(...args) });
  return { db, env, act, order, row };
}

it('a mismatched profile hash is refused before any fill; exit remains possible with an older hash', async t => {
  const f = fixture(); t.after(() => f.db.raw.close());
  await f.act('allocate', { group: 'SOLANA', amount_usd: 100 });
  assert.equal((await f.order('OPEN_LONG', { config_hash: 'wrong-profile' })).code, 'BOT_PROFILE_MISMATCH');
  assert.equal(f.row('SELECT COUNT(*) n FROM bot_fills').n, 0);
  assert.equal((await f.order('OPEN_LONG')).code, 'DRY_RUN_ACCEPTED');
  assert.equal((await f.order('CLOSE', { config_hash: 'old-profile' })).code, 'DRY_RUN_ACCEPTED');
});

it('a shortfall cannot be bypassed by resuming or by allocating fresh cash', async t => {
  const f = fixture(); t.after(() => f.db.raw.close());
  await f.act('allocate', { group: 'SOLANA', amount_usd: 100 });
  quotes.SOLUSD = 80;
  assert.equal((await f.order('OPEN_SHORT', { qty: 0.5 })).code, 'DRY_RUN_ACCEPTED');
  quotes.SOLUSD = 300;
  assert.ok((await f.order('CLOSE')).data.shortfall_usd > 0);
  const before = f.row("SELECT * FROM portfolio_wallets WHERE wallet = 'MAIN'");
  assert.equal((await f.act('bot-entries', { bot_id: 'ALPHA-01', paused: false })).code, 'BOT_SHORTFALL');
  // Simulate an administrative race clearing the pause bit; debt itself must still block entry.
  f.db.raw.exec("UPDATE bots SET entries_paused = 0 WHERE bot_id = 'ALPHA-01'");
  await f.act('allocate', { group: 'SOLANA', amount_usd: 100 });
  quotes.SOLUSD = 80;
  assert.equal((await f.order('OPEN_LONG')).code, 'BOT_SHORTFALL');
  assert.equal(f.row("SELECT available_micro FROM portfolio_wallets WHERE wallet = 'MAIN'").available_micro, before.available_micro - 100e6);
});

it('concurrent closes sweep once; interruption rolls back every financial row and retry settles once', async t => {
  const f = fixture(); t.after(() => f.db.raw.close()); quotes.SOLUSD = 80;
  await f.act('allocate', { group: 'SOLANA', amount_usd: 100 });
  await f.order('OPEN_LONG', { order_id: 'TEST-ENTRY-ATOMIC' }); quotes.SOLUSD = 90;
  const snapshot = () => JSON.stringify(['portfolio_wallets', 'portfolio_entries', 'bot_orders', 'bot_positions', 'bot_fills'].map(table => f.db.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot();
  // Interrupt after both sweep wallet updates, before the matching transfer rows.
  f.db.failNextBatchAt(10);
  assert.equal((await f.order('CLOSE', { order_id: 'TEST-CLOSE-RETRY' })).code, 'LEDGER_ERROR');
  assert.equal(snapshot(), before);
  const rs = await Promise.all([f.order('CLOSE', { order_id: 'TEST-CLOSE-RETRY' }), f.order('CLOSE', { order_id: 'TEST-CLOSE-RACING' })]);
  assert.equal(rs.filter(r => r.code === 'DRY_RUN_ACCEPTED').length, 1);
  assert.equal(f.row("SELECT COUNT(*) n FROM bot_fills WHERE kind = 'EXIT'").n, 1);
  assert.equal(f.row("SELECT COUNT(*) n FROM portfolio_entries WHERE group_key = 'SWEEP:TEST-ENTRY-ATOMIC'").n, 2);
  assert.equal((await f.order('CLOSE', { order_id: 'TEST-CLOSE-RETRY' })).code, 'DUPLICATE');
  const summary = await M.portfolioSection(f.db);
  assert.equal(summary.consistency.ok, true, JSON.stringify(summary.consistency));
  assert.equal(summary.totals.book_balance_usd, 1000 + (1 - 0.016 - 0.018));
});

it('combined equity includes bot LONG/SHORT marks and subtracts unpaid shortfall; schema 6 remains readable', async t => {
  const f = fixture(); t.after(() => f.db.raw.close()); quotes.SOLUSD = 80;
  await f.act('allocate', { group: 'SOLANA', amount_usd: 100 });
  await f.order('OPEN_SHORT', { qty: 0.5 });
  quotes.SOLUSD = 90;
  assert.equal((await M.refreshMarks({ ...f.env, PAPER_MARK_MIN_INTERVAL_SECONDS: "0" })).positions, 1);
  let summary = await M.portfolioSection(f.db);
  assert.equal(summary.totals.unrealized_pnl_usd, -5);
  assert.equal(summary.totals.equity_usd, 994.92);
  f.db.raw.exec("UPDATE bot_positions SET mark_price = NULL WHERE status = 'OPEN'");
  summary = await M.portfolioSection(f.db);
  assert.equal(summary.totals.unrealized_pnl_usd, null);
  assert.equal(summary.totals.equity_usd, null);
  quotes.SOLUSD = 300; await f.order('CLOSE');
  summary = await M.portfolioSection(f.db);
  assert.ok(summary.totals.shortfall_usd > 0);
  assert.equal(summary.totals.equity_usd, 1000 - 110 - 0.08 - 0.3);
  assert.equal(summary.totals.economic_net_realized_pnl_usd, -110.38);
  const old = fixture(6); t.after(() => old.db.raw.close());
  const compatible = await M.portfolioSection(old.db);
  assert.equal(compatible.totals.equity_usd, 1000);
  assert.equal(compatible.totals.shortfall_usd, 0);
});

it('lifetime aggregates exceed list caps, combine both funded ledgers and exclude mirror/sweeps', async t => {
  const f = fixture(); t.after(() => f.db.raw.close()); quotes.SOLUSD = 80;
  const ins = f.db.raw.prepare(`INSERT INTO trades (symbol, direction, status, entry_qty, entry_avg_price, open_qty, opened_at, closed_at, realized_pnl, gross_pnl, fees_usd, source, bot_id)
    VALUES ('SOLUSD', 'long', 'CLOSED', '1', '80', '0', '2026-11-12T00:00:00Z', ?, ?, ?, 0.2, 'ALPHA_PAPER', 'ALPHA-02')`);
  for (let i = 0; i < 5002; i++) ins.run(new Date(Date.parse('2026-11-12T00:01:00Z') + i * 1000).toISOString(), i % 2 ? -1 : 2, i % 2 ? -0.8 : 2.2);
  await f.act('allocate', { group: 'SOLANA', amount_usd: 100 });
  await f.order('OPEN_LONG'); quotes.SOLUSD = 90; await f.order('CLOSE');
  const all = await M.lifetimePerformance(f.db);
  assert.equal(all.closed_trades, 5003);
  assert.equal(all.net_usd, 2501.966);
  assert.equal(all.wins, 2502);
  assert.equal(all.losses, 2501);
  assert.equal(all.max_drawdown_usd, 1);
  assert.equal((await M.lifetimePerformance(f.db, 'ALPHA-01')).closed_trades, 1);
  assert.equal((await M.lifetimePerformance(f.db, 'ALPHA-02')).closed_trades, 5002);
  const old = fixture(6); t.after(() => old.db.raw.close());
  assert.equal((await M.lifetimePerformance(old.db)).closed_trades, 0);
});

it('one bot cannot retrieve another bot order outcome through its ledger view', async t => {
  const f = fixture(); t.after(() => f.db.raw.close()); quotes.SOLUSD = 80;
  await f.act('allocate', { group: 'SOLANA', amount_usd: 100 });
  await f.order('OPEN_LONG', { order_id: 'TEST-OWNERSHIP-ENTRY' });
  const req = new Request('http://test/webhook/bot-ledger', { method: 'POST', body: JSON.stringify({ secret: 'TEST-ONLY', bot_id: 'ALPHA-03', alert_ids: ['TEST-OWNERSHIP-ENTRY'] }) });
  const view = await (await M.handleBotLedger(req, f.env)).json();
  assert.deepEqual(view.alerts, {});
});

it('concurrent different-bot entries cannot exceed the account position or exposure limit', { timeout: 5000 }, async t => {
  for (const limits of [{ MAX_OPEN_POSITIONS: '1' }, { MAX_TOTAL_EXPOSURE: '10' }]) {
    const f = fixture(); t.after(() => f.db.raw.close()); quotes.SOLUSD = 80;
    Object.assign(f.env, limits);
    await f.act('allocate', { group: 'SOLANA', amount_usd: 100 });
    await f.act('allocate', { group: 'BITCOIN', amount_usd: 100 });
    f.db.holdNextBatches(2); // Both read-side checks finish before either transaction commits.
    const rs = await Promise.all([
      f.order('OPEN_LONG', { order_id: `TEST-LIMIT-SOL-${++seq}` }),
      f.order('OPEN_SHORT', { bot_id: 'ALPHA-03', symbol: 'BTCUSD', qty: 0.00006, config_hash: 'd828caa44611ad73', order_id: `TEST-LIMIT-BTC-${++seq}` }),
    ]);
    assert.equal(rs.filter(r => r.code === 'DRY_RUN_ACCEPTED').length, 1, JSON.stringify(rs));
    assert.equal(f.row("SELECT COUNT(*) n FROM bot_positions WHERE status = 'OPEN'").n, 1);
    assert.equal((await M.portfolioSection(f.db)).consistency.ok, true);
  }
});

it('actual-reference stop risk reduces quantity and never exceeds the bot risk or request', async t => {
  const f = fixture(); t.after(() => f.db.raw.close()); quotes.SOLUSD = 80;
  await f.act('allocate', { group: 'SOLANA', amount_usd: 100 });
  const r = await f.order('OPEN_LONG', { qty: 0.5, stop: 60, risk_usd: 2 });
  assert.equal(r.code, 'DRY_RUN_ACCEPTED');
  assert.equal(r.data.qty, 0.1);
  assert.equal(r.data.reduced_to_risk, true);
  assert.ok(r.data.qty * (r.data.price - 60) <= 2);
  assert.equal(f.row("SELECT risk_usd FROM bot_positions WHERE status = 'OPEN'").risk_usd, 2);
});

it('settlement response and pause use the committed shortfall when an allocation races the close', async t => {
  const f = fixture(); t.after(() => f.db.raw.close()); quotes.SOLUSD = 80;
  await f.act('allocate', { group: 'SOLANA', amount_usd: 100 });
  await f.order('OPEN_SHORT', { qty: 0.5 });
  quotes.SOLUSD = 300;
  f.db.beforeNextBatch(() => f.act('allocate', { group: 'SOLANA', amount_usd: 100 }));
  const close = await f.order('CLOSE');
  assert.equal(close.data.shortfall_usd, 10.38);
  assert.equal(f.row("SELECT shortfall_micro FROM bot_positions WHERE status = 'CLOSED'").shortfall_micro, 10380000);
  assert.equal(f.row("SELECT entries_paused FROM bots WHERE bot_id = 'ALPHA-01'").entries_paused, 1);
  assert.equal((await M.portfolioSection(f.db)).consistency.ok, true);
});

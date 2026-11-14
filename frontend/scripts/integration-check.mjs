// Runs only in an isolated combined checkout. Local TEST ledger, synthetic orders, recorded Kraken quotes.
// Requires Node >=22, built frontend, installed Worker dependencies and Chromium. Never contacts production.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const FRONT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(FRONT, '..'), WORKER = join(REPO, 'worker');
assert.ok(existsSync(join(WORKER, 'src/performance.ts')), 'Use the combined backend + frontend integration checkout');
const OUT = join(FRONT, 'docs/integration/screenshots'); mkdirSync(OUT, { recursive: true });
const report = { label: 'LOCAL TEST ONLY: synthetic orders and recorded Kraken quotes; not production performance', backend_commit: process.env.BACKEND_COMMIT ?? '96e975357928704bc53e69fae6df1914622f446d', checks: [], screenshots: [], errors: [] };
const check = (name, evidence) => report.checks.push({ name, evidence, ok: true });
const sec = () => randomBytes(24).toString('base64url');
const WEBHOOK_SECRET = sec(), DASHBOARD_PASSPHRASE = sec(), ADMIN_SECRET = sec();
const persist = mkdtempSync(join(tmpdir(), 'alpha-front-integration-'));
const bin = join(WORKER, 'node_modules/wrangler/bin/wrangler.js');
const cli = args => execFileSync(process.execPath, [bin, ...args], { cwd: WORKER, stdio: 'ignore', timeout: 90000 });
const series = {};
for (const s of ['SOLUSD', 'BTCUSD']) {
  const doc = JSON.parse(readFileSync(join(REPO, `engine/test/fixtures/${s}-1m-2026-11-09_2026-11-13T0020.json`)));
  series[s === 'BTCUSD' ? 'XBTUSD' : s] = doc.rows;
}
const prices = { SOLUSD: series.SOLUSD.at(-1)[4], XBTUSD: series.XBTUSD.at(-1)[4] };
let failing = false;
const stub = createServer((req, res) => {
  if (failing) return res.writeHead(503, { 'Content-Type': 'application/json' }).end('{}');
  const u = new URL(req.url, 'http://127.0.0.1');
  const pairs = (u.searchParams.get('pair') ?? '').split(','); const result = {};
  for (const pair of pairs) {
    if (!(pair in prices)) continue;
    if (u.pathname.endsWith('/Ticker')) result[pair === 'XBTUSD' ? 'XXBTZUSD' : pair] = { c: [String(prices[pair]), '1'] };
    if (u.pathname.endsWith('/OHLC')) {
      const tf = Number(u.searchParams.get('interval') ?? 1), step = tf * 60000, grouped = [];
      for (const row of series[pair]) {
        const [ms, o, h, l, c] = row, t = ms - ms % step;
        const last = grouped.at(-1);
        if (last?.[0] === t / 1000) { last[2] = Math.max(+last[2], h); last[3] = Math.min(+last[3], l); last[4] = String(c); }
        else grouped.push([t / 1000, String(o), String(h), String(l), String(c), '0', '0', 1]);
      }
      result[pair === 'XBTUSD' ? 'XXBTZUSD' : pair] = grouped.slice(-720); result.last = grouped.at(-1)?.[0];
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: [], result }));
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`, port = 8874, base = `http://127.0.0.1:${port}`;
let worker, browser;
const dbFile = () => { const d = join(persist, 'v3/d1/miniflare-D1DatabaseObject'); return join(d, readdirSync(d).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite')); };
const sql = q => { const d = new DatabaseSync(dbFile()); try { d.exec(q); } finally { d.close(); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  cli(['d1', 'migrations', 'apply', 'alpha-terminal-db', '--local', '--persist-to', persist]);
  sql("UPDATE bots SET status = 'ACTIVE' WHERE bot_id IN ('ALPHA-01','ALPHA-03','ALPHA-04')"); // LOCAL TEST fixture only
  const args = [bin, 'dev', '--local', '--port', String(port), '--inspector-port', '9474', '--ip', '127.0.0.1', '--persist-to', persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: STUB, ALPACA_KEY: '', ALPACA_SECRET: '', PAPER_COST_PROFILE: 'none' })) args.push('--var', `${k}:${v}`);
  worker = spawn(process.execPath, args, { cwd: WORKER, stdio: 'ignore', detached: true });
  let ready = false;
  for (let i = 0; i < 90; i++) { try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {} await sleep(500); }
  assert.ok(ready, 'local Worker ready');
  const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Alpha-Terminal': '1' }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(s => s.split(';')[0]).find(s => s.startsWith('at_session='));
  const request = async (path, body = undefined) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Alpha-Terminal': '1', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const json = await r.json(); assert.equal(r.status, 200, `${path}: ${json.code}`); return json;
  };
  const act = (kind, body) => request(`/api/paper/${kind}`, { ...body, request_id: sec(), passphrase: DASHBOARD_PASSPHRASE });
  await act('fund', { action: 'deposit', amount_usd: 1000 });
  await act('allocate', { group: 'SOLANA', amount_usd: 200 }); await act('allocate', { group: 'BITCOIN', amount_usd: 200 });
  const hash = { 'ALPHA-01': '0932a1a0cfac03f9', 'ALPHA-03': 'd828caa44611ad73', 'ALPHA-04': 'a6336dad6ffaed70' };
  let seq = 0;
  const order = async (bot, action, extra = {}) => {
    const symbol = bot === 'ALPHA-01' ? 'SOLUSD' : 'BTCUSD', tf = bot === 'ALPHA-04' ? '5' : '1';
    const r = await request('/webhook/bot-order', { secret: WEBHOOK_SECRET, bot_id: bot, symbol, timeframe: tf, config_hash: hash[bot], action, order_id: `TEST-INTEGRATION-${++seq}-${bot}-${action}`, qty: symbol === 'SOLUSD' ? 0.1 : 0.0001, stop: symbol === 'SOLUSD' ? prices.SOLUSD - 1 : prices.XBTUSD + 1000, ...extra });
    assert.equal(r.code, 'DRY_RUN_ACCEPTED', r.code); return r;
  };
  const now = new Date().toISOString(), px = prices.SOLUSD;
  const plan = { v: 1, side: 'LONG', setup_at: now, swing: { origin: px - 1, end: px + 1 }, ote_705: px - 0.1, profile: 'solusd-1m', inputs_hash: hash['ALPHA-01'],
    rules: { entry_mode: 'Limit @ 0.705', sl_mode: 'Swing origin (1.0)', sl_buf_atr: 0.1, tp2_ext: -0.55, min_score: 1 },
    order: { placed_at: now, type: 'LIMIT', limit: px - 0.1, stop: px - 1.5, tp2: px + 1.5, qty: 0.5, score: 2 }, filled_at: now, strategy_entry: px - 0.1, initial_stop: px - 1.5, tp2: px + 1.5, score: 2, confluence: ['FVG','OB'], stop_history: [] };
  const first = await order('ALPHA-01', 'OPEN_LONG', { qty: 0.5, risk_usd: 0.15, stop: px - 1.5, tp: px + 1.5, plan });
  assert.ok(first.data.qty < 0.5 && first.data.reduced_to_risk);
  const proofId = first.data.trade_id;
  await order('ALPHA-01', 'CLOSE', { exit: { v: 1, kind: 'SL', result: 'BE', strategy_exit: px, stop_at_exit: px, tp2: px + 1.5, stop_history: [] } });
  // More than the first list page, all closed through the real routes; no fabricated performance aggregate.
  for (let i = 0; i < 204; i++) { await order('ALPHA-01', 'OPEN_LONG'); await order('ALPHA-01', 'CLOSE'); }
  await order('ALPHA-03', 'OPEN_SHORT'); await order('ALPHA-03', 'CLOSE');
  await order('ALPHA-04', 'OPEN_SHORT'); // real local ledger open position for valuation checks
  const dry = (action, suffix, extra = {}) => request('/webhook/dry-run', { secret: WEBHOOK_SECRET, id: `ENG-SOLUSD-5-TEST-INTEGRATION-${suffix}`, symbol: 'SOLUSD', timeframe: '5', action, strategy: 'TEST synthetic integration order', timestamp: now, ...extra });
  assert.equal((await dry('BUY', 'BUY', { qty: 0.1 })).code, 'DRY_RUN_ACCEPTED');
  assert.equal((await dry('CLOSE', 'CLOSE')).code, 'DRY_RUN_ACCEPTED');
  const backend = (await request('/api/dashboard/performance')).data;
  assert.equal(backend.lifetime.closed_trades, 207);
  check('authentic integrated lifetime aggregate exceeds recent-row cap', { backend_closed_trades: backend.lifetime.closed_trades, legacy_rows: backend.trades.length, sample_sources: 'synthetic local TEST orders, recorded Kraken ticker quotes' });
  report.history_api = [];
  for (const path of ['/api/dashboard/bot-trades?limit=5000', '/api/dashboard/bot-trades?bot=ALPHA-02&limit=50']) { const r = await fetch(base + path, {headers:{Cookie:cookie}}); const d = await r.json(); report.history_api.push({path,status:r.status,code:d.code,message:d.message,rows:d.data?.trades?.length}); }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: JSON.parse(process.env.CHROMIUM_ARGS ?? '["--no-sandbox","--disable-dev-shm-usage"]') });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 1, locale: 'en-CA', timezoneId: 'America/Toronto' });
  await ctx.addCookies([{ name: 'at_session', value: cookie.slice('at_session='.length), url: base }]);
  await ctx.addInitScript(() => { if (!localStorage.getItem('at-theme')) localStorage.setItem('at-theme', 'light'); });
  const page = await ctx.newPage(); page.on('pageerror', e => report.errors.push(e.message));
  const overlay = async () => page.evaluate(() => {
    if (document.getElementById('local-test-label')) return;
    const el = document.createElement('div'); el.id = 'local-test-label'; el.textContent = 'LOCAL TEST · synthetic orders / recorded Kraken quotes';
    Object.assign(el.style, { position: 'fixed', bottom: '72px', left: '4px', right: '4px', background: '#fff1c2', color: '#291d00', font: '10px sans-serif', padding: '5px', zIndex: '99999', textAlign: 'center', pointerEvents: 'none', borderRadius: '4px' }); document.body.append(el);
  });
  const goto = async path => { await page.goto(base + path); await page.waitForSelector('.page-title, .hero, [aria-label="Price chart"], .bots-page', { timeout: 20000 }); await sleep(350); await overlay(); };
  const visible = async (selector, text) => page.locator(selector).filter({ hasText: text }).first().waitFor({ timeout: 15000 });
  const shot = async (name, focus = null) => {
    await overlay(); await page.evaluate(() => { window.scrollTo(0, 0); return document.fonts.ready; }); await sleep(300);
    if (focus) await page.locator(focus).first().scrollIntoViewIfNeeded();
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(sizes.document <= sizes.viewport + 1 && sizes.body <= sizes.viewport + 1, `horizontal overflow ${name}: ${JSON.stringify(sizes)}`);
    const fullPage = await page.evaluate(() => document.documentElement.scrollHeight <= 3000);
    await page.screenshot({ path: join(OUT, name + '.jpg'), fullPage, type: 'jpeg', quality: 78 });
    report.screenshots.push({ name: name + '.jpg', viewport: page.viewportSize(), document_width: sizes.document, body_width: sizes.body, full_page: fullPage });
  };
  await goto('/');
  await visible('.hero-strip', '207');
  check('Home uses complete account lifetime count', 207); await shot('LOCAL-TEST-mobile-home-light');
  await goto('/performance'); await visible('[aria-label="Verified metrics"]', '207');
  await visible('[aria-label="Equity curve"]', 'COMPLETE FUNDED CURVE UNAVAILABLE');
  check('complete lifetime headlines retained while bounded history is explicitly refused as a full account curve', true);
  await page.getByRole('tab', { name: '1D', exact: true }).click(); await visible('[aria-label="Verified metrics"]', '207');
  check('history range does not replace lifetime headline statistics', true);
  await shot('LOCAL-TEST-mobile-performance');
  await goto('/performance?bot=ALPHA-01'); await visible('[aria-label="ALPHA-01 funded performance"]', '205');
  check('per-bot lifetime count is 205 despite the bounded 50-row history', 205); await shot('LOCAL-TEST-mobile-bot-performance');
  await goto('/trades'); await page.getByRole('tab', { name: /^Completed/ }).click();
  await visible('[aria-label="Completed trades"]', 'ALPHA 01'); await shot('LOCAL-TEST-mobile-all-bot-history');
  await visible('[aria-label="Completed trades"]', 'ALPHA 02');
  const allRows = await page.locator('.tcard').count(); assert.ok(allRows >= 49 && allRows <= 100); check('all-bot history includes bot and legacy ledgers with explicit backend pagination limit', allRows);
  // Hold an old filter's response, navigate to another bot, then release it. The late response must not change scope.
  let releaseOld, oldIntercepted = false;
  const oldGate = new Promise(r => { releaseOld = r; });
  await page.route('**/api/dashboard/bot-trades?**', async route => {
    const u = new URL(route.request().url());
    if (u.searchParams.get('bot') === 'ALPHA-01' && !oldIntercepted) { oldIntercepted = true; await oldGate; }
    await route.continue();
  });
  await page.getByRole('link', { name: 'ALPHA 01 · SOLUSD 1m', exact: true }).click();
  await page.waitForFunction(() => location.search.includes('ALPHA-01'));
  await page.getByRole('link', { name: 'ALPHA 03 · BTCUSD 1m', exact: true }).click();
  await visible('[aria-label="Filtered records"]', 'ALPHA 03'); releaseOld(); await sleep(500);
  assert.ok(!(await page.locator('[aria-label="Filtered records"]').innerText()).includes('ALPHA 01'));
  check('late response from previous bot filter cannot overwrite current scope', true);
  await page.unroute('**/api/dashboard/bot-trades?**');
  const newFill = await order('ALPHA-03', 'OPEN_SHORT'); await order('ALPHA-03', 'CLOSE');
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click(); await visible('[aria-label="Bot orders"]', newFill.data.trade_id);
  check('filtered trade refresh shows a newly settled order without navigation', true);
  await page.route('**/api/dashboard/bot-trades?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'TEST_OUTAGE', message: 'LOCAL TEST outage' }) }));
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click(); await visible('[aria-label="Filtered records"]', 'STALE RECORDS');
  await visible('[aria-label="Bot orders"]', newFill.data.trade_id); await shot('LOCAL-TEST-mobile-stale-filter');
  check('failed refresh retains correctly scoped prior records and labels stale', true); await page.unroute('**/api/dashboard/bot-trades?**');
  await goto('/'); await visible('.hero-strip', '208'); check('bot-only close refreshes account performance without a legacy close', 208);
  await goto(`/bots/trade/${proofId}`); await visible('[aria-label="Trade"]', 'Quantity reduced');
  check('reduced filled quantity and requested quantity shown from actual order and position evidence', first.data.qty); await shot('LOCAL-TEST-mobile-trade-proof');
  await goto('/bots/ALPHA-01/chart'); await page.waitForSelector('canvas');
  await page.getByRole('button', { name: 'Fit candles', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Fit trade levels', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
  await page.getByRole('button', { name: 'Full screen', exact: true }).click(); await page.locator('.bot-chart-wrap.is-full').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.bot-chart-wrap.is-full').count(), 0); check('chart reset, fit-level toggle and full-screen controls', true); await shot('LOCAL-TEST-mobile-chart');
  const legacy = (await request('/api/dashboard/trades?limit=50')).data[0];
  await goto('/trades?bot=ALPHA-02'); await page.locator('.tcard button').first().click();
  const legacyChart = page.getByRole('link', { name: 'View chart', exact: true }).first();
  assert.match(await legacyChart.getAttribute('href'), /ledger=legacy&trade=\d+$/); await legacyChart.click();
  await visible('[aria-label="This trade"]', 'Why it entered'); await sleep(500);
  assert.ok(!(await page.locator('body').innerText()).includes('Trade details unavailable'));
  check('legacy trade chart link uses numeric proof id, not engine alert id', legacy.id);
  await goto('/portfolio'); await shot('LOCAL-TEST-mobile-portfolio');
  await goto('/bots'); await visible('[aria-label="ALPHA 01 SOLUSD 1m"]', 'Net P'); await shot('LOCAL-TEST-mobile-bots');
  // Refuse quotes, age the recorded mark in the LOCAL fixture, then clear it. Keep actual API semantics.
  failing = true;
  sql("UPDATE bot_positions SET mark_at = '2026-01-01T00:00:00Z' WHERE status = 'OPEN'; UPDATE app_meta SET value = '2026-01-01T00:00:00Z' WHERE key = 'paper_marks_refreshed_at'");
  await goto('/'); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await visible('[data-valuation="STALE"]', 'STALE MARKET MARKS');
  await shot('LOCAL-TEST-mobile-stale-marks', '[data-valuation="STALE"]'); check('aged bot market marks explicitly label stale account equity', true);
  sql("UPDATE bot_positions SET mark_price = NULL, mark_at = NULL WHERE status = 'OPEN'");
  await goto('/'); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await visible('[data-valuation="UNAVAILABLE"]', 'EQUITY UNAVAILABLE');
  await shot('LOCAL-TEST-mobile-equity-unavailable', '[data-valuation="UNAVAILABLE"]'); check('missing bot mark yields unavailable account equity instead of zero', true);
  failing = false;
  await page.setViewportSize({ width: 1440, height: 1000 }); await goto('/performance'); await visible('[aria-label="Verified metrics"]', '208'); await shot('LOCAL-TEST-desktop-performance');
  await page.evaluate(() => { localStorage.setItem('at-theme', 'dark'); }); await page.reload(); await sleep(500); await overlay(); await shot('LOCAL-TEST-desktop-dark-performance');
  await page.setViewportSize({ width: 402, height: 874 }); await goto('/'); await visible('.hero-strip', '208'); await shot('LOCAL-TEST-mobile-home-dark');
  assert.deepEqual(report.errors, [], 'no browser runtime exceptions');
  report.ok = true;
} catch (e) {
  report.ok = false; report.failure = String(e.stack ?? e).replaceAll(WEBHOOK_SECRET, '[REDACTED]').replaceAll(DASHBOARD_PASSPHRASE, '[REDACTED]').replaceAll(ADMIN_SECRET, '[REDACTED]');
  throw e;
} finally {
  writeFileSync(join(FRONT, 'docs/integration/browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  if (worker?.pid) { try { process.kill(-worker.pid, 'SIGTERM'); } catch {} }
  await new Promise(r => stub.close(r)); rmSync(persist, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, screenshots: report.screenshots.length }));

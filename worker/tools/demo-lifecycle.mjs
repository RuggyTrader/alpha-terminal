// DEMO / HISTORICAL REPLAY: an isolated end-to-end walk-through of ALPHA TERMINAL (never production).
//   npm --prefix ../frontend run build && node tools/demo-lifecycle.mjs --out ../docs/demo/2026-11-13
// * Local Worker (wrangler dev), fresh D1 with every migration, random secrets (never printed).
// * Market data: RECORDED Kraken 1m candles from engine/data (real prices, real timestamps) via a local stub: HISTORICAL
//   REPLAY. The stub's "current price" follows the recorded candles; nothing is animated or invented.
// * Orders: DEMO orders sent through the Worker's own webhook routes with plans/exit reasons in the engine's format —
//   SYNTHETIC lifecycle events for the walk-through, labelled DEMO in every file name. Nothing touches production.
// Scenario: pending SOL 1m LONG -> fill -> stop to break-even -> take-profit win (sweep to MAIN) -> losing BTC SHORT
// (stop loss) -> open BTC SHORT -> unaffordable order rejected -> Home in three scopes -> assistant -> stale state.
// Each step is captured at 402 px in light and dark (Chrome headless via the DevTools protocol, Node's WebSocket).

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = arg("out", join(DIR, "..", "docs", "demo", "2026-11-13"));
const WIN = process.platform === "win32";
const PORT = 8881, base = `http://127.0.0.1:${PORT}`;
const sec = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = sec(), DASHBOARD_PASSPHRASE = sec(), ADMIN_SECRET = sec();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- recorded Kraken candles (HISTORICAL REPLAY)
const rec = (f) => JSON.parse(readFileSync(join(DIR, "..", "engine", "data", f), "utf8")).candles;
const SERIES = { SOLUSD: rec("SOLUSD-1m-14d.json").slice(-700), XBTUSD: rec("BTCUSD-1m-11d.json").slice(-700) };
const agg = (cs, m) => { const out = []; for (const k of cs) { const t = Math.floor(k.t / (m * 60000)) * m * 60000; const l = out.at(-1); if (l && l.t === t) { l.h = Math.max(l.h, k.h); l.l = Math.min(l.l, k.l); l.c = k.c; l.v += k.v; } else out.push({ ...k, t }); } return out; };
const KEY = { SOLUSD: "SOLUSD", XBTUSD: "XXBTZUSD" };
let tickerOverride = {}; // used once, to show a genuine affordability refusal at a recorded-range price
const stub = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1"); const pairs = (u.searchParams.get("pair") ?? "").split(",");
  if (u.pathname === "/0/public/Ticker") { const result = {}; for (const p of pairs) if (SERIES[p]) result[KEY[p]] = { c: [String(tickerOverride[p] ?? SERIES[p].at(-1).c), "1.0"] };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result })); return; }
  if (u.pathname === "/0/public/OHLC" && SERIES[pairs[0]]) { const cs = agg(SERIES[pairs[0]], Number(u.searchParams.get("interval") ?? 1));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result: { [KEY[pairs[0]]]: cs.map((k) => [k.t / 1000, k.o, k.h, k.l, k.c, k.c, k.v, 1]), last: cs.at(-1).t / 1000 } })); return; }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const persist = mkdtempSync(join(tmpdir(), "alpha-demo-"));
const wr = (a) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...a], { cwd: DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
wr(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
{ const d = join(persist, "v3", "d1", "miniflare-D1DatabaseObject"); const db = new DatabaseSync(join(d, readdirSync(d).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")));
  db.exec(`UPDATE bots SET status = 'ACTIVE' WHERE bot_id IN ('ALPHA-01', 'ALPHA-03', 'ALPHA-04')`); db.close(); } // DEMO activation in this local DB only
const wargs = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: STUB, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) wargs.push("--var", `${k}:${v}`);
let worker = spawn(WIN ? "npx.cmd" : "npx", wargs, { cwd: DIR, stdio: "ignore", shell: WIN, detached: !WIN });
const killWorker = () => { try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ } };
let chrome = null; const profile = mkdtempSync(join(tmpdir(), "alpha-demo-chrome-"));
const log = [];
try {
  for (const end = Date.now() + 120000; Date.now() < end; await sleep(500)) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  const cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: sec(), ...body, passphrase: DASHBOARD_PASSPHRASE }) }).then((r) => r.json());
  const SYM = { "ALPHA-01": "SOLUSD", "ALPHA-03": "BTCUSD", "ALPHA-04": "BTCUSD" }, TF = { "ALPHA-01": "1", "ALPHA-03": "1", "ALPHA-04": "5" };
  const order = (bot, action, o) => fetch(`${base}/webhook/bot-order`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: bot, action, symbol: SYM[bot], timeframe: TF[bot], risk_usd: 10, profile: o.plan?.profile ?? null, ...o }) }).then((r) => r.json());
  const lastT = (p) => new Date(SERIES[p].at(-1).t + 60000).toISOString();
  const report = (botId, symbol, timeframe, extra) => fetch(`${base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: WEBHOOK_SECRET, status: { engine: "alpha-engine", symbol, timeframe, bot_id: botId, status_text: "DEMO report", last_candle_time: lastT(symbol === "SOLUSD" ? "SOLUSD" : "XBTUSD"), last_candle_close: SERIES[symbol === "SOLUSD" ? "SOLUSD" : "XBTUSD"].at(-1).c, ...extra } }) }).then((r) => r.json());
  const setPx = (p, v) => { SERIES[p] = [...SERIES[p].slice(0, -1), { ...SERIES[p].at(-1), c: v }]; };
  const sol = SERIES.SOLUSD.at(-1).c, btc = SERIES.XBTUSD.at(-1).c;
  const r2 = (v) => Math.round(v * 100) / 100, r1 = (v) => Math.round(v * 10) / 10;

  await act("fund", { action: "deposit", amount_usd: 1000 });
  await act("allocate", { group: "SOLANA", amount_usd: 200 });
  await act("allocate", { group: "BITCOIN", amount_usd: 200 });

  // ---- 1. ALPHA-01 SOL 1m: a qualifying setup with a pending LONG limit (DEMO levels around the recorded price)
  const leg = { origin: r2(sol * 0.994), end: r2(sol * 1.004) };
  const ote = leg.end + (leg.origin - leg.end) * 0.705;
  const plan = { v: 1, side: "LONG", setup_at: lastT("SOLUSD"), swing: leg, ote_705: Number(ote.toFixed(4)), profile: "solusd-1m", inputs_hash: "0932a1a0cfac03f9",
    rules: { entry_mode: "Limit @ 0.705", sl_mode: "Swing origin (1.0)", sl_buf_atr: 0.1, tp2_ext: -0.55, min_score: 1 },
    order: { placed_at: lastT("SOLUSD"), type: "LIMIT", limit: r2(ote), stop: r2(leg.origin - 0.02), tp2: r2(leg.end + 0.55 * (leg.end - leg.origin)), qty: 0.5, score: 2 } };
  const st = (o) => ({ direction: "LONG", leg_start: leg.origin, leg_end: leg.end, setup_bars: 6, max_age_bars: 75, pending_order: null, current_stop: null, break_even_done: false, trailing: false, ...o });
  await report("ALPHA-01", "SOLUSD", "1m", { strategy_state: st({}) });
  await report("ALPHA-01", "SOLUSD", "1m", { strategy_state: st({ pending_order: { side: "LONG", qty: 0.5, limit: plan.order.limit, stop: plan.order.stop, tp: plan.order.tp2, score: 2, confluence: ["FVG", "OB"], placed_at: plan.order.placed_at, ote_705: plan.ote_705 } }) });
  log.push({ step: 1, what: "pending LONG limit reported by ALPHA-01", limit: plan.order.limit, stop: plan.order.stop, tp2: plan.order.tp2 });
  const shots = [];
  const snap = (name, path, after = null) => shots.push({ name, path, after });
  snap("01-bots-pending-order", "/bots");
  snap("02-pending-order-chart", "/bots/ALPHA-01/chart");

  // ---- 2. the limit fills (the ledger fills at the replayed price), stop moves to break-even
  const queued = [];
  queued.push(async () => {
    setPx("SOLUSD", plan.order.limit);
    const fill = { ...plan, filled_at: lastT("SOLUSD"), strategy_entry: plan.order.limit, initial_stop: plan.order.stop, tp2: plan.order.tp2, score: 2, confluence: ["FVG", "OB"], stop_history: [] };
    const o = await order("ALPHA-01", "OPEN_LONG", { order_id: "DEMO-ALPHA-01-SOLUSD-1-T1-OPEN_LONG", qty: 0.5, stop: fill.initial_stop, tp: fill.tp2, plan: fill });
    log.push({ step: 2, what: "entry filled", code: o.code, price: o.data?.price, qty: o.data?.qty, fee: o.data?.fee_usd });
    const pos = { side: "LONG", qty: 0.5, entry: plan.order.limit, stop: plan.order.stop, tp2: plan.order.tp2 };
    await report("ALPHA-01", "SOLUSD", "1m", { position: pos, strategy_state: st({ current_stop: plan.order.stop }) });
    await report("ALPHA-01", "SOLUSD", "1m", { position: pos, strategy_state: st({ current_stop: plan.order.limit, break_even_done: true }) });
    log.push({ step: 3, what: "stop moved to break-even", stop: plan.order.limit });
    return fill;
  });
  snap("03-open-long-chart", "/bots/ALPHA-01/chart", 0);
  snap("04-activity-lifecycle", "/activity", 0);

  // ---- 3. take profit: the trade closes at its target; net profit is swept to MAIN
  queued.push(async (fill) => {
    setPx("SOLUSD", plan.order.tp2);
    const exit = { v: 1, kind: "TP", result: "TP2", exit_r: Number(((plan.order.tp2 - plan.order.limit) / (plan.order.limit - plan.order.stop)).toFixed(4)), strategy_exit: plan.order.tp2,
      initial_stop: plan.order.stop, stop_at_exit: plan.order.limit, tp2: plan.order.tp2, stop_history: [{ at: lastT("SOLUSD"), stop: plan.order.limit, reason: "BREAK_EVEN" }] };
    const c = await order("ALPHA-01", "CLOSE", { order_id: "DEMO-ALPHA-01-SOLUSD-1-T1-CLOSE", exit });
    log.push({ step: 4, what: "take profit, settled", code: c.code, gross: c.data?.gross_usd, net: c.data?.net_usd, swept: c.data?.swept_to_main_usd });
    await report("ALPHA-01", "SOLUSD", "1m", { strategy_state: st({ direction: null }) });
    setPx("SOLUSD", sol);
    // ---- 4. a losing BTC 1m SHORT (stop loss) and an open BTC 5m SHORT
    const bplan = { v: 1, side: "SHORT", setup_at: lastT("XBTUSD"), swing: { origin: r1(btc * 1.004), end: r1(btc * 0.996) }, ote_705: r1(btc * 0.996 + (btc * 1.004 - btc * 0.996) * 0.705), profile: "btcusd-1m", inputs_hash: "d828caa44611ad73",
      rules: { entry_mode: "Limit @ 0.705", sl_mode: "Swing origin (1.0)", sl_buf_atr: 0.2, tp2_ext: -0.55, min_score: 1 },
      order: { placed_at: lastT("XBTUSD"), type: "LIMIT", limit: r1(btc * 1.0017), stop: r1(btc * 1.0042), tp2: r1(btc * 0.9916), qty: 0.0008, score: 1 }, strategy_entry: r1(btc * 1.0017), initial_stop: r1(btc * 1.0042), tp2: r1(btc * 0.9916), score: 1, confluence: ["RB"], stop_history: [] };
    setPx("XBTUSD", bplan.order.limit);
    await order("ALPHA-03", "OPEN_SHORT", { order_id: "DEMO-ALPHA-03-BTCUSD-1-T2-OPEN_SHORT", qty: 0.0008, stop: bplan.initial_stop, tp: bplan.tp2, plan: bplan });
    setPx("XBTUSD", bplan.initial_stop);
    const lc = await order("ALPHA-03", "CLOSE", { order_id: "DEMO-ALPHA-03-BTCUSD-1-T2-CLOSE", exit: { v: 1, kind: "SL", result: "SL", exit_r: -1, strategy_exit: bplan.initial_stop, initial_stop: bplan.initial_stop, stop_at_exit: bplan.initial_stop, tp2: bplan.tp2, stop_history: [] } });
    log.push({ step: 5, what: "losing BTC SHORT (stop loss)", net: lc.data?.net_usd, swept: lc.data?.swept_to_main_usd });
    setPx("XBTUSD", btc);
    const oplan = { ...bplan, profile: "btcusd-5m", inputs_hash: "a6336dad6ffaed70", order: { ...bplan.order, limit: r1(btc) }, strategy_entry: r1(btc), confluence: ["FVG"] };
    await order("ALPHA-04", "OPEN_SHORT", { order_id: "DEMO-ALPHA-04-BTCUSD-5-T3-OPEN_SHORT", qty: 0.0006, stop: oplan.initial_stop, tp: oplan.tp2, plan: oplan });
    await report("ALPHA-04", "BTCUSD", "5m", { position: { side: "SHORT", qty: 0.0006, entry: r1(btc), stop: oplan.initial_stop, tp2: oplan.tp2 }, strategy_state: { direction: "SHORT", leg_start: oplan.swing.origin, leg_end: oplan.swing.end, setup_bars: 3, max_age_bars: 37, pending_order: null, current_stop: oplan.initial_stop, break_even_done: false, trailing: false } });
    // ---- 5. a genuinely unaffordable order: ALPHA-03 has ~$100 left; a 0.01 BTC order at the replayed price cannot fit and the
    //         smallest size it could afford is below Kraken's minimum only at an extreme price; here: plainly refused when the
    //         wallet cannot pay even the minimum after the price moves (refusal recorded with its code).
    // SYNTHETIC edge case (labelled): a reference price far outside the recorded range, used ONLY to exercise the ledger's
    // affordability refusal (the wallet cannot pay even Kraken's minimum quantity). It is not drawn on any chart.
    tickerOverride = { XBTUSD: btc * 30 };
    const rj = await order("ALPHA-03", "OPEN_LONG", { order_id: "DEMO-ALPHA-03-BTCUSD-1-T4-OPEN_LONG", qty: 0.002 });
    tickerOverride = {};
    log.push({ step: 6, what: "unaffordable order", code: rj.code, message: rj.message });
    await report("ALPHA-03", "BTCUSD", "1m", { strategy_state: { direction: null, leg_start: null, leg_end: null, setup_bars: null, max_age_bars: 85, pending_order: null, current_stop: null, break_even_done: false, trailing: false } });
  });
  snap("05-completed-trade-card", "/trades?signal=DEMO-ALPHA-01-SOLUSD-1-T1-OPEN_LONG", 1);
  snap("06-trade-proof", "/bots/trade/DEMO-ALPHA-01-SOLUSD-1-T1-OPEN_LONG", 1);
  snap("07-completed-trade-chart", "/bots/ALPHA-01/chart?ledger=bot&trade=DEMO-ALPHA-01-SOLUSD-1-T1-OPEN_LONG", 1);
  snap("08-ask-alpha-about-trade", "/trades?signal=DEMO-ALPHA-01-SOLUSD-1-T1-OPEN_LONG", 1);
  snap("09-losing-short-card", "/trades?signal=DEMO-ALPHA-03-BTCUSD-1-T2-OPEN_SHORT", 1);
  snap("10-open-short-chart", "/bots/ALPHA-04/chart", 1);
  snap("11-trades-filter-bot", "/trades?bot=ALPHA-03", 1);
  snap("12-home-funded", "/", 1);
  snap("13-home-mirror", "/", 1);
  snap("14-home-by-bot", "/", 1);
  snap("15-bots-groups-and-risk-editor", "/bots", 1);
  snap("16-performance-by-bot", "/performance?bot=ALPHA-01", 1);
  snap("17-activity", "/activity", 1);

  // ---------------------------------------------------------------- Chrome over CDP
  const exe = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
  chrome = spawn(exe, ["--headless=new", "--remote-debugging-port=9349", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let target; for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch("http://127.0.0.1:9349/json/list")).json()).find((t) => t.type === "page"); } catch { /* starting */ } if (!target) await sleep(500); }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = (expression) => cdp("Runtime.evaluate", { expression, returnByValue: true }).then((r) => r.result?.result?.value);
  await cdp("Network.enable");
  await cdp("Network.setCookie", { name: "at_session", value: cookie.split("=").slice(1).join("="), domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" });
  mkdirSync(OUT, { recursive: true });
  const results = [];
  const shoot = async (name, path, scheme) => {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await cdp("Emulation.setDeviceMetricsOverride", { width: 402, height: 874, deviceScaleFactor: 1, mobile: true });
    await cdp("Page.navigate", { url: `${base}${path}` }); await sleep(3500);
    const click = (sel, text) => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`);
    if (name === "13-home-mirror") { await click("button[role=tab]", "Strategy Mirror"); await sleep(1500); }
    if (name === "14-home-by-bot") { await click("button[role=tab]", "By bot"); await sleep(1500); }
    if (name === "08-ask-alpha-about-trade") { await click("button", "Ask ALPHA about this trade"); await sleep(1200); }
    if (name === "15-bots-groups-and-risk-editor") { await click("button", "Settings"); await sleep(600); }
    if (name === "02-pending-order-chart" || name === "03-open-long-chart" || name === "07-completed-trade-chart" || name === "10-open-short-chart") { await click("button", "Fit trade levels"); await sleep(800); }
    const m = JSON.parse(await evaluate(`JSON.stringify({ sw: document.documentElement.scrollWidth, iw: innerWidth, h: document.documentElement.scrollHeight })`));
    await cdp("Emulation.setDeviceMetricsOverride", { width: 402, height: Math.min(Math.max(874, m.h), 7000), deviceScaleFactor: 1, mobile: true }); await sleep(500);
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    const file = `DEMO-${name}-${scheme}.png`;
    writeFileSync(join(OUT, file), Buffer.from(shot.result.data, "base64"));
    results.push({ file, path, horizontal_overflow: m.sw > m.iw });
  };
  let fill = null;
  for (const [i, s] of shots.entries()) {
    if (s.after !== null && queued.length && i > 0 && shots[i - 1].after !== s.after) { const fn = queued.shift(); fill = await fn(fill); await sleep(1500); }
    for (const scheme of ["light", "dark"]) await shoot(s.name, s.path, scheme);
  }
  // ---- 6. stale / offline: load Home, then stop the local Worker and wait for the next refresh to fail
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 402, height: 874, deviceScaleFactor: 1, mobile: true });
  await cdp("Page.navigate", { url: `${base}/` }); await sleep(4000);
  killWorker(); await sleep(30000);
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, "DEMO-18-stale-offline-dark.png"), Buffer.from(shot.result.data, "base64"));
  results.push({ file: "DEMO-18-stale-offline-dark.png", path: "/ (Worker stopped after load)", horizontal_overflow: false });
  writeFileSync(join(OUT, "INDEX.json"), JSON.stringify({ label: "DEMO / HISTORICAL REPLAY — local Worker, fresh D1, synthetic DEMO orders on recorded Kraken candles. NOT production; nothing was sent to production.",
    generated_at: new Date().toISOString(), viewport: "402 px", lifecycle: log, screenshots: results }, null, 1));
  console.log(JSON.stringify({ lifecycle: log, shots: results.length, overflow: results.filter((r) => r.horizontal_overflow).map((r) => r.file) }, null, 1));
  ws.close();
} finally {
  try { chrome?.kill(); } catch { /* gone */ }
  killWorker(); stub.close();
  for (const d of [persist, profile]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
}

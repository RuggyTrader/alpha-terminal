// DEMO / HISTORICAL REPLAY — screenshots of the recovered application (never production).
//   npm --prefix ../frontend run build && node tools/recovery-screens.mjs --out ../docs/demo/2026-11-14-recovery
// * Local Worker (wrangler dev) on a fresh D1 with every migration (schema 7); random secrets, never printed.
// * Market data: RECORDED Kraken 1m candles (engine/data), TIME-SHIFTED so the last recorded candle closes one minute
//   ago (prices and candle shapes are real; timestamps are moved). Labelled HISTORICAL REPLAY.
// * Orders: DEMO orders through the Worker's real routes (durable PLACE_LIMIT -> validated limit fill -> CLOSE), their
//   levels taken from recorded candles (a limit at a recorded low/high, a target at a later recorded high, ...).
// * Engine reports: DEMO heartbeats posted to /webhook/engine-status (no engine runs here).
// Captured at 360 px and 402 px, light and dark, with a horizontal-overflow check per screen.

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
const OUT = arg("out", join(DIR, "..", "docs", "demo", "2026-11-14-recovery"));
const WIDTHS = String(arg("widths", "360,402")).split(",").map(Number);
const WIN = process.platform === "win32";
const PORT = 8883, base = `http://127.0.0.1:${PORT}`;
const sec = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = sec(), DASHBOARD_PASSPHRASE = sec(), ADMIN_SECRET = sec();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- recorded Kraken candles, time-shifted (HISTORICAL REPLAY)
const rec = (f) => JSON.parse(readFileSync(join(DIR, "..", "engine", "data", f), "utf8")).candles;
const shiftTo = (cs) => { const end = Math.floor(Date.now() / 300_000) * 300_000 - 300_000; const d = end - cs.at(-1).t; return cs.map((k) => ({ ...k, t: k.t + d })); };
const SERIES = { SOLUSD: shiftTo(rec("SOLUSD-1m-14d.json").slice(-700)), XBTUSD: shiftTo(rec("BTCUSD-1m-11d.json").slice(-700)) };
const agg = (cs, m) => { const out = []; for (const k of cs) { const t = Math.floor(k.t / (m * 60000)) * m * 60000; const l = out.at(-1); if (l && l.t === t) { l.h = Math.max(l.h, k.h); l.l = Math.min(l.l, k.l); l.c = k.c; l.v += k.v; } else out.push({ ...k, t }); } return out; };
const KEY = { SOLUSD: "SOLUSD", XBTUSD: "XXBTZUSD" };
const stub = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1"); const pairs = (u.searchParams.get("pair") ?? "").split(",");
  if (u.pathname === "/0/public/Ticker") { const result = {}; for (const p of pairs) if (SERIES[p]) result[KEY[p]] = { c: [String(SERIES[p].at(-1).c), "1.0"] };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result })); return; }
  if (u.pathname === "/0/public/OHLC" && SERIES[pairs[0]]) { const cs = agg(SERIES[pairs[0]], Number(u.searchParams.get("interval") ?? 1));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result: { [KEY[pairs[0]]]: cs.map((k) => [k.t / 1000, k.o, k.h, k.l, k.c, k.c, k.v, 1]), last: cs.at(-1).t / 1000 } })); return; }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const persist = mkdtempSync(join(tmpdir(), "alpha-recovery-"));
const wr = (a) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...a], { cwd: DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
wr(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
{ const d = join(persist, "v3", "d1", "miniflare-D1DatabaseObject"); const db = new DatabaseSync(join(d, readdirSync(d).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")));
  db.exec(`UPDATE bots SET status = 'ACTIVE' WHERE bot_id IN ('ALPHA-01', 'ALPHA-03', 'ALPHA-04')`); db.close(); } // DEMO activation in this local DB only
const wargs = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: STUB, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) wargs.push("--var", `${k}:${v}`);
const worker = spawn(WIN ? "npx.cmd" : "npx", wargs, { cwd: DIR, stdio: "ignore", shell: WIN, detached: !WIN });
const killWorker = () => { try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ } };
let chrome = null; const profile = mkdtempSync(join(tmpdir(), "alpha-recovery-chrome-"));
const log = [];
try {
  for (const end = Date.now() + 120000; Date.now() < end; await sleep(500)) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  const cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: sec(), ...body, passphrase: DASHBOARD_PASSPHRASE }) }).then((r) => r.json());
  const SYM = { "ALPHA-01": "SOLUSD", "ALPHA-02": "SOLUSD", "ALPHA-03": "BTCUSD", "ALPHA-04": "BTCUSD" }, TF = { "ALPHA-01": 1, "ALPHA-02": 5, "ALPHA-03": 1, "ALPHA-04": 5 };
  const order = (bot, action, o) => fetch(`${base}/webhook/bot-order`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: bot, action, symbol: SYM[bot], timeframe: String(TF[bot]), ...o }) }).then((r) => r.json());
  const candles = (bot) => (TF[bot] === 1 ? SERIES[SYM[bot] === "SOLUSD" ? "SOLUSD" : "XBTUSD"] : agg(SERIES[SYM[bot] === "SOLUSD" ? "SOLUSD" : "XBTUSD"], 5));
  const C = (bot, i) => { const k = candles(bot).at(i); return { t: iso(k.t), o: k.o, h: k.h, l: k.l, c: k.c, _t: k.t }; };
  const closeOf = (bot, i) => iso(candles(bot).at(i).t + TF[bot] * 60_000);
  const lastClose = (bot) => closeOf(bot, -1);
  const report = (bot, extra = {}) => fetch(`${base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: WEBHOOK_SECRET, status: { engine: "alpha-engine", symbol: SYM[bot], timeframe: `${TF[bot]}m`, bot_id: bot, status_text: "DEMO report",
      last_candle_time: C(bot, -1).t, last_candle_close: C(bot, -1).c, last_poll_at: iso(Date.now()), ledger_check: { status: "OK", issues: [] }, ...extra } }) }).then((r) => r.json());
  const st = (o) => ({ direction: null, leg_start: null, leg_end: null, setup_bars: null, max_age_bars: 120, pending_order: null, current_stop: null, break_even_done: false, trailing: false, ...o });
  const r4 = (v) => Number(v.toFixed(4)), r1 = (v) => Number(v.toFixed(1));
  // The plan in the engine's format (engine/src/tradeplan.mjs), as the real engine attaches it to every entry (DEMO values).
  const planOf = (side, o, profile, hash, placedAt, conf) => ({ v: 1, side, setup_at: placedAt, swing: { origin: o.stop, end: side === "LONG" ? r4(o.limit + (o.limit - o.stop) * 1.4) : r4(o.limit - (o.stop - o.limit) * 1.4) },
    ote_705: o.limit, profile, inputs_hash: hash, rules: { entry_mode: "Limit @ 0.705", sl_mode: "Swing origin (1.0)", sl_buf_atr: null, tp2_ext: null, min_score: 1 },
    order: { placed_at: placedAt, type: "LIMIT", limit: o.limit, stop: o.stop, tp2: o.tp }, strategy_entry: o.limit, filled_at: null, initial_stop: o.stop, tp2: o.tp, score: conf.length, confluence: conf });

  await act("fund", { action: "deposit", amount_usd: 1000 });
  await act("allocate", { group: "SOLANA", amount_usd: 200 });
  await act("allocate", { group: "BITCOIN", amount_usd: 200 });
  for (const b of ["ALPHA-01", "ALPHA-02", "ALPHA-03", "ALPHA-04"]) await report(b, { strategy_state: st({}) });

  // ---- ALPHA-01 SOL 1m: an expired order, then a pending LONG at a recorded low that later fills -------------------
  const sL = -40; const kL = C("ALPHA-01", sL);
  await order("ALPHA-01", "PLACE_LIMIT", { order_id: "DEMO-ALPHA-01-PLACE_LONG-0", side: "LONG", limit: r4(kL.l + 0.3), stop: r4(kL.l - 0.2), tp: r4(kL.l + 1.2), qty: 0.5, placed_at: closeOf("ALPHA-01", sL - 6), expires_at: closeOf("ALPHA-01", sL - 2) });
  await order("ALPHA-01", "CANCEL_ORDER", { order_id: "DEMO-ALPHA-01-CANCEL-0", target_order_id: "DEMO-ALPHA-01-PLACE_LONG-0", reason_code: "EXPIRED", reason: "the setup expired (strategy maxAge)" });
  const after = candles("ALPHA-01").slice(sL + 1);
  const tpIdx = after.reduce((bi, k, i) => (k.h > after[bi].h ? i : bi), 0);
  const L = { limit: kL.l, stop: r4(kL.l - (Math.max(...after.map((k) => k.h)) - kL.l) * 0.5), tp: r4(after[tpIdx].h) };
  const pl = await order("ALPHA-01", "PLACE_LIMIT", { order_id: "DEMO-ALPHA-01-PLACE_LONG-1", side: "LONG", limit: L.limit, stop: L.stop, tp: L.tp, qty: 0.5, placed_at: closeOf("ALPHA-01", sL - 1), expires_at: iso(Date.now() + 3600_000) });
  log.push({ step: "ALPHA-01 pending LONG", code: pl.code, limit: L.limit, stop: L.stop, tp: L.tp, accepted_qty: pl.data?.accepted_qty });
  await report("ALPHA-01", { strategy_state: st({ direction: "LONG", setup_bars: 8, pending_order: { side: "LONG", qty: pl.data?.accepted_qty ?? 0.5, limit: L.limit, stop: L.stop, tp: L.tp, score: 2, confluence: ["FVG", "OB"], placed_at: closeOf("ALPHA-01", sL - 1) } }) });

  // ---- ALPHA-04 BTC 5m: a pending SHORT at a recorded high (stays pending: the pending SHORT chart) ------------------
  const k4 = C("ALPHA-04", -3);
  const S4 = { limit: r1(k4.h + 40), stop: r1(k4.h + 140), tp: r1(k4.h - 260) };
  const p4 = await order("ALPHA-04", "PLACE_LIMIT", { order_id: "DEMO-ALPHA-04-PLACE_SHORT-1", side: "SHORT", limit: S4.limit, stop: S4.stop, tp: S4.tp, qty: 0.0008, placed_at: closeOf("ALPHA-04", -1), expires_at: iso(Date.now() + 6 * 3600_000) });
  log.push({ step: "ALPHA-04 pending SHORT", code: p4.code, ...S4, accepted_qty: p4.data?.accepted_qty });
  await report("ALPHA-04", { strategy_state: st({ direction: "SHORT", setup_bars: 3, pending_order: { side: "SHORT", qty: p4.data?.accepted_qty ?? 0.0008, limit: S4.limit, stop: S4.stop, tp: S4.tp, score: 1, confluence: ["RB"], placed_at: closeOf("ALPHA-04", -1) } }) });

  const shots = [];
  const snap = (name, path, phase, actions = null) => shots.push({ name, path, phase, actions });
  snap("01-bots-grouped", "/bots", 0);
  snap("02-pending-long-chart", "/bots/ALPHA-01/chart", 0, "fit");
  snap("03-pending-short-chart", "/bots/ALPHA-04/chart", 0, "fit");
  snap("04-trades-pending", "/trades", 0, "tab:Pending");

  const phases = [
    async () => { // ALPHA-01 fills at its limit on the recorded candle; stop to break-even
      const f = await order("ALPHA-01", "OPEN_LONG", { order_id: "DEMO-ALPHA-01-OPEN_LONG-1", pending_order_id: "DEMO-ALPHA-01-PLACE_LONG-1", qty: 0.5, stop: L.stop, tp: L.tp,
        plan: planOf("LONG", L, "solusd-1m", "0932a1a0cfac03f9", closeOf("ALPHA-01", sL - 1), ["FVG", "OB"]),
        fill: { price: L.limit, candle: (({ _t, ...k }) => k)(C("ALPHA-01", sL)) } });
      log.push({ step: "ALPHA-01 LONG filled at its limit", code: f.code, price: f.data?.price, qty: f.data?.qty, fee: f.data?.fee_usd, source: f.data?.price_source });
      await report("ALPHA-01", { position: { side: "LONG", qty: f.data?.qty, entry: L.limit, stop: L.limit, tp2: L.tp }, strategy_state: st({ direction: "LONG", current_stop: L.limit, break_even_done: true }) });
    },
    async () => { // ALPHA-01 target reached on a later recorded high; ALPHA-03 SHORT at a recorded high, stopped out
      const k = after[tpIdx];
      const c = await order("ALPHA-01", "CLOSE", { order_id: "DEMO-ALPHA-01-CLOSE-1", entry_order_id: "DEMO-ALPHA-01-OPEN_LONG-1",
        fill: { price: L.tp, kind: "TP", candle: { t: iso(k.t), o: k.o, h: k.h, l: k.l, c: k.c } },
        exit: { v: 1, kind: "TP", result: "TP2", strategy_exit: L.tp, initial_stop: L.stop, stop_at_exit: L.limit, tp2: L.tp, stop_history: [{ at: iso(k.t), stop: L.limit, reason: "BREAK_EVEN" }] } });
      log.push({ step: "ALPHA-01 take profit", code: c.code, gross: c.data?.gross_usd, fees: c.data?.fees_usd, net: c.data?.net_usd, swept: c.data?.swept_to_main_usd });
      await report("ALPHA-01", { strategy_state: st({}) });
      const b3 = candles("ALPHA-03"); const i3 = b3.length - 60; const k3 = b3[i3];
      const later = b3.slice(i3 + 1, i3 + 30); const hiIdx = later.reduce((bi, x, i) => (x.h > later[bi].h ? i : bi), 0);
      const S3 = { limit: k3.h, stop: later[hiIdx].h > k3.h ? later[hiIdx].h : r1(k3.h + 20), tp: r1(k3.h - 300) };
      await order("ALPHA-03", "PLACE_LIMIT", { order_id: "DEMO-ALPHA-03-PLACE_SHORT-1", side: "SHORT", limit: S3.limit, stop: S3.stop, tp: S3.tp, qty: 0.0008, placed_at: iso(k3.t) }); // placed at the close of the candle before k3 (= k3's open)
      const o3 = await order("ALPHA-03", "OPEN_SHORT", { order_id: "DEMO-ALPHA-03-OPEN_SHORT-1", pending_order_id: "DEMO-ALPHA-03-PLACE_SHORT-1", qty: 0.0008, stop: S3.stop, tp: S3.tp,
        plan: planOf("SHORT", S3, "btcusd-1m", "d828caa44611ad73", iso(k3.t), ["RB"]),
        fill: { price: S3.limit, candle: { t: iso(k3.t), o: k3.o, h: k3.h, l: k3.l, c: k3.c } } });
      const ks = later[hiIdx];
      const x3 = await order("ALPHA-03", "CLOSE", { order_id: "DEMO-ALPHA-03-CLOSE-1", entry_order_id: "DEMO-ALPHA-03-OPEN_SHORT-1", fill: { price: S3.stop, kind: "SL", candle: { t: iso(ks.t), o: ks.o, h: ks.h, l: ks.l, c: ks.c } },
        exit: { v: 1, kind: "SL", result: "SL", strategy_exit: S3.stop, initial_stop: S3.stop, stop_at_exit: S3.stop, tp2: S3.tp, stop_history: [] } });
      log.push({ step: "ALPHA-03 SHORT stopped out", open: o3.code, price: o3.data?.price, close: x3.code, net: x3.data?.net_usd, swept: x3.data?.swept_to_main_usd });
      await report("ALPHA-03", { strategy_state: st({}) });
    },
  ];
  snap("05-open-long-chart", "/bots/ALPHA-01/chart", 1, "fit");
  snap("06-home", "/", 2);
  snap("07-trades-completed", "/trades", 2, "tab:Completed");
  snap("08-completed-long-chart", "/bots/ALPHA-01/chart?ledger=bot&trade=DEMO-ALPHA-01-OPEN_LONG-1", 2, "fit");
  snap("09-completed-short-chart", "/bots/ALPHA-03/chart?ledger=bot&trade=DEMO-ALPHA-03-OPEN_SHORT-1", 2, "fit");
  snap("10-short-trade-proof", "/bots/trade/DEMO-ALPHA-03-OPEN_SHORT-1", 2);
  snap("11-trades-rejected-cancelled", "/trades", 2, "tab:Rejected");
  snap("12-performance", "/performance", 2);
  snap("13-activity", "/activity", 2);
  snap("14-settings", "/settings", 2);
  snap("15-settings-advanced-open", "/settings", 2, "folds");
  snap("16-research", "/research", 2);
  snap("17-bot-details-open", "/bots", 2, "details");

  // ---------------------------------------------------------------- Chrome over CDP
  const exe = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find((p) => p && existsSync(p));
  chrome = spawn(exe, ["--headless=new", "--remote-debugging-port=9351", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let target; for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch("http://127.0.0.1:9351/json/list")).json()).find((t) => t.type === "page"); } catch { /* starting */ } if (!target) await sleep(500); }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = (expression) => cdp("Runtime.evaluate", { expression, returnByValue: true }).then((r) => r.result?.result?.value);
  await cdp("Network.enable");
  await cdp("Network.setCookie", { name: "at_session", value: cookie.split("=").slice(1).join("="), domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" });
  mkdirSync(OUT, { recursive: true });
  const results = [];
  const shoot = async (s, width, scheme) => {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 874, deviceScaleFactor: 1, mobile: true });
    await cdp("Page.navigate", { url: `${base}${s.path}` }); await sleep(3500);
    const click = (sel, text) => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`);
    if (s.actions === "fit") { await click("button", "Fit trade levels"); await sleep(800); }
    if (s.actions?.startsWith("tab:")) { await click("button[role=tab]", s.actions.slice(4)); await sleep(1200); }
    if (s.actions === "folds") { await evaluate(`document.querySelectorAll("details.sg-fold").forEach((d) => d.open = true)`); await sleep(400); }
    if (s.actions === "details") { await evaluate(`document.querySelectorAll("details.bot-details").forEach((d) => d.open = true)`); await sleep(400); }
    const m = JSON.parse(await evaluate(`JSON.stringify({ sw: document.documentElement.scrollWidth, iw: innerWidth, h: document.documentElement.scrollHeight })`));
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: Math.min(Math.max(874, m.h), 7000), deviceScaleFactor: 1, mobile: true }); await sleep(500);
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    const file = `DEMO-${s.name}-${width}-${scheme}.png`;
    writeFileSync(join(OUT, file), Buffer.from(shot.result.data, "base64"));
    results.push({ file, path: s.path, width, scheme, horizontal_overflow: m.sw > m.iw, scroll_width: m.sw });
  };
  let phase = 0;
  for (const s of shots) {
    while (phase < s.phase) { await phases[phase](); phase += 1; await sleep(1500); }
    for (const width of WIDTHS) for (const scheme of ["light", "dark"]) await shoot(s, width, scheme);
  }
  writeFileSync(join(OUT, "INDEX.json"), JSON.stringify({
    label: "DEMO / HISTORICAL REPLAY — local Worker, fresh D1 (schema 7), DEMO orders at recorded Kraken prices (timestamps shifted to now). NOT production; nothing was sent to production.",
    generated_at: new Date().toISOString(), widths: WIDTHS, lifecycle: log, screenshots: results }, null, 1));
  console.log(JSON.stringify({ lifecycle: log, shots: results.length, overflow: results.filter((r) => r.horizontal_overflow).map((r) => r.file) }, null, 1));
  ws.close();
} finally {
  try { chrome?.kill(); } catch { /* gone */ }
  killWorker(); stub.close();
  for (const d of [persist, profile]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
}

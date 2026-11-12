// Mobile screenshots of the new pages (402 px wide, light and dark) from a LOCAL TEST Worker — NOT production data.
//   npm --prefix ../frontend run build && node tools/mobile-screenshots.mjs --out ../docs/screenshots/2026-11-12
// The local Worker (wrangler dev, fresh D1, all migrations) serves the built dashboard. It is seeded only through the
// Worker's own routes with TEST orders; prices come from a local stub that replays RECORDED Kraken 1m candles
// (engine/data, real timestamps) — every screenshot file name starts with "LOCAL-TEST". Chrome is driven headless over
// the DevTools protocol (Node's built-in WebSocket). Secrets are random per run and never printed. Each page is also
// checked for horizontal overflow at 402 px.

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
const OUT = arg("out", join(DIR, "..", "docs", "screenshots", "2026-11-12"));
const WIN = process.platform === "win32";
const PORT = 8861, base = `http://127.0.0.1:${PORT}`;
const sec = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = sec(), DASHBOARD_PASSPHRASE = sec(), ADMIN_SECRET = sec();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- recorded Kraken candles behind a local stub (Ticker = the last recorded close; OHLC = recorded candles)
const rec = (f) => JSON.parse(readFileSync(join(DIR, "..", "engine", "data", f), "utf8")).candles;
const SERIES = { SOLUSD: rec("SOLUSD-1m-14d.json").slice(-600), XBTUSD: rec("BTCUSD-1m-11d.json").slice(-600) };
const agg = (cs, m) => { const out = []; for (const k of cs) { const t = Math.floor(k.t / (m * 60000)) * m * 60000; const l = out.at(-1); if (l && l.t === t) { l.h = Math.max(l.h, k.h); l.l = Math.min(l.l, k.l); l.c = k.c; l.v += k.v; } else out.push({ ...k, t }); } return out; };
const KEY = { SOLUSD: "SOLUSD", XBTUSD: "XXBTZUSD" };
const stub = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const pairs = (u.searchParams.get("pair") ?? "").split(",");
  if (u.pathname === "/0/public/Ticker") {
    const result = {}; for (const p of pairs) if (SERIES[p]) result[KEY[p]] = { c: [String(SERIES[p].at(-1).c), "1.0"] };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result })); return;
  }
  if (u.pathname === "/0/public/OHLC" && SERIES[pairs[0]]) {
    const cs = agg(SERIES[pairs[0]], Number(u.searchParams.get("interval") ?? 1));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result: { [KEY[pairs[0]]]: cs.map((k) => [k.t / 1000, k.o, k.h, k.l, k.c, k.c, k.v, 1]), last: cs.at(-1).t / 1000 } })); return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const persist = mkdtempSync(join(tmpdir(), "alpha-shots-"));
const wrangler = (a) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...a], { cwd: DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 120000 });
wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
{ const d = join(persist, "v3", "d1", "miniflare-D1DatabaseObject"); const db = new DatabaseSync(join(d, readdirSync(d).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")));
  db.exec(`UPDATE bots SET status = 'ACTIVE' WHERE bot_id IN ('ALPHA-01', 'ALPHA-03', 'ALPHA-04')`); db.close(); } // LOCAL TEST activation only
const wargs = ["wrangler", "dev", "--local", "--port", String(PORT), "--inspector-port", String(PORT + 600), "--ip", "127.0.0.1", "--persist-to", persist];
for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: STUB, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) wargs.push("--var", `${k}:${v}`);
const worker = spawn(WIN ? "npx.cmd" : "npx", wargs, { cwd: DIR, stdio: "ignore", shell: WIN, detached: !WIN });
let chrome = null;
const profile = mkdtempSync(join(tmpdir(), "alpha-chrome-"));
try {
  for (const end = Date.now() + 120000; Date.now() < end; await sleep(500)) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  const cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ request_id: sec(), ...body, passphrase: DASHBOARD_PASSPHRASE }) }).then((r) => r.json());
  const SYM = { "ALPHA-01": "SOLUSD", "ALPHA-03": "BTCUSD", "ALPHA-04": "BTCUSD" }, TF = { "ALPHA-01": "1", "ALPHA-03": "1", "ALPHA-04": "5" };
  let n = 0;
  const order = (bot, action, o = {}) => fetch(`${base}/webhook/bot-order`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: WEBHOOK_SECRET, bot_id: bot, order_id: o.id ?? `ENG-${bot}-${SYM[bot]}-${TF[bot]}-SHOT${++n}-${action}`, action, symbol: SYM[bot], timeframe: TF[bot], stop: o.stop ?? null, tp: o.tp ?? null, risk_usd: 10, qty: o.qty }) }).then((r) => r.json());
  const setPx = (p, v) => { SERIES[p] = [...SERIES[p].slice(0, -1), { ...SERIES[p].at(-1), c: v }]; };
  const sol = SERIES.SOLUSD.at(-1).c, btc = SERIES.XBTUSD.at(-1).c;
  await act("fund", { action: "deposit", amount_usd: 1000 });
  await act("allocate", { group: "SOLANA", amount_usd: 200 });
  await act("allocate", { group: "BITCOIN", amount_usd: 200 });
  // ALPHA-01: four closed TEST trades (two wins, two losses), LONG and SHORT
  const moves = [["OPEN_LONG", 1.004], ["OPEN_SHORT", 1.003], ["OPEN_LONG", 0.997], ["OPEN_SHORT", 0.996]];
  let firstTrade = null;
  for (const [a, f] of moves) {
    setPx("SOLUSD", sol);
    const r = await order("ALPHA-01", a, { qty: 0.5, stop: +(sol * (a === "OPEN_LONG" ? 0.997 : 1.003)).toFixed(2), tp: +(sol * (a === "OPEN_LONG" ? 1.006 : 0.994)).toFixed(2) });
    firstTrade ??= r.data?.trade_id;
    setPx("SOLUSD", +(sol * f).toFixed(2));
    await order("ALPHA-01", "CLOSE");
  }
  setPx("SOLUSD", sol);
  // ALPHA-03: an open simulated SHORT; ALPHA-04: an open LONG
  await order("ALPHA-03", "OPEN_SHORT", { qty: 0.0005, stop: +(btc * 1.004).toFixed(1), tp: +(btc * 0.99).toFixed(1) });
  await order("ALPHA-04", "OPEN_LONG", { qty: 0.0005, stop: +(btc * 0.995).toFixed(1), tp: +(btc * 1.012).toFixed(1) });
  // engine reports (TEST): ALPHA-01 has a pending limit order; ALPHA-03 moved its stop to break-even
  const lastT = new Date(SERIES.SOLUSD.at(-1).t + 60000).toISOString();
  const report = (botId, symbol, timeframe, extra) => fetch(`${base}/webhook/engine-status`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: WEBHOOK_SECRET, status: { engine: "alpha-engine", symbol, timeframe, bot_id: botId, status_text: "LOCAL TEST report", last_candle_time: lastT, last_candle_close: symbol === "SOLUSD" ? sol : btc, ...extra } }) });
  const st = (o) => ({ direction: "LONG", leg_start: +(sol * 0.99).toFixed(2), leg_end: +(sol * 1.01).toFixed(2), setup_bars: 4, max_age_bars: 50, pending_order: null, current_stop: null, break_even_done: false, trailing: false, ...o });
  await report("ALPHA-01", "SOLUSD", "1m", { strategy_state: st({}) });
  await report("ALPHA-01", "SOLUSD", "1m", { strategy_state: st({ pending_order: { side: "LONG", qty: 0.5, limit: +(sol * 0.996).toFixed(2), stop: +(sol * 0.99).toFixed(2), tp: +(sol * 1.008).toFixed(2) } }) });
  const pos3 = { side: "SHORT", qty: 0.0005, entry: btc, stop: +(btc * 1.004).toFixed(1), tp2: +(btc * 0.99).toFixed(1) };
  await report("ALPHA-03", "BTCUSD", "1m", { position: pos3, strategy_state: { ...st({ direction: "SHORT" }), current_stop: pos3.stop } });
  await report("ALPHA-03", "BTCUSD", "1m", { position: pos3, strategy_state: { ...st({ direction: "SHORT" }), current_stop: btc, break_even_done: true } });
  await report("ALPHA-04", "BTCUSD", "5m", { strategy_state: st({ direction: null }) });
  await sleep(1500);

  // ---- headless Chrome over CDP
  const exe = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
  chrome = spawn(exe, ["--headless=new", "--remote-debugging-port=9339", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch("http://127.0.0.1:9339/json/list")).json()).find((t) => t.type === "page"); } catch { /* starting */ } if (!target) await sleep(500); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await cdp("Network.enable");
  await cdp("Network.setCookie", { name: "at_session", value: cookie.split("=").slice(1).join("="), domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" });
  mkdirSync(OUT, { recursive: true });
  const pages = [["home", "/"], ["bots", "/bots"], ["bot-chart-ALPHA-01", "/bots/ALPHA-01/chart"], ["trades-bot-ALPHA-01", "/trades?bot=ALPHA-01"],
    ["trades-signal", `/trades?signal=${encodeURIComponent(firstTrade)}`], ["performance-bot-ALPHA-01", "/performance?bot=ALPHA-01"], ["bot-trade-proof", `/bots/trade/${encodeURIComponent(firstTrade)}`],
    ["activity", "/activity"], ["settings-notifications", "/settings"], ["assistant", "/"]];
  const results = [];
  for (const scheme of ["light", "dark"]) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    for (const [name, path] of pages) {
      await cdp("Emulation.setDeviceMetricsOverride", { width: 402, height: 874, deviceScaleFactor: 1, mobile: true });
      await cdp("Page.navigate", { url: `${base}${path}` });
      await sleep(3500);
      if (name === "assistant") {
        await cdp("Runtime.evaluate", { expression: `document.querySelector('.asst-fab')?.click()` }); await sleep(800);
        await cdp("Runtime.evaluate", { expression: `[...document.querySelectorAll('.asst-sugg button')][0]?.click()` }); await sleep(800);
      }
      const ov = (await cdp("Runtime.evaluate", { expression: `JSON.stringify({ sw: document.documentElement.scrollWidth, iw: innerWidth, h: document.documentElement.scrollHeight, theme: document.documentElement.getAttribute('data-theme') })`, returnByValue: true })).result.result.value;
      const m = JSON.parse(ov);
      const h = Math.min(Math.max(874, m.h), 6000);
      await cdp("Emulation.setDeviceMetricsOverride", { width: 402, height: h, deviceScaleFactor: 1, mobile: true });
      await sleep(400);
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      const file = `LOCAL-TEST-${name}-${scheme}.png`;
      writeFileSync(join(OUT, file), Buffer.from(shot.result.data, "base64"));
      results.push({ file, path: path.replace(/signal=[^&]+/, "signal=<first ALPHA-01 trade>").replace(/trade\/[^?]+/, "trade/<first ALPHA-01 trade>"), theme: m.theme, horizontal_overflow: m.sw > m.iw, page_height: m.h });
    }
  }
  writeFileSync(join(OUT, "INDEX.json"), JSON.stringify({ label: "LOCAL TEST screenshots: local Worker, fresh D1, TEST orders, recorded Kraken candles (real timestamps) via a local stub. NOT production data.", viewport: "402 px", generated_at: new Date().toISOString(), screenshots: results }, null, 1));
  console.log(JSON.stringify(results.map((r) => [r.file, r.horizontal_overflow, r.theme])));
  ws.close();
} finally {
  try { chrome?.kill(); } catch { /* gone */ }
  try { if (WIN) execFileSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-worker.pid); } catch { /* gone */ }
  stub.close();
  for (const d of [persist, profile]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* locked on Windows */ } }
}

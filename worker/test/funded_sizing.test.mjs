// Universal position sizing, end to end (docs/UNIVERSAL-POSITION-SIZING.md): the real engine with the FUNDED DEFAULT
// (percent of equity, max $10 risk; no ENGINE_SIZING set) against the real Worker on `wrangler dev --local`, for PAPER
// balances of $10, $25, $50, $100, $500, $1,000 and $5,000. Real Kraken SOLUSD 5m candles from the engine fixture.
//   * a qualifying long enters and exits in the ALPHA PAPER ledger; cost within the wallet; Kraken minimum met
//   * no short is sent, nothing is refused, no exit without an accepted entry
//   * a restart in the middle of the trade resumes it: no duplicate signal, ledger check OK
//   * the Strategy Mirror (on in the same engine) keeps the fixed $10 risk, whatever the funded balance
// Isolated: ports 8821-8827, own persist dirs, Kraken quotes from the committed fixture on 127.0.0.1.
//   node --test test/funded_sizing.test.mjs

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { EngineRunner } from "../../engine/src/runner.mjs";
import { loadConfig } from "../../engine/src/config.mjs";
import { runBacktest } from "../../engine/src/cli/backtest.mjs";
import { startKrakenStub } from "./lib/kraken-stub.mjs";

const KRAKEN = await startKrakenStub();
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_DIR = join(WORKER_DIR, "..", "engine");
const WIN = process.platform === "win32";
const secret = () => randomBytes(24).toString("base64url");
const WEBHOOK_SECRET = secret(), DASHBOARD_PASSPHRASE = secret(), ADMIN_SECRET = secret();
const CANDLES = JSON.parse(readFileSync(join(ENGINE_DIR, "test", "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;
const STEP = 300_000;
// As in engine_sync.test.mjs: the fixture's LONG setups exist with the strict pivot rule (ALPHA PAPER is long-only).
const PIVOTS = { left: "strict", right: "strict" };
const FIRST = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5, pivotTies: PIVOTS }).events.find((e) => e.type === "ENTRY_FILL" || e.type === "EXIT_FILL").bar;
const wrangler = (args) => execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, timeout: 90000 });
const temps = [], workers = [];
after(async () => {
  for (const w of workers) { try { if (WIN) execFileSync("taskkill", ["/PID", String(w.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-w.pid); } catch { /* gone */ } }
  await KRAKEN.close();
  for (const t of temps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* locked on Windows */ } }
});

async function environment(port, balance) {
  const persist = mkdtempSync(join(tmpdir(), "alpha-sizing-"));
  const dataDir = mkdtempSync(join(tmpdir(), "alpha-sizing-state-"));
  temps.push(persist, dataDir);
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  const args = ["wrangler", "dev", "--local", "--port", String(port), "--inspector-port", String(port + 600), "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries({ WEBHOOK_SECRET, DASHBOARD_PASSPHRASE, ADMIN_SECRET, KRAKEN_API_BASE: KRAKEN.base, ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none" })) args.push("--var", `${k}:${v}`);
  const w = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  workers.push(w);
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 90000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const lr = await fetch(`${base}/auth/login`, { method: "POST", headers: { "X-Alpha-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
  const cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session="));
  const act = (kind, body) => fetch(`${base}/api/paper/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Alpha-Terminal": "1", Cookie: cookie }, body: JSON.stringify({ ...body, passphrase: DASHBOARD_PASSPHRASE, request_id: secret() }) }).then((r) => r.json());
  await act("fund", { action: "deposit", amount_usd: balance });
  await act("transfer", { from: "MAIN", to: "SOLUSD", amount_usd: balance });
  const sql = (q) => {
    const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
    const db = new DatabaseSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")));
    try { return db.prepare(q).all().map((r) => ({ ...r })); } finally { db.close(); }
  };
  // The FUNDED DEFAULT: no ENGINE_SIZING → percent of equity, max risk = the strategy's risk setting ($10).
  const cfg = { ...loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m", ENGINE_SYNC: "on", ALPHA_API_BASE: base, ALPHA_WEBHOOK_SECRET: WEBHOOK_SECRET, ENGINE_MIRROR: "on", ENGINE_DATA_DIR: dataDir }, ENGINE_DIR), pivotTies: PIVOTS };
  const clock = { visible: FIRST };
  const sends = [];
  const http = (url, init) => { if (String(url).endsWith("/webhook/dry-run")) sends.push(JSON.parse(init.body).id); return fetch(url, init); };
  // The Worker prices a fill at the live Kraken price when the signal arrives, i.e. right after the candle closed: the
  // stub follows the close of the latest completed candle, as live data would.
  const fetchCandles = async () => { KRAKEN.set("SOLUSD", CANDLES[clock.visible - 1].c); return CANDLES.slice(0, clock.visible); };
  const runner = () => new EngineRunner(cfg, { fetchCandles, http, now: () => CANDLES[clock.visible - 1].t + STEP + 10_000, log: () => {} });
  return { base, cfg, clock, sends, runner, sql, act };
}

const BALANCES = [10, 25, 50, 100, 500, 1000, 5000];
describe("funded PAPER with the default universal sizing: every balance can enter and exit", () => {
  BALANCES.forEach((balance, i) => {
    it(`$${balance}: qualifying long accepted and closed; restart mid-trade; no short, refusal, duplicate or orphan exit; mirror stays $10`, async () => {
      const env = await environment(8821 + i, balance);
      assert.equal(env.cfg.sizing.mode, "percent", "funded default against the ledger");
      let r = env.runner();
      await r.tick(); // warm-up
      let restarted = false;
      while (env.clock.visible < CANDLES.length && !r.state.outbox.some((x) => x.action === "CLOSE" && x.status === "accepted")) {
        env.clock.visible += 1;
        await r.tick();
        if (!restarted && r.state.outbox.some((x) => x.action === "BUY" && x.status === "accepted")) {
          r = env.runner(); // restart in the middle of the trade: same state folder, a new process
          restarted = true;
          await r.tick();
        }
      }
      const buy = r.state.outbox.find((x) => x.action === "BUY" && x.status === "accepted");
      assert.ok(buy, `$${balance}: a long was sized and accepted`);
      assert.ok(restarted, "the restart happened with the trade open");
      const close = r.state.outbox.find((x) => x.action === "CLOSE" && x.entryId === buy.id);
      assert.deepEqual([close?.status, close?.code], ["accepted", "DRY_RUN_ACCEPTED"]);
      assert.ok(!r.state.outbox.some((x) => x.action === "SELL"), "no short is ever sent");
      assert.equal(r.state.outbox.filter((x) => x.status === "rejected").length, 0, "nothing refused");
      assert.ok(r.state.outbox.filter((x) => x.kind === "EXIT").every((x) => x.status !== "accepted" || r.state.outbox.find((e) => e.id === x.entryId)?.status === "accepted"), "exits only for accepted entries");
      assert.equal(new Set(env.sends).size, env.sends.length, "no signal sent twice (restart included)");
      const [fill] = env.sql(`SELECT * FROM paper_fills WHERE kind = 'OPEN'`);
      assert.ok(fill.qty * fill.price <= balance + 1e-6, `ledger cost ${fill.qty * fill.price} within $${balance}`);
      assert.ok(fill.qty >= 0.05, "Kraken minimum");
      assert.equal(Number(buy.qty), fill.qty, "engine and ledger hold the same quantity");
      const sz = r.statusPayload().sizing;
      assert.equal(sz.mode, "percent");
      assert.equal(sz.max_risk_usd, 10);
      const risk = Math.abs(Number(buy.enginePrice) - (r.state.strategy.lastSizing?.stop ?? 0)) * fill.qty;
      assert.ok(Number.isFinite(risk));
      const [trade] = env.sql(`SELECT * FROM trades WHERE source = 'ALPHA_PAPER'`);
      const [sol] = env.sql(`SELECT * FROM portfolio_wallets WHERE wallet = 'SOLUSD'`);
      assert.equal(Number(sol.reserved_micro), 0);
      assert.ok(Math.abs(Number(sol.available_micro) - (balance * 1e6 + Math.round(Number(trade.realized_pnl) * 1e6))) <= 1, "wallet = balance + realized P&L");
      assert.ok(Number(sol.available_micro) >= 0, "never negative");
      // ledger check after the restart
      env.clock.visible = Math.min(env.clock.visible + 1, CANDLES.length);
      await r.tick();
      assert.equal(r.state.ledgerCheck?.status, "OK");
      // Strategy Mirror in the same engine: fixed $10 risk, independent of the funded balance
      const ms = r.mirror.strategy;
      assert.equal(ms.sizing.mode, "fixed");
      assert.equal(ms.inputs.riskUSD, 10);
      const mt = env.sql(`SELECT entry_time, qty, risk_usd FROM mirror_trades ORDER BY seq`);
      assert.ok(mt.length > 0);
      // exactly the fixed-$10 strategy's own quantities on the same candles (the funded balance plays no part)
      const ref = runBacktest({ candles: CANDLES.slice(0, env.clock.visible), symbol: "SOLUSD", intervalMin: 5, inputs: env.cfg.inputs, pivotTies: PIVOTS }).trades;
      for (const t of mt) {
        assert.equal(t.risk_usd, 10);
        const twin = ref.find((x) => x.entryTime.replace(".000Z", "Z") === t.entry_time);
        assert.ok(twin, `${t.entry_time} in the fixed-risk backtest`);
        assert.equal(t.qty, twin.qty, "mirror quantity = the fixed $10 strategy's quantity");
      }
    });
  });
});

describe("price movement between the engine's fill and the ledger's live price", () => {
  for (const [label, jump, accepted] of [["+0.3% (inside the 0.5% headroom)", 1.003, true], ["+2% (beyond the headroom)", 1.02, false]]) {
    it(`${label}: ${accepted ? "accepted" : "refused by the Worker; the engine drops the position and never sends its exit"}`, async () => {
      const env = await environment(accepted ? 8828 : 8829, 10);
      const set = KRAKEN.set;
      KRAKEN.set = (pair, price) => set(pair, price * jump); // the ledger's live price sits above the candle close
      try {
        const r = env.runner();
        await r.tick();
        while (env.clock.visible < CANDLES.length && !r.state.outbox.some((x) => x.action === "BUY" && x.status !== "pending")) { env.clock.visible += 1; await r.tick(); }
        const buy = r.state.outbox.find((x) => x.action === "BUY");
        assert.ok(buy, "a long setup was sized");
        if (accepted) {
          assert.equal(buy.status, "accepted");
          const [fill] = env.sql(`SELECT qty, price FROM paper_fills WHERE kind = 'OPEN'`);
          assert.ok(fill.qty * fill.price <= 10 + 1e-6, "still within the $10 wallet thanks to the headroom");
        } else {
          assert.deepEqual([buy.status, buy.code, buy.positionDropped], ["rejected", "INSUFFICIENT_PAPER_CAPITAL", true]);
          for (let i = 0; i < 60 && env.clock.visible < CANDLES.length; i++) { env.clock.visible += 1; await r.tick(); }
          assert.ok(!r.state.outbox.some((x) => x.kind === "EXIT" && x.entryId === buy.id && x.status === "accepted"), "no exit for the refused entry");
          assert.equal(env.sql(`SELECT COUNT(*) AS n FROM paper_fills`)[0].n, 0, "nothing reached the ledger");
          assert.equal(env.sql(`SELECT COUNT(*) AS n FROM alerts WHERE action = 'close' AND status = 'rejected'`)[0].n, 0, "no orphan CLOSE reached the ledger");
          const [sol] = env.sql(`SELECT available_micro, reserved_micro FROM portfolio_wallets WHERE wallet = 'SOLUSD'`);
          assert.ok(Number(sol.available_micro) >= 0 && Number(sol.reserved_micro) >= 0, "never negative");
        }
      } finally { KRAKEN.set = set; }
    });
  }
});

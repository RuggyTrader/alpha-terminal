// S3 research-only shadow test runner (worker/src/trial/s3_runner.ts, migration 0010).
//  * Accelerated replay: the REAL runner, on an isolated SQLite D1, driven day by day through 2022-01 .. 2026-11 of
//    real Coinbase BTC/ETH daily candles (committed fixtures) served through a Kraken-shaped feed, with the clock
//    advanced to each daily close and to the fill a few minutes later.
//  * It must reproduce the research backtest EXACTLY (golden file from engine/src/research/select/alloc.mjs, which the
//    independent implementation engine/test/select-s3-independent.test.mjs reproduces to the cent), and, in the live
//    configuration (lot rounding + Kraken's own minimums), the trial module's replay (s3.ts replaySleeve) exactly.
//  * Plus: alerts at 2 % / 30 % (alerts only), outage handling (no back-dating), data validation, idleness, overlap
//    lock, activation gating and complete isolation from every production / funded PAPER table.
// The minute feed is flat at each day's open (TEST simplification): the first candle after acceptance then opens at the
// daily open, so live fills can be compared with the daily-bar backtest. In live use the fill price is the real
// minute open, recorded next to the daily open (ref_open) as execution evidence.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { d1 } from "./lib/d1-shim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "alpha-s3shadow-"));
const build = (name) => { const out = join(TMP, `${name}.mjs`); buildSync({ entryPoints: [join(HERE, "..", "src", "trial", `${name}.ts`)], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" }); return import(pathToFileURL(out).href); };
const R = await build("s3_runner"), S3 = await build("s3"), REP = await build("report");
const SCHEMA = ["0008_trial.sql", "0010_s3_shadow.sql"].map((f) => readFileSync(join(HERE, "..", "migrations", f), "utf8")).join("\n");
const G = JSON.parse(readFileSync(join(HERE, "fixtures", "s3-golden.json"), "utf8"));
const REAL = { XBTUSD: JSON.parse(readFileSync(join(HERE, "fixtures", "BTC-USD-1d-coinbase.json"), "utf8")).candles, ETHUSD: JSON.parse(readFileSync(join(HERE, "fixtures", "ETH-USD-1d-coinbase.json"), "utf8")).candles };
const PAIR = { BTC: "XBTUSD", ETH: "ETHUSD" };
const DAY = 86_400_000, MIN = 60_000;
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const FROM = Date.parse(G.window[0]), TO = Date.parse(G.window[1]);

/** Kraken-shaped feed over daily candles: completed candles only, the last 720 of each interval. */
function feed(dailyByPair, opts = {}) {
  const calls = [];
  const at = (now) => (pair) => async (interval, since) => {
    calls.push({ pair, interval, since, now });
    if (opts.down?.(now)) return { ok: false, message: "TEST: feed unavailable" };
    const D = dailyByPair[pair];
    if (interval === 1440) return { ok: true, candles: D.filter((k) => k.t + DAY <= now).slice(-720) };
    const step = interval * MIN, end = Math.floor(now / step) * step, from = Math.max(end - 720 * step, since === null ? -Infinity : Math.floor((since - step) / step) * step);
    const out = [];
    for (let t = from; t < end; t += step) { const d = D.find((k) => k.t <= t && t < k.t + DAY); if (d) out.push({ t, o: d.o, h: d.o, l: d.o, c: d.o }); }
    return { ok: true, candles: out };
  };
  return { at, calls };
}
function setup(dailyByPair = REAL, opts = {}) {
  const db = d1(SCHEMA), f = feed(dailyByPair, opts);
  if (!opts.proposed) db.sql(`UPDATE trial_accounts SET status = 'ACTIVE', activated_at = '2026-11-21T00:00:00Z' WHERE account_id = 'TRIAL-S3-SHADOW'`);
  const run = (now, o = opts.runner) => R.runS3Shadow({ DB: db }, now, f.at(now), o);
  return { db, f, run };
}
/** Drive the runner from activation (just after `from`'s previous close) through the close of the day before `to`. */
async function replay(s, from, to, o, skip = () => false) {
  await s.run(from + 30_000, o);
  for (let d = from; d < to; d += DAY) {
    if (skip(d)) continue;
    await s.run(d + DAY + 90_000, o);          // 00:01:30: the close of day d is processed, orders accepted
    await s.run(d + DAY + 3 * MIN + 5_000, o); // 00:03:05: they fill at the first minute candle starting after acceptance
  }
}
const q = (s, sql, ...a) => s.db.sql(sql, ...a);
const executed = (s, asset) => q(s, `SELECT * FROM trial_alloc_orders WHERE asset = ? AND status IN ('FILLED', 'SKIPPED_MIN') ORDER BY signal_candle_t`, asset);
const events = (s, kind) => q(s, `SELECT * FROM trial_events WHERE account_id = 'TRIAL-S3-SHADOW'${kind ? " AND kind = ?" : ""} ORDER BY id`, ...(kind ? [kind] : [])).map((e) => ({ ...e, d: JSON.parse(e.detail_json) }));

describe("S3 shadow runner: accelerated replay on real BTC/ETH candles 2022-01 .. 2026-11", () => {
  it("research configuration (fixed minimums, no rounding): reproduces the research backtest EXACTLY (orders, fills, skips, daily equity, fees, final)", async () => {
    const s = setup();
    await replay(s, FROM, TO, { minUsd: { BTC: G.sleeves.BTC.minUsd, ETH: G.sleeves.ETH.minUsd }, round: false });
    for (const asset of ["BTC", "ETH"]) {
      const g = G.sleeves[asset], o = executed(s, asset);
      assert.equal(o.length, g.orders.length, `${asset} order count`);
      g.orders.forEach((e, i) => {
        const u = o[i];
        assert.equal(Math.floor(u.fill_candle_t / DAY) * DAY, e.t, `${asset} order ${i} fill day`);
        assert.equal(u.side, e.side, `${asset} order ${i} side`);
        assert.ok(near(u.qty, e.qty) && near(u.notional_usd, e.notional), `${asset} order ${i} qty/notional`);
        assert.equal(u.status === "SKIPPED_MIN", e.skipped, `${asset} order ${i} skipped`);
        assert.ok(u.fill_candle_t >= Date.parse(u.accepted_at), "never filled before acceptance");
      });
      const days = q(s, `SELECT day_t, equity_usd FROM trial_alloc_days WHERE asset = ? ORDER BY day_t`, asset);
      assert.equal(days.length, g.curve.length, `${asset} days`);
      g.curve.forEach(([t, eq], i) => { assert.equal(days[i].day_t, t); assert.ok(near(days[i].equity_usd, eq), `${asset} equity ${new Date(t).toISOString().slice(0, 10)}`); });
      const fees = q(s, `SELECT SUM(fee_usd) f FROM trial_alloc_orders WHERE asset = ? AND status = 'FILLED'`, asset)[0].f;
      assert.ok(near(fees, g.fees, 1e-8), `${asset} fees ${fees} vs ${g.fees}`);
      assert.ok(near(days.at(-1).equity_usd, g.final), `${asset} final`);
    }
    // the account: equity = BTC + ETH sleeves; drawdown and returns from the daily marks
    const eq = q(s, `SELECT * FROM trial_alloc_equity ORDER BY day_t`);
    let peak = 0, maxDd = 0;
    eq.forEach((e, i) => {
      const sum = G.sleeves.BTC.curve[i][1] + G.sleeves.ETH.curve[i][1];
      assert.ok(near(e.equity_usd, sum)); peak = Math.max(peak, sum); maxDd = Math.max(maxDd, (1 - sum / peak) * 100);
      assert.ok(near(e.peak_usd, peak) && near(e.drawdown_pct, (1 - sum / peak) * 100, 1e-7));
      if (i) assert.ok(near(e.return_pct, (sum / eq[i - 1].equity_usd - 1) * 100, 1e-7));
    });
    assert.ok(maxDd > 2 && maxDd < 30, `max drawdown ${maxDd.toFixed(2)} %`);
    assert.ok(events(s, "DRAWDOWN_ALERT").some((e) => e.d.level_pct === 2), "a 2 % drawdown alert");
    assert.ok(!events(s, "DRAWDOWN_ALERT").some((e) => e.d.level_pct === 30), "no 30 % alert (max drawdown below 30 %)");
    assert.equal(q(s, `SELECT status FROM trial_accounts WHERE account_id = 'TRIAL-S3-SHADOW'`)[0].status, "ACTIVE", "alerts never stop the simulation");
  });

  it("live configuration (Kraken lot rounding 1e-8 + Kraken's own minimums): identical to the trial module's replay; within cents of the research backtest", async () => {
    const s = setup();
    await replay(s, FROM, TO);
    const summary = {};
    for (const asset of ["BTC", "ETH"]) {
      const ref = S3.replaySleeve(REAL[PAIR[asset]], asset, { fromMs: FROM, toMs: TO, capital: 50, minUsd: null, round: true });
      const o = executed(s, asset);
      assert.equal(o.length, ref.orders.length, `${asset} order count`);
      ref.orders.forEach((e, i) => {
        assert.equal(Math.floor(o[i].fill_candle_t / DAY) * DAY, e.t); assert.equal(o[i].side, e.side);
        assert.ok(near(o[i].qty, e.qty) && near(o[i].notional_usd, e.notional)); assert.equal(o[i].status === "SKIPPED_MIN", e.skipped);
        assert.ok(near(o[i].qty / 1e-8, Math.round(o[i].qty / 1e-8), 1e-6), "quantity on Kraken's lot step");
      });
      const days = q(s, `SELECT day_t, equity_usd FROM trial_alloc_days WHERE asset = ? ORDER BY day_t`, asset);
      ref.curve.forEach(([t, eq], i) => assert.ok(days[i].day_t === t && near(days[i].equity_usd, eq)));
      summary[asset] = { final: days.at(-1).equity_usd, research: G.sleeves[asset].final, skipped: o.filter((x) => x.status === "SKIPPED_MIN").length, orders: o.length };
      assert.ok(Math.abs(summary[asset].final - summary[asset].research) < 0.5, `${asset}: live ${summary[asset].final} vs research ${summary[asset].research}`);
    }
    // every recorded order carries its execution evidence
    for (const o of q(s, `SELECT * FROM trial_alloc_orders WHERE status IN ('FILLED', 'SKIPPED_MIN')`)) {
      for (const k of ["side", "fill_candle_t", "fill_interval_min", "ref_open", "fill_price", "qty_raw", "qty", "notional_usd", "min_qty", "min_cost", "recorded_at"]) assert.notEqual(o[k], null, `${o.order_id} ${k}`);
      assert.ok(near(o.fill_price, o.ref_open * (o.side === "BUY" ? 1.0005 : 0.9995)), "slippage 0.05 %");
      if (o.status === "FILLED") assert.ok(near(o.fee_usd, o.notional_usd * 0.002), "fee 0.20 %"); else assert.equal(o.fee_usd, 0);
    }
    const rep = await R.s3ShadowReport(s.db);
    assert.equal(rep.available, true); assert.match(rep.label, /SIMULATED/); assert.match(rep.alerts.note, /NOT an approved trading risk limit/);
    assert.ok(near(rep.equity.equity_usd, Math.round((summary.BTC.final + summary.ETH.final) * 100) / 100, 1e-12));
    assert.equal(rep.orders.skipped_below_minimum, summary.BTC.skipped + summary.ETH.skipped);
    console.log("S3 shadow replay (live configuration):", JSON.stringify({ ...summary, account_final: rep.equity.equity_usd, max_drawdown_pct: rep.equity.max_drawdown_pct, fees_usd: rep.orders.fees_usd }));
  });
});

describe("S3 shadow runner: behaviour", () => {
  it("planOrder floors to Kraken's lot step, never spends more cash than it has, and a full exit sells everything", () => {
    const b = S3.planOrder(50, 0, 0.7, 64_119.3, "BTC", { minUsd: null, round: true });
    assert.equal(b.side, "BUY"); assert.ok(b.qty <= b.qtyRaw && b.qtyRaw - b.qty < 1e-8); assert.ok(near(b.qty * 1e8, Math.round(b.qty * 1e8), 1e-6));
    assert.ok(b.notional + b.fee <= 50);
    const all = S3.planOrder(0.1, 0.00123457, 0, 60_000, "BTC", { minUsd: null, round: true });
    assert.equal(all.fullExit, true); assert.equal(all.qty, 0.00123457); assert.equal(all.ok, true);
    const tiny = S3.planOrder(48, 0.0007, 0.9, 64_000, "BTC", { minUsd: null, round: true }); // re-size of about 0.00006 BTC
    assert.equal(tiny.ok, tiny.qty >= 0.00006 && tiny.notional >= 0.5);
  });

  it("not installed / not activated: does nothing and writes nothing", async () => {
    const s = setup(REAL, { proposed: true });
    assert.deepEqual(await s.run(FROM + DAY + 90_000), { ran: false, reason: "not active" });
    assert.equal(s.db.trace.filter((x) => !/^\s*SELECT/i.test(x)).length, 0);
    const bare = d1(readFileSync(join(HERE, "..", "migrations", "0008_trial.sql"), "utf8"));
    assert.deepEqual(await R.runS3Shadow({ DB: bare }, FROM, async () => ({ ok: false })), { ran: false, reason: "not installed" });
  });

  it("activation starts at the first daily close AFTER activation; between closes with nothing pending a run is read-only", async () => {
    const s = setup();
    await s.run(FROM + 30_000);
    assert.deepEqual(events(s).map((e) => e.kind), ["TRIAL_STARTED"]);
    assert.equal(q(s, `SELECT last_daily_t FROM trial_accounts WHERE account_id = 'TRIAL-S3-SHADOW'`)[0].last_daily_t, FROM - DAY);
    const n = s.db.trace.length;
    const r = await s.run(FROM + 12 * 3600_000);
    assert.equal(r.ran, false); assert.match(r.reason, /idle/);
    assert.equal(s.db.trace.slice(n).filter((x) => !/^\s*SELECT/i.test(x)).length, 0, "no write when idle");
  });

  it("isolation: every statement touches only the S3 shadow tables (never the portfolio, funded PAPER ledgers, bots, mirror or the 0008 trial's rows)", async () => {
    const s = setup();
    await replay(s, FROM, FROM + 120 * DAY);
    const touched = new Set(s.db.trace.flatMap((x) => [...x.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1])));
    assert.deepEqual([...touched].sort(), ["sqlite_master", "trial_accounts", "trial_alloc_days", "trial_alloc_equity", "trial_alloc_orders", "trial_alloc_sleeves", "trial_events"]);
    for (const x of s.db.trace.filter((x) => /trial_accounts|trial_events/.test(x) && !/^\s*SELECT 1 AS x/.test(x))) assert.ok(/account_id = \?|\(account_id,/.test(x), `scoped to the account: ${x.slice(0, 80)}`);
    assert.ok(q(s, `SELECT * FROM trial_events WHERE account_id <> 'TRIAL-S3-SHADOW'`).length === 0);
    assert.equal(q(s, `SELECT status FROM trial_accounts WHERE account_id = 'TRIAL-BTC-MA50'`)[0].status, "PROPOSED", "the 0008 trial is untouched");
  });

  it("overlapping scheduled runs: only one acts (lock)", async () => {
    const s = setup();
    await s.run(FROM + 30_000);
    const [a, b] = await Promise.all([s.run(FROM + DAY + 90_000), s.run(FROM + DAY + 90_000)]);
    assert.equal([a, b].filter((r) => r.ran).length, 1);
    assert.ok([a, b].some((r) => r.reason === "another run is in progress"));
  });

  it("outage: a pending order fills from history at the first candle after acceptance (coarser candles, recorded late); missed closes are recorded as MISSED, never back-dated", async () => {
    const s = setup();
    await replay(s, FROM, TO);
    // find a day whose close created an order, in the live replay, then replay again with an outage right after it
    const first = q(s, `SELECT signal_candle_t t FROM trial_alloc_orders WHERE status = 'FILLED' ORDER BY signal_candle_t LIMIT 1 OFFSET 5`)[0].t;
    const o = setup();
    await replay(o, FROM, first);       // closes up to the day before, all filled
    await o.run(first + DAY + 90_000); // the close is processed, the order accepted
    assert.ok(q(o, `SELECT COUNT(*) n FROM trial_alloc_orders WHERE status = 'PENDING'`)[0].n >= 1);
    // the Worker is down for 4 days; the next run catches up
    for (let k = 0; k < 3; k++) await o.run(first + 5 * DAY + 2 * 3600_000 + k * MIN);
    const late = q(o, `SELECT * FROM trial_alloc_orders WHERE signal_candle_t = ? AND status IN ('FILLED', 'SKIPPED_MIN')`, first);
    assert.ok(late.length >= 1);
    for (const x of late) { assert.equal(x.fill_interval_min, 15); assert.ok(x.fill_candle_t >= Date.parse(x.accepted_at)); assert.ok(x.recorded_late_min > 5); }
    assert.ok(events(o, "FILL_RECORDED_LATE").length >= 1);
    assert.equal(q(o, `SELECT COUNT(*) n FROM trial_alloc_days WHERE day_t > ? AND day_t <= ?`, first, first + 4 * DAY)[0].n, 8, "every missed close is still marked (2 assets x 4 days)");
    for (const x of q(o, `SELECT * FROM trial_alloc_orders WHERE status = 'MISSED'`)) { assert.ok(x.signal_candle_t < first + 4 * DAY); assert.equal(x.fill_price, null); }
    for (const x of q(o, `SELECT * FROM trial_alloc_orders WHERE status = 'FILLED'`)) assert.ok(x.fill_candle_t >= Date.parse(x.accepted_at), "never back-dated");
  });

  it("bad market data: a gap or an unavailable feed makes no decision and is recorded; the next good run continues", async () => {
    const gappy = { XBTUSD: REAL.XBTUSD.filter((k) => k.t !== FROM + 3 * DAY), ETHUSD: REAL.ETHUSD };
    const s = setup(gappy);
    await replay(s, FROM, FROM + 5 * DAY);
    assert.ok(events(s, "DAILY_CANDLE_MISSING").length >= 1 && events(s, "DATA_GAP").length >= 1, "the missing candle, then the gap in the history, are recorded");
    assert.equal(q(s, `SELECT COUNT(*) n FROM trial_alloc_days WHERE day_t >= ?`, FROM + 3 * DAY)[0].n, 0, "no decision at or after the missing day");
    assert.equal(q(s, `SELECT MAX(day_t) m FROM trial_alloc_days`)[0].m, FROM + 2 * DAY, "closes before it were processed normally");
    let down = true;
    const u = setup(REAL, { down: () => down });
    await u.run(FROM + 30_000);
    assert.ok(events(u, "MARKET_DATA_UNAVAILABLE").length >= 1);
    down = false; await u.run(FROM + 60_000);
    assert.deepEqual(events(u, "TRIAL_STARTED").length, 1);
  });

  it("drawdown alerts at 2 % and 30 % are recorded once per crossing and reported, and the simulation CONTINUES (30 % is not a trading limit)", async () => {
    // TEST market: 260 calm rising days (S3 fully invested), then a one-day 45 % fall, then calm again
    const mk = (p0) => { const out = []; let c = p0; for (let i = 0; i < 300; i++) { const o = c; c = i === 262 ? o * 0.55 : o * (1 + 0.003 * (i % 2 ? 1 : -0.2)); out.push({ t: FROM - 260 * DAY + i * DAY, o, h: Math.max(o, c), l: Math.min(o, c), c }); } return out; };
    const s = setup({ XBTUSD: mk(60_000), ETHUSD: mk(2_000) });
    await replay(s, FROM, FROM + 30 * DAY);
    const al = events(s, "DRAWDOWN_ALERT");
    assert.deepEqual(al.map((e) => e.d.level_pct).sort((a, b) => a - b), [2, 30]);
    assert.match(al.find((e) => e.d.level_pct === 30).d.note, /NOT an approved trading risk limit/);
    assert.equal(q(s, `SELECT status FROM trial_accounts WHERE account_id = 'TRIAL-S3-SHADOW'`)[0].status, "ACTIVE");
    const crash = FROM + 2 * DAY;
    assert.ok(q(s, `SELECT COUNT(*) n FROM trial_alloc_days WHERE day_t > ?`, crash)[0].n > 10, "daily processing continues after the alerts");
    const rep = await R.s3ShadowReport(s.db);
    assert.ok(rep.equity.max_drawdown_pct >= 30); assert.equal(rep.events.filter((e) => e.kind === "DRAWDOWN_ALERT").length, 2);
  });

  it("one-time owner activation accepts the S3 account and rejects unknown accounts", async () => {
    const s = setup(REAL, { proposed: true });
    assert.equal((await REP.activateTrial(s.db, "PORTFOLIO")).code, "UNKNOWN_TRIAL");
    const r = await REP.activateTrial(s.db, "TRIAL-S3-SHADOW");
    assert.equal(r.status, "ACTIVE");
    assert.equal(q(s, `SELECT status FROM trial_accounts WHERE account_id = 'TRIAL-BTC-MA50'`)[0].status, "PROPOSED");
    assert.equal((await REP.activateTrial(s.db, "TRIAL-S3-SHADOW")).duplicate, true);
  });

  it("the migration's frozen settings match the module's PARAMS", () => {
    const db = d1(SCHEMA), p = JSON.parse(db.sql(`SELECT params_json FROM trial_accounts WHERE account_id = 'TRIAL-S3-SHADOW'`)[0].params_json), P = S3.PARAMS;
    for (const k of ["strategy", "version", "timeframe", "sma", "volDays", "volTarget", "band", "feePct", "slipPct", "startEquityUsd", "long", "short", "leverage"]) assert.equal(p[k], P[k], k);
    for (const a of ["BTC", "ETH"]) for (const k of ["pair", "minQty", "minCost", "qtyStep"]) assert.equal(p.assets[a][k], P.assets[a][k], `${a}.${k}`);
  });
});

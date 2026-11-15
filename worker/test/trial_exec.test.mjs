// Candidate B forward trial: execution, stops, outages and isolation (TEST data: synthetic candles, isolated SQLite).
// The runner (worker/src/trial/trial.ts) is driven with a controlled clock and a fake Kraken OHLC feed that, like the
// real API, returns only the last 720 candles of each interval.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { d1 } from "./lib/d1-shim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(mkdtempSync(join(tmpdir(), "alpha-trial-")), "trial.mjs");
buildSync({ entryPoints: [join(HERE, "..", "src", "trial", "trial.ts")], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const T = await import(pathToFileURL(OUT).href);
const SCHEMA = readFileSync(join(HERE, "..", "migrations", "0008_trial.sql"), "utf8");
const DAY = 86_400_000, MIN = 60_000;
const D0 = Date.UTC(2026, 10, 10); // last completed day at activation (TEST)

/** TEST market: 100 rising daily candles ending D0 (close above the 50-day average), then minute candles. */
function market() {
  const daily = [];
  let c = 50_000;
  for (let i = 99; i >= 0; i--) { const o = c; c = o * 1.002; daily.push({ t: D0 - i * DAY, o, h: Math.max(o, c) * 1.03, l: Math.min(o, c) * 0.97, c }); } // TEST: realistic +/-3 % daily range
  const minuteOverride = new Map();
  // A minute inside a recorded day glides from that day's open to its close; after the last day it stays at its close.
  const base = (t) => { const d = daily.find((k) => t >= k.t && t < k.t + DAY); return d ? d.o + (d.c - d.o) * ((t - d.t) / DAY) : daily.at(-1).c; };
  const minute = (t) => minuteOverride.get(t) ?? (() => { const p = base(t) * (1 + 0.0004 * Math.sin(t / 3.7e6)); return { t, o: p, h: p * 1.0003, l: p * 0.9997, c: p }; })();
  const addDay = (mult = 1.002) => { const last = daily.at(-1), o = last.c, cc = o * mult; daily.push({ t: last.t + DAY, o, h: Math.max(o, cc) * 1.03, l: Math.min(o, cc) * 0.97, c: cc }); };
  const agg = (t0, mins) => { const ks = Array.from({ length: mins }, (_, j) => minute(t0 + j * MIN)); return { t: t0, o: ks[0].o, h: Math.max(...ks.map((k) => k.h)), l: Math.min(...ks.map((k) => k.l)), c: ks.at(-1).c }; };
  const calls = [];
  const ohlc = (now) => async (interval, since) => {
    calls.push({ interval, since });
    const step = interval * MIN;
    if (interval === 1440) return { ok: true, candles: daily.filter((k) => k.t + DAY <= now).slice(-720) };
    const end = Math.floor(now / step) * step; // forming candle excluded
    const out = [];
    for (let t = end - 720 * step; t < end; t += step) if (since === null || t + step > since - step) out.push(interval === 1 ? minute(t) : agg(t, interval));
    return { ok: true, candles: out };
  };
  return { daily, minute, minuteOverride, addDay, ohlc, calls };
}
function setup() {
  const db = d1(SCHEMA), m = market();
  db.sql(`UPDATE trial_accounts SET status = 'ACTIVE', activated_at = ? WHERE account_id = 'TRIAL-BTC-MA50'`, new Date(D0 + DAY + 20_000).toISOString());
  const run = (now) => T.runTrial({ DB: db }, now, m.ohlc(now));
  return { db, m, run };
}
const acct = (db) => db.sql(`SELECT * FROM trial_accounts`)[0];
const orders = (db) => db.sql(`SELECT * FROM trial_orders ORDER BY created_at, order_id`);
const positions = (db) => db.sql(`SELECT * FROM trial_positions ORDER BY opened_at`);
const events = (db) => db.sql(`SELECT kind FROM trial_events ORDER BY id`).map((e) => e.kind);

/** Through activation and the first entry: returns the filled position. */
async function toEntry(s) {
  await s.run(D0 + DAY + 30_000); // activation: starts, decides nothing
  s.m.addDay(); // D1 completes above the average
  const t2 = D0 + 2 * DAY;
  await s.run(t2 + 90_000); // 00:01:30: the D1 close creates a market BUY accepted now
  await s.run(t2 + 3 * MIN + 5000); // 00:03:05: the 00:01 candle began before acceptance; 00:02 fills
  return { t2 };
}

describe("Candidate B trial: start, market entry, sizing (TEST)", () => {
  it("activation decides nothing; the first decision is the first daily close after it", async () => {
    const s = setup();
    const r = await s.run(D0 + DAY + 30_000);
    assert.equal(r.ran, true); assert.deepEqual(orders(s.db), []);
    assert.deepEqual(events(s.db), ["TRIAL_STARTED"]); assert.equal(acct(s.db).last_daily_t, D0);
  });

  it("a close above the 50-day average creates a market BUY accepted at submission; it fills at the open of the first candle STARTING after acceptance (never the daily open), plus slippage; 2 % risk; 3 x ATR stop", async () => {
    const s = setup();
    const { t2 } = await toEntry(s);
    const [o] = orders(s.db);
    assert.equal(o.kind, "ENTRY"); assert.equal(o.status, "FILLED");
    assert.equal(o.accepted_at, new Date(t2 + 90_000).toISOString(), "accepted when submitted (00:01:30)");
    assert.equal(o.fill_candle_t, t2 + 2 * MIN, "the 00:00 and 00:01 candles began before acceptance; 00:02 is the first eligible");
    const open = s.m.minute(t2 + 2 * MIN).o;
    assert.ok(Math.abs(o.fill_price - open * 1.0005) < 1e-6, "open + 0.05 % slippage");
    assert.notEqual(o.ref_price, s.m.daily.at(-1).o, "not the daily open");
    const [p] = positions(s.db);
    const atr = o.atr_signal;
    assert.ok(Math.abs(p.initial_stop - (o.fill_price - 3 * atr)) < 1e-6, "protective stop = fill - 3 x ATR(14) of the signal day");
    assert.ok(Math.abs(p.risk_usd - p.qty * (p.entry_price - p.initial_stop)) < 1e-9);
    assert.ok(p.risk_usd <= 2 + 1e-9 && p.risk_usd > 1.99, `risk ${p.risk_usd} = 2 % of $100`);
    assert.ok(p.qty * p.entry_price * 1.002 <= 100, "no leverage");
    assert.equal(acct(s.db).cash_micro, 100_000_000 - p.cost_micro - p.entry_fee_micro);
  });
});

describe("stops: monitored every minute, gap-through conservative, never loosened (TEST)", () => {
  it("a minute candle reaching the stop closes at the stop minus slippage", async () => {
    const s = setup(); const { t2 } = await toEntry(s);
    const p = positions(s.db)[0], tk = t2 + 30 * MIN, px = s.m.minute(tk).o;
    s.m.minuteOverride.set(tk, { t: tk, o: px, h: px, l: p.stop - 5, c: p.stop + 1 });
    await s.run(t2 + 31 * MIN + 5000);
    const q = positions(s.db)[0];
    assert.equal(q.status, "CLOSED"); assert.equal(q.exit_reason, "PROTECTIVE_STOP"); assert.equal(q.exit_candle_t, tk); assert.equal(q.exit_interval_min, 1);
    assert.ok(Math.abs(q.exit_price - p.stop * 0.9995) < 1e-6);
    assert.equal(q.recorded_late_min, 0, "recorded within the minute");
  });
  it("a candle that opens below the stop (gap) fills at its open, not at the stop", async () => {
    const s = setup(); const { t2 } = await toEntry(s);
    const p = positions(s.db)[0], tk = t2 + 40 * MIN, gapOpen = p.stop - 300;
    s.m.minuteOverride.set(tk, { t: tk, o: gapOpen, h: gapOpen + 10, l: gapOpen - 50, c: gapOpen });
    await s.run(t2 + 41 * MIN + 5000);
    const q = positions(s.db)[0];
    assert.ok(Math.abs(q.exit_price - gapOpen * 0.9995) < 1e-6, "worse than the stop");
    assert.ok(q.net_micro < 0);
  });
  it("the trailing stop rises after a higher close and never falls; each raise is recorded", async () => {
    const s = setup(); const { t2 } = await toEntry(s);
    const p0 = positions(s.db)[0];
    s.m.addDay(1.03); // D2 closes 3 % higher
    await s.run(t2 + DAY + 90_000);
    const p1 = positions(s.db)[0];
    assert.ok(p1.stop > p0.stop, "raised"); assert.equal(p1.stop_active_from, t2 + DAY);
    s.m.addDay(0.985); // D3 lower close: a lower trail is ignored
    await s.run(t2 + 2 * DAY + 90_000);
    const p2 = positions(s.db)[0];
    assert.equal(p2.stop, p1.stop, "never loosened");
    assert.equal(s.db.sql(`SELECT COUNT(*) n FROM trial_stop_changes`)[0].n, 1);
    assert.throws(() => s.db.sql(`UPDATE trial_positions SET stop = initial_stop - 1`), /CHECK/, "the ledger itself refuses a stop below the initial stop");
  });
  it("a close below the average creates a market SELL that fills at the first candle after acceptance", async () => {
    const s = setup(); const { t2 } = await toEntry(s);
    s.m.addDay(0.93); // D2 closes below the 50-day average, above the 3 x ATR trailing stop
    const t3 = t2 + DAY;
    await s.run(t3 + 90_000);
    const exit = orders(s.db).find((o) => o.kind === "EXIT");
    assert.equal(exit.status, "PENDING");
    await s.run(t3 + 3 * MIN + 5000);
    const q = positions(s.db)[0];
    assert.equal(q.exit_reason, "SIGNAL_EXIT"); assert.equal(q.exit_candle_t, t3 + 2 * MIN);
    assert.ok(Math.abs(q.exit_price - s.m.minute(t3 + 2 * MIN).o * 0.9995) < 1e-6);
  });
});

describe("outages, restarts and data problems (TEST)", () => {
  it("a 20-hour outage with an open position: the stop hit during it is found on 15-minute history, filled at the stop, marked late", async () => {
    const s = setup(); const { t2 } = await toEntry(s);
    const p = positions(s.db)[0];
    const hit = t2 + 3 * 3_600_000 + 7 * MIN; // inside the outage
    const px = s.m.minute(hit).o;
    s.m.minuteOverride.set(hit, { t: hit, o: px, h: px, l: p.stop - 20, c: p.stop + 5 });
    const now = t2 + 20 * 3_600_000; // first run after 20 h (1-minute history covers only 12 h)
    await s.run(now);
    const q = positions(s.db)[0];
    assert.equal(q.status, "CLOSED"); assert.equal(q.exit_interval_min, 15, "the finest history that covers the outage");
    assert.ok(Math.abs(q.exit_price - p.stop * 0.9995) < 1e-6, "at the stop (the 15-minute candle did not gap through it)");
    assert.ok(q.recorded_late_min > 16 * 60, `recorded ${q.recorded_late_min} min late`);
    assert.ok(events(s.db).includes("FILL_RECORDED_LATE"));
  });
  it("daily closes missed during an outage: only the latest can trade; older signals are recorded as missed, never back-dated", async () => {
    const s = setup();
    await s.run(D0 + DAY + 30_000);
    s.m.addDay(); s.m.addDay(); // D1 and D2 both close above the average
    await s.run(D0 + 3 * DAY + 90_000); // first run after both
    const o = orders(s.db);
    assert.equal(o.length, 1); assert.equal(o[0].signal_candle_t, D0 + 2 * DAY, "the latest close only");
    assert.ok(events(s.db).includes("MISSED_SIGNAL"));
  });
  it("runs are idempotent and stateless (a restart is just the next run): repeating a run changes nothing", async () => {
    const s = setup(); const { t2 } = await toEntry(s);
    const snap = JSON.stringify([acct(s.db).cash_micro, orders(s.db), positions(s.db)]);
    await s.run(t2 + 3 * MIN + 5000); await s.run(t2 + 3 * MIN + 6000);
    assert.equal(JSON.stringify([acct(s.db).cash_micro, orders(s.db), positions(s.db)]), snap);
  });
  it("an overlapping run is refused by the lock", async () => {
    const s = setup(); await s.run(D0 + DAY + 30_000);
    s.db.sql(`UPDATE trial_accounts SET lock_until = ?`, D0 + DAY + 200_000);
    assert.equal((await s.run(D0 + DAY + 60_000)).reason, "another run is in progress");
  });
  it("market data unavailable: nothing advances past unchecked time; the next run catches up", async () => {
    const s = setup(); const { t2 } = await toEntry(s);
    const before = acct(s.db).last_minute_t;
    const now = t2 + 30 * MIN;
    await T.runTrial({ DB: s.db }, now, async () => ({ ok: false, message: "EService:Unavailable" }));
    assert.equal(acct(s.db).last_minute_t, before);
    assert.ok(events(s.db).includes("MARKET_DATA_UNAVAILABLE"));
    await s.run(now); assert.ok(acct(s.db).last_minute_t > before);
  });
  it("an entry too small for Kraken's minimum is cancelled with the reason, never forced", async () => {
    const s = setup();
    s.db.sql(`UPDATE trial_accounts SET cash_micro = 100000`); // TEST: $0.10
    await toEntry(s);
    const [o] = orders(s.db);
    assert.equal(o.status, "CANCELLED"); assert.equal(o.code, "BELOW_VENUE_MINIMUM"); assert.equal(positions(s.db).length, 0);
  });
});

describe("isolation from the production portfolio", () => {
  it("every statement the trial runs touches only trial_* tables (never wallets, bots, positions or funding)", async () => {
    const s = setup(); const { t2 } = await toEntry(s);
    s.m.addDay(0.8); await s.run(t2 + DAY + 90_000); await s.run(t2 + DAY + 3 * MIN + 5000);
    const touched = new Set(s.db.trace.flatMap((q) => [...q.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1])));
    for (const t of touched) assert.ok(/^trial_/.test(t) || t === "sqlite_master", `touched ${t}`);
  });
  it("the account's recorded settings are exactly the frozen module settings", async () => {
    const s = setup();
    assert.equal(acct(s.db).params_json, JSON.stringify(T.PARAMS));
  });
});

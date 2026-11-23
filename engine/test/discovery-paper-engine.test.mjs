// Forward PAPER engine accounting (P1-100, P1-50, S3-25): hand-computed expectations on synthetic order books.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buyWalk, sellWalk, newAccount, buy, sell, equity, mark, rebalance, step, START, DAY, HOUR, S3_BAND } from "../src/research/discovery/paper-engine.mjs";

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const fresh = () => ({ accounts: [newAccount("P1-100", "P1", 1), newAccount("P1-50", "P1", 0.5), newAccount("S3-25", "S3", 0.25)], lastDay: null });
// one sample: Ndax ETH book + Kraken ETH mid 100 USD, USD/CAD 1 -> global price C$100
const S = (t, bids, asks) => ({ t, ndax: { ETH: { top10: { bids, asks } } }, kraken: { ETH: { bid: 99.99, ask: 100.01 }, USDCAD: { bid: 1, ask: 1 } } });
const sig = (x, signal) => ({ inp: { p1: { ETH: { x, med: 0, signal } } }, s3w: null });

test("book walks: average price across levels; null when the visible book is too thin", () => {
  assert.deepEqual(buyWalk([[10, 1], [20, 10]], 30), { qty: 2, px: 15 });
  assert.equal(buyWalk([[10, 1]], 50), null);
  assert.deepEqual(sellWalk([[20, 1], [10, 5]], 2), { proceeds: 30, px: 15 });
  assert.equal(sellWalk([[20, 1]], 2), null);
});

test("round trip: 0.2 % fee each side, cash, cost basis, trade net and liquidation equity are exact", () => {
  const a = newAccount("A", "P1", 1), book = { asks: [[10, 1], [20, 10]], bids: [[20, 1], [10, 5]] };
  assert.ok(buy(a, "ETH", book, 30, 0));
  near(a.cash, 100 - 30.06); near(a.pos.ETH.qty, 2); near(a.pos.ETH.cost, 30.06);
  near(equity(a, { ETH: book }), 69.94 + 30 * 0.998);          // liquidation value after the sell fee
  assert.ok(sell(a, "ETH", book, 2, 1, "TEST"));
  near(a.cash, 69.94 + 29.94); near(a.fees, 0.12); near(a.trades[0].net, -0.12); assert.equal(a.pos.ETH, undefined);
});

test("misses are recorded, never filled: thin book, not enough cash, below C$1", () => {
  const a = newAccount("A", "P1", 1);
  assert.equal(buy(a, "ETH", { asks: [[10, 1]], bids: [] }, 50, 0), false);
  assert.equal(buy(a, "ETH", { asks: [[10, 100]], bids: [] }, 100, 0), false); // 100 + 0.20 fee > 100 cash
  assert.equal(buy(a, "ETH", { asks: [[10, 100]], bids: [] }, 0.5, 0), false);
  assert.deepEqual(a.missed.map((m) => m.why), ["ask book too thin", "not enough cash", "below the C$1 minimum"]);
  near(a.cash, 100);
});

test("drawdown from the high-water mark; 15 % halts and closes at the NEXT sample, not the same one", () => {
  const st = { accounts: [newAccount("A", "P1", 1)], lastDay: null }, a = st.accounts[0];
  buy(a, "ETH", { asks: [[100, 10]], bids: [] }, 90, 0);                       // cash 9.82, 0.9 ETH
  step(st, S(1, [[120, 10]], [[121, 10]]), null);                                // equity 9.82 + 108 x 0.998 = 117.604 -> HWM
  near(a.hwm, 9.82 + 108 * 0.998); assert.equal(a.halted, false);
  step(st, S(2, [[95, 10]], [[96, 10]]), null);                                  // 9.82 + 85.5 x 0.998 = 95.149 -> DD 19.1 %
  near(a.maxDD, 1 - (9.82 + 85.5 * 0.998) / (9.82 + 108 * 0.998)); assert.equal(a.halted, true); assert.ok(a.pos.ETH);
  step(st, S(3, [[90, 10]], [[91, 10]]), null);                                  // closed at the next sample's bids
  assert.equal(a.pos.ETH, undefined); assert.equal(a.trades[0].reason, "HALT_DRAWDOWN_15"); near(a.cash, 9.82 + 81 * 0.998);
});

test("P1 entry: executes only when the executable deviation is still < -cost/2; sizing f x equity / 3", () => {
  const st = fresh(), t = START + 60_000;
  step(st, S(t, [[98.9, 100]], [[99, 100]]), sig(-0.012, true));                 // ask 99 vs global 100: -1.0 % < -0.39 %
  const [p100, p50, s3] = st.accounts;
  near(p100.pos.ETH.cost, (100 / 3) * 1.002); near(p100.pos.ETH.qty, 100 / 3 / 99);
  near(p50.pos.ETH.cost, (50 / 3) * 1.002); assert.deepEqual(s3.pos, {});
  near(p100.pos.ETH.xExec, 99 / 100 - 1);

  const st2 = fresh();                                                           // the gap has closed by execution
  step(st2, S(t, [[99.7, 100]], [[99.8, 100]]), sig(-0.012, true));              // -0.2 % is not < -0.39 %
  assert.deepEqual(st2.accounts[0].pos, {}); assert.equal(st2.accounts[0].missed[0].crossingGone, true);

  const st3 = fresh();                                                           // first sample of the day after 01:00 UTC
  step(st3, S(START + HOUR + 60_000, [[98.9, 100]], [[99, 100]]), sig(-0.012, true));
  assert.deepEqual(st3.accounts[0].pos, {}); assert.match(st3.accounts[0].missed[0].why, /window/);
});

test("P1 exits: REVERTED at the next day's first sample (exact net); TIME_7D after 7 days; late exits run at the next sample", () => {
  const st = fresh(), p100 = st.accounts[0];
  step(st, S(START + 60_000, [[98.9, 100]], [[99, 100]]), sig(-0.012, true));
  step(st, S(START + DAY + 60_000, [[100, 100]], [[100.1, 100]]), sig(0.001, false));
  assert.equal(p100.trades.length, 1); assert.equal(p100.trades[0].reason, "REVERTED");
  near(p100.trades[0].net, (100 / 3 / 99) * 100 * 0.998 - (100 / 3) * 1.002);

  const s2 = fresh(), q = s2.accounts[0];
  step(s2, S(START + 60_000, [[98.9, 100]], [[99, 100]]), sig(-0.012, true));
  for (let d = 1; d <= 6; d++) step(s2, S(START + d * DAY + 60_000, [[99, 100]], [[99.1, 100]]), sig(-0.005, false));
  assert.ok(q.pos.ETH, "still held after 6 days");
  step(s2, S(START + 7 * DAY + 60_000, [[99, 100]], [[99.1, 100]]), sig(-0.005, false));
  assert.equal(q.trades[0].reason, "TIME_7D");

  const s3 = fresh(), r = s3.accounts[0];                                         // no Ndax ETH book at the exit sample
  step(s3, S(START + 60_000, [[98.9, 100]], [[99, 100]]), sig(-0.012, true));
  const noBook = S(START + DAY + 60_000, [], []); delete noBook.ndax.ETH;
  step(s3, noBook, sig(0.001, false)); assert.ok(r.pos.ETH.exitFlag);
  step(s3, S(START + DAY + 180_000, [[100, 100]], [[100.1, 100]]), null);
  assert.equal(r.trades[0].reason, "REVERTED_LATE");
});

test("P1: at most 3 slots, one per coin; nothing happens before the first decision time", () => {
  const st = fresh(), b = { top10: { bids: [[98.9, 1000]], asks: [[99, 1000]] } }, k = { bid: 99.99, ask: 100.01 };
  const s = { t: START + 60_000, ndax: { BTC: b, ETH: b, XRP: b, LTC: b }, kraken: { BTC: k, ETH: k, XRP: k, LTC: k, USDCAD: { bid: 1, ask: 1 } } };
  const p1 = Object.fromEntries(["BTC", "ETH", "XRP", "LTC"].map((c) => [c, { x: -0.02, med: 0, signal: true }]));
  step(st, s, { inp: { p1 }, s3w: null });
  assert.equal(Object.keys(st.accounts[0].pos).length, 3); assert.equal(st.accounts[0].missed[0].why, "3 slots full");
  const early = fresh(); step(early, { ...s, t: START - 60_000 }, { inp: { p1 }, s3w: null });
  assert.deepEqual(early.accounts[0].pos, {});
});

test("S3-25: buys to target, holds inside the band, sells on a 0 target", () => {
  const a = newAccount("S3-25", "S3", 0.25), books = { BTC: { asks: [[100, 100]], bids: [[100, 100]] }, ETH: { asks: [[100, 100]], bids: [[100, 100]] } };
  near(S3_BAND, 0.0125);
  rebalance(a, books, { BTC: 0.125, ETH: 0 }, S3_BAND, 0);
  near(a.pos.BTC.cost, 12.5 * 1.002); assert.equal(a.pos.ETH, undefined);
  rebalance(a, books, { BTC: 0.13, ETH: 0 }, S3_BAND, 1);                       // 0.005 drift < band: no trade
  near(a.pos.BTC.cost, 12.5 * 1.002);
  rebalance(a, books, { BTC: 0, ETH: 0 }, S3_BAND, 2);
  assert.equal(a.pos.BTC, undefined); assert.equal(a.trades[0].reason, "S3_TARGET_0"); near(a.cash, 100 - 12.525 + 12.5 * 0.998);
});

test("mark: equity marked at every sample; the high-water mark only rises", () => {
  const a = newAccount("A", "P1", 1); mark(a, {}, 0); near(a.equity, 100); near(a.maxDD, 0);
  buy(a, "ETH", { asks: [[100, 10]], bids: [] }, 50, 0);
  mark(a, { ETH: { bids: [[100, 10]], asks: [] } }, 1); near(a.equity, 49.9 + 49.9); near(a.hwm, 100); near(a.maxDD, 1 - 99.8 / 100);
});

// ---- report and the pre-registered decision rules ----
import { accountStats, verdict } from "../src/research/discovery/paper-report.mjs";
const acct = (trades, maxDD = 0) => ({ ...newAccount("X", "P1", 1), trades, maxDD });

test("report stats: net, 1-day / 1-week returns from the equity series, win rate, profit factor", () => {
  const series = [{ t: START, eq: 100 }, { t: START + 6 * DAY, eq: 104 }, { t: START + 7 * DAY, eq: 110 }];
  const s = accountStats(acct([{ net: 3 }, { net: -1 }, { net: 2 }]), series, START + 7 * DAY);
  near(s.net_pct, 10); near(s.r1d_pct, (110 / 104 - 1) * 100); near(s.r1w_pct, 10); assert.equal(s.r2w_pct, null);
  near(s.win_rate, 2 / 3); near(s.profit_factor, 5);
});

test("decision rules: day 7 descriptive; day 14 STOP on (a)-(d); never a pass", () => {
  const st = (p, s3, extra = {}) => ({ "P1-100": { net_pct: p, max_dd_pct: 2, trades: 3, win_rate: 0.5, ...extra }, "S3-25": { net_pct: s3 } });
  assert.match(verdict(st(-5, 1), 7, null).decision, /CONTINUE/);                                     // losing is not a stop at day 7
  assert.match(verdict(st(-5, 1, { trades: 5, win_rate: 0 }), 7, null).decision, /STOP P1 early/);
  assert.match(verdict(st(3, 1, { max_dd_pct: 15 }), 7, null).decision, /STOP/);
  assert.match(verdict(st(0.5, 1), 14, null).decision, /STOP P1/);                                    // (a) behind S3-25
  assert.match(verdict(st(-0.5, -2), 14, null).decision, /STOP P1/);                                  // (a) not above 0
  assert.match(verdict(st(2, 1), 14, null).decision, /CONTINUE to day 30/);
  assert.match(verdict(st(2, 1), 14, { events: 10, mean_net_pct: -0.1, crossings: 10, disappeared_share: 0.1 }).decision, /STOP/); // (c)
  assert.match(verdict(st(2, 1), 14, { events: 3, mean_net_pct: 1, crossings: 4, disappeared_share: 0.5 }).decision, /STOP/);      // (d)
});

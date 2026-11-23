// P1 order-book study analyzer: event rules on synthetic samples (hand-computed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsForCoin, summarize, criteria } from "../src/research/discovery/analyze-gap.mjs";
import { walk } from "../src/research/discovery/gap-util.mjs";

const T0 = Date.parse("2026-12-01T00:00:00Z"), M = 60_000;
// global CAD price = 100 (Kraken mid 100 USD x USD/CAD 1); reference premium m = 0; ETH cost 0.78 %
const s = (i, ask, bid, extra = {}) => ({ t: T0 + i * 2 * M, kraken: { ETH: { bid: 99.99, ask: 100.01 }, USDCAD: { bid: 1, ask: 1 } },
  ndax: { ETH: { bid, ask, buy: { 33: ask }, sell: { 33: bid }, askDepth2pct: 1000, ...extra } } });
const ref = () => 0;

test("walk: average price across levels", () => { assert.equal(walk([[10, 1], [20, 10]], 30), 30 / (1 + 1)); assert.equal(walk([[10, 1]], 50), null); });

test("persistent gap -> entry at the 2nd sample's ask; exit when the bid-based premium is back >= 0; exact net", () => {
  const S = [s(0, 100, 99.9), s(1, 99, 98.9), s(2, 98.9, 98.8), s(3, 99.5, 99.4), s(4, 100.2, 100.05)];
  const r = eventsForCoin(S, "ETH", ref);
  assert.equal(r.crossings, 1); assert.equal(r.events.length, 1);
  const e = r.events[0]; assert.equal(e.entryPx, 98.9); assert.equal(e.exitPx, 100.05); assert.equal(e.reason, "CLOSED");
  assert.ok(Math.abs(e.net - ((100.05 / 98.9) * 0.998 ** 2 - 1)) < 1e-12);
});

test("a gap that is gone by the next sample counts as disappeared (no trade)", () => {
  const r = eventsForCoin([s(0, 100, 99.9), s(1, 99, 98.9), s(2, 100, 99.9)], "ETH", ref);
  assert.equal(r.events.length, 0); assert.equal(r.disappeared, 1);
});

test("stale quotes (frozen Ndax book while Kraken moved >= 0.3 %) and thin books are excluded", () => {
  const S = [];
  // Ndax book frozen at 99.5 / 99.4 for 12 minutes; Kraken drifts up, and the gap first crosses -0.78 % only at minute 12
  for (let i = 0; i < 7; i++) { const x = s(i, 99.5, 99.4); const k = i < 6 ? 100 + i * 0.05 : 100.4; x.kraken.ETH = { bid: k - 0.01, ask: k + 0.01 }; S.push(x); }
  const r = eventsForCoin(S, "ETH", ref); assert.ok(r.stale >= 1);
  const t = eventsForCoin([s(0, 100, 99.9), s(1, 99, 98.9, { askDepth2pct: 10 })], "ETH", ref); assert.equal(t.thin, 1);
});

test("criteria: too few events -> REJECT", () => {
  const sum = summarize([{ events: [{ net: 0.01, gap: 0.01, reason: "CLOSED", hours: 2 }], crossings: 1, disappeared: 0, stale: 0, thin: 0, collectionGaps: 0 }]);
  assert.equal(criteria(sum, { ETH: sum }).verdict, "REJECT");
});

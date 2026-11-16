// REVIEW: strict acceptance timing. An order placed at a bar's close is accepted by the ledger seconds into the next
// bar, so that bar cannot prove a fill; with entryDelayBars 1 the order is worked from the bar after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newBroker, placeEntry, placeExit, processBar } from "../src/broker.mjs";

const bar = (i, o, h, l, c) => ({ i, t: i * 60_000, o, h, l, c });
const order = { id: "OTE Long", side: 1, qty: 1, limit: 99 };
const fresh = (opts) => { const br = { ...newBroker(), opts }; placeEntry(br, order); placeExit(br, { from: "OTE Long", limit: 110, stop: 90 }); return br; };

test("default (current production): the next bar can fill the limit", () => {
  const br = fresh(undefined);
  assert.equal(processBar(br, bar(1, 100, 100.5, 98.5, 100)).filter((e) => e.type === "ENTRY_FILL").length, 1);
});

test("strict: the next bar (opened before acceptance) never fills; the bar after does, at the same rules", () => {
  const br = fresh({ entryDelayBars: 1 });
  assert.equal(processBar(br, bar(1, 100, 100.5, 98.5, 100)).length, 0, "touched on the first bar: no fill");
  placeEntry(br, order); placeExit(br, { from: "OTE Long", limit: 110, stop: 90 }); // the strategy re-issues the same order
  const ev = processBar(br, bar(2, 100, 100.2, 98.8, 99.5));
  const fill = ev.find((e) => e.type === "ENTRY_FILL");
  assert.ok(fill, "second bar fills"); assert.equal(fill.price, 99);
});

test("strict: a changed order is a new order (its age restarts)", () => {
  const br = fresh({ entryDelayBars: 1 });
  processBar(br, bar(1, 100, 100.5, 100.1, 100.3));
  placeEntry(br, { ...order, limit: 98.5 }); // new limit: new order, accepted later
  assert.equal(processBar(br, bar(2, 100, 100.2, 98, 99)).filter((e) => e.type === "ENTRY_FILL").length, 0);
  placeEntry(br, { ...order, limit: 98.5 });
  assert.equal(processBar(br, bar(3, 99, 99.2, 98, 98.6)).filter((e) => e.type === "ENTRY_FILL").length, 1);
});

test("acceptanceTiming (live engine): not yet accepted = never fills; a bar that began before acceptance cannot fill; the next can", () => {
  const br = fresh({ acceptanceTiming: true });
  assert.equal(processBar(br, bar(1, 100, 100.5, 98.5, 100)).length, 0, "no acceptance recorded yet: no fill");
  br.entry.acceptedAtMs = 2 * 60_000 + 3000; // the ledger accepted it 3 s into bar 2
  placeEntry(br, order); // re-issued unchanged: acceptance kept
  assert.equal(br.entry.acceptedAtMs, 2 * 60_000 + 3000);
  assert.equal(processBar(br, bar(2, 100, 100.2, 98.5, 99.5)).length, 0, "bar 2 began 3 s before acceptance");
  placeEntry(br, order);
  assert.equal(processBar(br, bar(3, 99.5, 99.8, 98.7, 99.1)).filter((e) => e.type === "ENTRY_FILL").length, 1, "bar 3 began after acceptance");
});

test("acceptanceTiming: a replaced order (new limit) loses the old acceptance; options off store nothing new", () => {
  const br = fresh({ acceptanceTiming: true });
  br.entry.acceptedAtMs = 1000;
  placeEntry(br, { ...order, limit: 98 });
  assert.equal(br.entry.acceptedAtMs, undefined);
  const off = fresh(undefined);
  processBar(off, bar(1, 100, 100.5, 99.5, 100)); placeEntry(off, order);
  assert.deepEqual(Object.keys(off.entry).sort(), ["id", "limit", "qty", "side"]);
});

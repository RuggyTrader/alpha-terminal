// Pre-sync comparison of engine state and production ledger (src/sync_check.mjs): it fails closed.
//   node --test test/sync_check.test.mjs
// The state and ledger objects below are shaped like the engine's state file and the Worker's
// /webhook/engine-ledger answer; they are test inputs, not trades.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareEngineAndLedger } from "../src/sync_check.mjs";

const ID = "ENG-SOLUSD-5-2026-11-08T13:45:00Z-BUY";
const engineState = (over = {}) => ({
  openEntryId: ID,
  strategy: { broker: { pos: { side: 1, qty: 37.840045646329266, avg: 89.14, entryId: "OTE Long" } } },
  outbox: [{ id: ID, action: "BUY", kind: "ENTRY", qty: "37.84004565", status: "accepted", code: "DRY_RUN_ACCEPTED" }],
  ...over,
});
const flatState = () => ({ openEntryId: null, strategy: { broker: { pos: null } }, outbox: [] });
const ledgerPos = (over = {}) => ({ symbol: "SOLUSD", side: "long", status: "OPEN", qty: 37.84004565, avg_entry_price: 89.11, open_alert_id: ID, ...over });
const answer = (position) => ({ ok: true, mode: "PAPER", symbol: "SOLUSD", position, alerts: {}, read_only: true });
const check = (state, resp) => compareEngineAndLedger(state, resp, "SOLUSD");
const fails = (r, re) => { assert.equal(r.pass, false, r.detail); assert.match(r.detail, re); };

describe("matching positions pass", () => {
  it("no saved state and a flat ledger", () => assert.equal(check(null, answer(null)).pass, true));
  it("a flat saved state and a flat ledger", () => assert.equal(check(flatState(), answer(null)).pass, true));
  it("the same open position: symbol, direction, quantity, status and opening alert id", () => {
    const r = check(engineState(), answer(ledgerPos()));
    assert.equal(r.pass, true, r.detail);
    assert.match(r.detail, /same open position: SOLUSD long 37\.84004565/);
  });
});

describe("a matching id with different details is a mismatch", () => {
  it("quantity differs", () => fails(check(engineState(), answer(ledgerPos({ qty: 38.84004565 }))), /quantity: ledger 38\.84004565, engine 37\.84004565/));
  it("quantity differs by more than the 8-decimal rounding", () => fails(check(engineState(), answer(ledgerPos({ qty: 37.84004567 }))), /quantity/));
  it("direction differs", () => fails(check(engineState(), answer(ledgerPos({ side: "short" }))), /direction: ledger short, engine long/));
  it("an engine short against a ledger long", () => {
    const s = engineState();
    s.strategy.broker.pos.side = -1;
    fails(check(s, answer(ledgerPos())), /direction: ledger long, engine short/);
  });
  it("status is not OPEN", () => fails(check(engineState(), answer(ledgerPos({ status: "CLOSED" }))), /status: ledger CLOSED/));
  it("symbol differs", () => fails(check(engineState(), answer(ledgerPos({ symbol: "ETHUSD" }))), /symbol: ledger ETHUSD/));
  it("opening alert id differs", () => fails(check(engineState(), answer(ledgerPos({ open_alert_id: "PINE-SOL-1" }))), /opening alert id: ledger PINE-SOL-1/));
  it("the engine has no opening id for its position", () => fails(check(engineState({ openEntryId: null }), answer(ledgerPos())), /opening alert id: the engine has none/));
  it("the engine never recorded sending that entry", () => fails(check(engineState({ outbox: [] }), answer(ledgerPos())), /no record of sending/));
  it("the engine's entry was rejected, not accepted", () => {
    const s = engineState();
    s.outbox[0].status = "rejected";
    fails(check(s, answer(ledgerPos())), /is rejected, not accepted/);
  });
});

describe("missing positions are mismatches", () => {
  it("the engine holds a position production does not (would send an unmatched CLOSE)", () =>
    fails(check(engineState(), answer(null)), /production does not hold; it would send an unmatched CLOSE/));
  it("production holds a position the engine does not", () => fails(check(flatState(), answer(ledgerPos())), /that the engine does not hold/));
  it("production holds a position and the engine has no saved state", () => fails(check(null, answer(ledgerPos())), /that the engine does not hold/));
});

describe("unreadable data fails closed", () => {
  for (const [name, resp] of [
    ["no ledger answer", null],
    ["ledger answer not ok", { ...answer(null), ok: false }],
    ["ledger answer without read_only", { ok: true, symbol: "SOLUSD", position: null }],
    ["ledger answer for another symbol", { ...answer(null), symbol: "ETHUSD" }],
    ["ledger answer without a position field", { ok: true, symbol: "SOLUSD", read_only: true }],
    ["ledger position without a quantity", answer(ledgerPos({ qty: "abc" }))],
    ["ledger position with zero quantity", answer(ledgerPos({ qty: 0 }))],
    ["ledger position without an opening id", answer(ledgerPos({ open_alert_id: "" }))],
    ["ledger position not an object", answer("OPEN")],
  ]) {
    it(name, () => fails(check(null, resp), /production ledger answer is missing or unreadable/));
  }
  it("an unreadable engine state file", () => fails(check(undefined, answer(null)), /saved state could not be read/));
  for (const [name, state] of [
    ["state without the strategy", { outbox: [] }],
    ["state without an outbox", { strategy: { broker: { pos: null } } }],
    ["position with an unknown side", engineState({ strategy: { broker: { pos: { side: 0, qty: 1 } } } })],
    ["position with no quantity", engineState({ strategy: { broker: { pos: { side: 1, qty: null } } } })],
  ]) {
    it(name, () => fails(check(state, answer(null)), /saved state is malformed/));
  }
});

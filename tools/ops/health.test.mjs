// Unit tests for the read-only health monitor's pure checks (no production access).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assess, auditTail, engineSettings } from "./health.mjs";

const fresh = (min) => new Date(Date.now() - min * 60_000).toISOString();
const base = (o = {}) => ({ enginePaused: false, workerPaused: false, lockAlive: true, lastAuditAt: fresh(0.5), lastCandle: new Date(Math.floor(Date.now() / 60_000) * 60_000 - 120_000).toISOString(),
  lastHeartbeat: "ok", lastHeartbeatAt: fresh(1), ledgerCheck: "OK", engineLive: null, ledgerPending: null, ledgerOpen: null, engineHolds: false, ordersSincePause: 0, ...o });

describe("health monitor", () => {
  it("reads only the three non-secret keys from engine.env", () => {
    const s = engineSettings("ALPHA_WEBHOOK_SECRET=abc\nENGINE_BOTS=ALPHA-01,ALPHA-02\nENGINE_PAUSED_BOTS=ALPHA-01\nENGINE_STRICT_FILL=on\nDASHBOARD_PASSPHRASE=zzz\n");
    assert.deepEqual(s.bots, ["ALPHA-01", "ALPHA-02"]);
    assert.deepEqual([...s.paused], ["ALPHA-01"]);
    assert.equal(s.strictFill, true);
    assert.ok(!JSON.stringify({ ...s, paused: [...s.paused] }).includes("abc") && !JSON.stringify(s).includes("zzz"));
  });
  it("audit tail keeps the latest record of each kind", () => {
    const a = auditTail([{ at: "1", type: "candle", t: "A" }, { at: "2", type: "candle", t: "B" }, { at: "3", type: "signal", code: "ENTRIES_PAUSED" }].map((x) => JSON.stringify(x)).join("\n"));
    assert.equal(a.candle.t, "B");
    assert.equal(a.paused_skip.at, "3");
  });
  it("healthy bot: OK", () => assert.equal(assess("ALPHA-01", base()).status, "OK"));
  it("pause disagreement in either direction is reported", () => {
    assert.match(assess("ALPHA-01", base({ enginePaused: true })).issues.join(), /pause disagreement: engine PAUSED, Worker enabled/);
    assert.match(assess("ALPHA-01", base({ workerPaused: true })).issues.join(), /engine enabled, Worker PAUSED/);
    assert.equal(assess("ALPHA-01", base({ enginePaused: true, workerPaused: true })).status, "OK");
  });
  it("an outage is obvious: no lock or no recent audit -> not running; stale candle -> data stale", () => {
    const r = assess("ALPHA-01", base({ lockAlive: false, lastAuditAt: fresh(700), lastCandle: fresh(700) }));
    assert.equal(r.facts.engine_running, false);
    assert.equal(r.facts.market_data_fresh, false);
    assert.equal(r.status, "ATTENTION");
  });
  it("order and position mismatches against the ledger are reported", () => {
    assert.match(assess("ALPHA-03", base({ ledgerPending: "X", engineLive: { id: "Y" } })).issues.join(), /order mismatch: ledger pending X, engine live Y/);
    assert.equal(assess("ALPHA-03", base({ ledgerPending: "X", engineLive: { id: "X" } })).status, "OK");
    assert.match(assess("ALPHA-03", base({ ledgerOpen: "SHORT T1" })).issues.join(), /position mismatch/);
    assert.match(assess("ALPHA-03", base({ enginePaused: true, workerPaused: true, ordersSincePause: 2 })).issues.join(), /paused bot placed 2/);
  });
  it("never claims ONLINE from reachability alone: each fact is separate", () => {
    const r = assess("ALPHA-02", base({ ledgerCheck: "UNVERIFIED" }));
    assert.equal(r.facts.ledger_synchronized, false);
    assert.equal(r.facts.position_management, false);
    assert.equal(r.facts.engine_running, true);
  });
});

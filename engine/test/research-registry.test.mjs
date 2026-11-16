// The research registry: fixed status vocabulary (no "proven"), required fields, and evidence-ordered comparison.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STATUSES, buildRegistry, comparison, validate } from "../src/research/registry.mjs";

describe("strategy candidate registry", () => {
  it("has no 'proven' status and rejects one", () => {
    assert.ok(!STATUSES.some((s) => /PROVEN|PROFITABLE/i.test(s)));
    assert.throws(() => validate({ id: "x", name: "x", family: "x", version: "1", markets: [], timeframes: [], data: "d", periods: {}, costs: "c", results: {}, status: "PROVEN PROFITABLE", source: "s" }), /not allowed/);
  });
  it("an ELIGIBLE candidate must have positive independent results", () => {
    assert.throws(() => validate({ id: "x", name: "x", family: "x", version: "1", markets: [], timeframes: [], data: "d", periods: {}, costs: "c", results: { independent: { net: -1 } }, status: "ELIGIBLE FOR FURTHER VALIDATION", source: "s" }), /eligible/);
  });
  it("builds from the committed results; every entry valid; the comparison is ordered by status, not profit", () => {
    const reg = buildRegistry("../docs/research");
    assert.ok(reg.candidates.length >= 20);
    const md = comparison(reg);
    const firstFailed = md.indexOf("| FAILED |"), lastInconclusive = md.lastIndexOf("| INCONCLUSIVE |");
    assert.ok(lastInconclusive < firstFailed, "inconclusive before failed");
    assert.ok(!/PROVEN/.test(md));
  });
});

// The fill-pricing disclosure: one exact sentence, identical in the Worker and the frontend, returned with every cost
// profile; and the disclosure release changes no pricing or fee arithmetic.
//   node --test test/disclosures.test.mjs   (no Worker needed)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REQUIRED =
  "PAPER fills are simulated using the Kraken reference price when the signal is processed, not necessarily the Pine " +
  "strategy's original entry or exit price. Maker/taker classifications are inferred from strategy order types and are " +
  "not verified against a live exchange order book.";
const constant = (file) => {
  const m = /export const PAPER_FILL_DISCLOSURE =\s*"((?:[^"\\]|\\.)*)";/.exec(readFileSync(file, "utf8"));
  assert.ok(m, `PAPER_FILL_DISCLOSURE in ${file}`);
  return JSON.parse(`"${m[1]}"`);
};

describe("fill-pricing disclosure", () => {
  it("the Worker and frontend copies are word for word the approved text", () => {
    assert.equal(constant(join(ROOT, "worker", "src", "costs.ts")), REQUIRED);
    assert.equal(constant(join(ROOT, "frontend", "src", "terminal", "disclosures.ts")), REQUIRED);
  });

  it("is returned with valid and invalid profiles alike", () => {
    const src = readFileSync(join(ROOT, "worker", "src", "portfolio.ts"), "utf8");
    assert.equal((src.match(/fill_disclosure: PAPER_FILL_DISCLOSURE/g) ?? []).length, 2);
  });

  it("documentation carries the same sentence", () => {
    assert.ok(readFileSync(join(ROOT, "docs", "PAPER-EXECUTION-COSTS.md"), "utf8").includes(REQUIRED));
  });

  it("pricing and fee arithmetic are unchanged (same formulas as the audited release)", () => {
    const src = readFileSync(join(ROOT, "worker", "src", "costs.ts"), "utf8");
    for (const line of [
      "const slip = liquidity === \"TAKER\" ? p.takerSlipPct / 100 : 0;",
      "const raw = side === \"buy\" ? referencePrice * (1 + slip) : referencePrice * (1 - slip);",
      "const rate = (liquidity === \"MAKER\" ? p.makerPct : p.takerPct) / 100;",
      "feeMicro: micro(price * qty * multiplier * rate),",
    ]) assert.ok(src.includes(line), line);
  });
});

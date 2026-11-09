// Research tooling: execution costs, conservative limit fills, candle aggregation and compounding.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newBroker, placeEntry, placeExit, processBar } from "../src/broker.mjs";
import { tradeCost, VENUES } from "../src/costs.mjs";
import { aggregate, evaluate } from "../src/cli/research.mjs";
import { createState, DEFAULT_INPUTS } from "../src/ote.mjs";

describe("costs", () => {
  it("maker on limit entries and take-profits, taker + slippage on stop exits", () => {
    const tp = tradeCost({ side: 1, qty: 1, entryPrice: 100, exitPrice: 102, exitKind: "TP" }, VENUES.kraken);
    assert.ok(Math.abs(tp.fees - (100 * 0.004 + 102 * 0.004)) < 1e-9);
    assert.equal(tp.slip, 0);
    const sl = tradeCost({ side: 1, qty: 1, entryPrice: 100, exitPrice: 99, exitKind: "SL" }, VENUES.kraken);
    assert.ok(Math.abs(sl.fees - (100 * 0.004 + 99 * 0.008)) < 1e-9);
    assert.ok(Math.abs(sl.slip - 99 * 0.0003) < 1e-9);
    const nd = tradeCost({ side: 1, qty: 1, entryPrice: 100, exitPrice: 99, exitKind: "SL" }, VENUES.ndax);
    assert.ok(Math.abs(nd.fees - (100 + 99) * 0.002) < 1e-9, "Ndax: flat 0.20% both ways");
  });
});

describe("conservative limit fills (limitThroughTicks)", () => {
  const bar = (o, h, l, c) => ({ t: 0, i: 1, o, h, l, c });
  const entryAt = (opts) => {
    const br = { ...newBroker(), opts };
    placeEntry(br, { id: "L", side: 1, qty: 1, limit: 100 });
    placeExit(br, { from: "L", limit: 110, stop: 90 });
    return br;
  };
  it("a touch fills with the default rule but not when the price must trade through", () => {
    assert.equal(processBar(entryAt({}), bar(101, 101.5, 100, 100.5)).length, 1);
    assert.equal(processBar(entryAt({ limitThroughTicks: 1, tick: 0.01 }), bar(101, 101.5, 100, 100.5)).length, 0);
    const ev = processBar(entryAt({ limitThroughTicks: 1, tick: 0.01 }), bar(101, 101.5, 99.99, 100.5));
    assert.deepEqual([ev[0].type, ev[0].price], ["ENTRY_FILL", 100], "fills at the limit price");
  });
});

describe("research helpers", () => {
  it("aggregates only complete groups of 5-minute candles", () => {
    const k = (i, c) => ({ t: i * 300_000, o: c, h: c + 1, l: c - 1, c, v: 1 });
    const out = aggregate([k(0, 10), k(1, 11), k(2, 12), k(3, 13), k(4, 14)], 15);
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].o, out[0].h, out[0].l, out[0].c, out[0].v], [10, 13, 9, 12, 3]);
  });

  it("compounds per trade with costs; no costs reproduces the gross result", () => {
    const tr = [
      { entryMs: 1, exitMs: 2, exitKind: "TP", frac: 1, ret: 0.02, exitRatio: 1.02 },
      { entryMs: 3, exitMs: 4, exitKind: "SL", frac: 0.5, ret: -0.01, exitRatio: 0.99 },
    ];
    const none = evaluate(tr, VENUES.none, 0, 10);
    assert.ok(Math.abs(none.net - (100 * 1.02 * 0.995 - 100)) < 0.01);
    const nd = evaluate(tr, VENUES.ndax, 0, 10);
    assert.ok(nd.net < none.net && nd.costs > 0);
    assert.equal(evaluate(tr, VENUES.ndax, 3, 10).trades, 1, "window by entry time");
  });

  it("the research trend filter is off by default", () => {
    assert.equal(DEFAULT_INPUTS.trendEma, 0);
    assert.equal(createState({ inputs: {} }).inputs.trendEma, 0);
  });
});

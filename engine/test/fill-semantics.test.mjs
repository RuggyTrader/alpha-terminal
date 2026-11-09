// Fill-semantics evidence (src/cli/fill-semantics.mjs) on the committed TradingView benchmark fixture.
//   node --test test/fill-semantics.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { runReading, summary } from "../src/cli/fill-semantics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-2026-10-19_2026-11-07.json"), "utf8"));
const CANDLES = FIX.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const cfg = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, join(HERE, ".."));
const TV = { trades: 69, winners: 32, profit_factor: 3.298, max_drawdown: 21.95 };
const pick = (s) => ({ trades: s.trades, winners: s.winners, profit_factor: s.profit_factor, max_drawdown: s.max_drawdown });

describe("which fill readings reproduce the TradingView benchmark", () => {
  it("the engine's documented default does (and its one same-bar trade is a TP2 on the entry's bar)", () => {
    const r = runReading(CANDLES, cfg.inputs, "default");
    assert.deepEqual(pick(summary(r.trades)), TV);
    const sb = r.trades.filter((t) => t.result === "SAME_BAR");
    assert.deepEqual(sb.map((t) => [t.side, t.entryTime, t.exitKind]), [["LONG", "2026-10-26T13:35:00.000Z", "TP"]]);
  });

  it("forbidding exits on the entry's bar does NOT (TradingView did fill that same-bar TP2)", () => {
    const s = summary(runReading(CANDLES, cfg.inputs, "noSameBarExit").trades);
    assert.notDeepEqual(pick(s), TV);
    assert.equal(s.winners, 31);
  });

  it("the extra one-tick exit delay and requested-price readings cannot be told apart in this window", () => {
    for (const r of ["exitDelayTick", "requested"]) assert.deepEqual(pick(summary(runReading(CANDLES, cfg.inputs, r).trades)), TV);
  });
});

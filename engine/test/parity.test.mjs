// The user's SOLUSD 5m TradingView settings and the matched TradingView benchmark, kept as regression tests.
//   node --test test/parity.test.mjs
// Candles: real Kraken SOLUSD 5m, 2026-10-19 00:00 to 2026-11-07 17:15 UTC (fixtures/, rebuilt from Kraken's public
// trades; every candle that overlapped Kraken's own OHLC matched). Reference: parity/tv-solusd-5m-2026-11-07.json,
// the user's TradingView Strategy Report (screenshot values, rounded as TradingView shows them).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { DEFAULT_INPUTS } from "../src/ote.mjs";
import { runBacktest } from "../src/cli/backtest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, "..");
const FIX = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-2026-10-19_2026-11-07.json"), "utf8"));
const CANDLES = FIX.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const REF = JSON.parse(readFileSync(join(BASE, "parity", "tv-solusd-5m-2026-11-07.json"), "utf8"));

// Exactly the user's TradingView inputs (Structure, Trade plan, PD arrays, Trading, Sessions).
const USER_SETTINGS = {
  swingLen: 5, minLegATR: 3.5, maxAge: 32,
  entryMode: "Limit @ 0.705", slMode: "Swing origin (1.0)", slBuf: 0.1, tp2Ext: 0.25,
  minScore: 1, useFVG: true, fvgMinATR: 0.1, useOB: true, dispATR: 1, useRB: true, rbWick: 0.5, rbMinATR: 0.8, rbLook: 8, maxZones: 70,
  allowLong: true, allowShort: true, riskUSD: 10, useBE: true, beFrac: 0.45, useTrail: true, trailFrac: 0.05, trailLen: 3, trailBuf: 0.05,
  useHours: false, weekendFlat: false, useSleep: false, hoursTz: "America/New_York",
};

describe("solusd-5m profile = the user's TradingView settings", () => {
  const cfg = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, BASE);

  it("every supplied input has exactly the user's value", () => {
    for (const [k, v] of Object.entries(USER_SETTINGS)) assert.equal(cfg.inputs[k], v, k);
  });

  it("every other input keeps the Pine default (inactive time settings, display, notifications)", () => {
    const effective = { ...DEFAULT_INPUTS, ...cfg.inputs };
    for (const k of Object.keys(DEFAULT_INPUTS)) if (!(k in USER_SETTINGS)) assert.equal(effective[k], DEFAULT_INPUTS[k], k);
    for (const k of Object.keys(cfg.inputs)) assert.ok(k in USER_SETTINGS, `profile sets ${k}, which the user did not supply`);
  });

  it("the Pine defaults themselves are unchanged", () => {
    assert.deepEqual(
      [DEFAULT_INPUTS.swingLen, DEFAULT_INPUTS.minLegATR, DEFAULT_INPUTS.maxAge, DEFAULT_INPUTS.slBuf, DEFAULT_INPUTS.tp2Ext, DEFAULT_INPUTS.riskUSD,
        DEFAULT_INPUTS.beFrac, DEFAULT_INPUTS.trailFrac, DEFAULT_INPUTS.trailBuf, DEFAULT_INPUTS.maxZones, DEFAULT_INPUTS.useHours, DEFAULT_INPUTS.useSleep],
      [8, 2.5, 120, 0.2, -0.27, 200, 0.2, 0.5, 0.1, 30, true, true],
    );
  });
});

describe("TradingView benchmark (KRAKEN:SOLUSD 5m, history from 2026-10-19 00:00 UTC)", () => {
  const cfg = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, BASE);
  const { trades } = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5, inputs: cfg.inputs });

  it("matches the Strategy Report summary", () => {
    const pnl = trades.map((t) => t.pnl);
    const wins = pnl.filter((p) => p > 0);
    const gross = wins.reduce((a, b) => a + b, 0), loss = -pnl.filter((p) => p < 0).reduce((a, b) => a + b, 0);
    let eq = 0, peak = 0, dd = 0;
    for (const p of pnl) { eq += p; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    assert.equal(trades.length, REF.summary.closed_trades); // 69
    assert.equal(wins.length, REF.summary.winning_trades); // 32
    assert.equal(+(100 * wins.length / trades.length).toFixed(2), REF.summary.win_rate_pct); // 46.38
    assert.equal(+(gross / loss).toFixed(3), REF.summary.profit_factor); // 3.298
    assert.equal(+dd.toFixed(2), REF.summary.max_drawdown); // 21.95
    // Net: 249.99 against TradingView's displayed 249.98 (a one-cent rounding difference, kept explicit).
    assert.equal(+eq.toFixed(2), 249.99);
    assert.ok(Math.abs(eq - REF.summary.net_pnl) <= 0.011);
  });

  it("reproduces every listed trade at its TradingView trade number", () => {
    for (const r of REF.trades) {
      const t = trades[r.n - 1];
      assert.ok(t, `trade #${r.n}`);
      assert.equal(t.side, r.side, `#${r.n} side`);
      assert.equal(t.entryTime.replace(".000Z", "Z"), r.entry, `#${r.n} entry time`);
      assert.equal(t.exitTime.replace(".000Z", "Z"), r.exit, `#${r.n} exit time`);
      assert.ok(Math.abs(t.entryPrice - r.entry_price) < 0.005, `#${r.n} entry price`);
      assert.ok(Math.abs(t.exitPrice - r.exit_price) < 0.005, `#${r.n} exit price`);
      assert.ok(Math.abs(t.qty - r.qty) < 0.006, `#${r.n} qty`);
      assert.ok(Math.abs(t.pnl - r.pnl) < 0.006, `#${r.n} P&L`);
    }
  });

  it("break-even and trailing exits are part of the matched result", () => {
    const kinds = new Set(trades.map((t) => t.result));
    for (const k of ["TP2", "SL", "BREAK_EVEN", "TRAILING_SL"]) assert.ok(kinds.has(k), k);
  });
});

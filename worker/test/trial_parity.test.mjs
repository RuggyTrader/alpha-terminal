// Candidate B: research-to-engine parity. The trial's strategy module (worker/src/trial/ma50.ts), replayed on daily
// bars, must reproduce the research backtest (engine/src/research/r2.mjs) EXACTLY: same trades, prices, quantities,
// fees and final equity, in every research period, on real BTC daily candles (committed fixture, Coinbase).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(mkdtempSync(join(tmpdir(), "alpha-ma50-")), "ma50.mjs");
buildSync({ entryPoints: [join(HERE, "..", "src", "trial", "ma50.ts")], bundle: true, format: "esm", platform: "neutral", outfile: OUT, logLevel: "silent" });
const M = await import(pathToFileURL(OUT).href);
const R = await import(pathToFileURL(join(HERE, "..", "..", "engine", "src", "research", "r2.mjs")).href);
const K = JSON.parse(readFileSync(join(HERE, "fixtures", "BTC-USD-1d-coinbase.json"), "utf8")).candles;
const D = Date.parse;
const PERIODS = { development: [D("2021-07-01"), D("2024-01-01")], validation: [D("2024-01-01"), D("2025-07-01")], final_test: [D("2025-07-01"), D("2026-11-15")], all: [D("2021-07-01"), D("2026-11-15")] };

describe("Candidate B parity: trial module == research backtest (BTC daily, $100, 2 % risk, 0.20 % + 0.05 %)", () => {
  for (const [name, [a, b]] of Object.entries(PERIODS)) {
    it(`${name}: identical trades and final equity`, () => {
      const r = R.simulate({ K, barMs: 86_400_000, family: "ma", p: { n: 50, k: 3, trail: 3, short: false }, capital: 100, asset: "BTC", fee: 0.2, slip: 0.05, riskPct: 2, fromMs: a, toMs: b });
      const m = M.replayBars(K, { fromMs: a, toMs: b, capital: 100 });
      assert.ok(r.trades.length > 0);
      assert.equal(m.trades.length, r.trades.length, "trade count");
      r.trades.forEach((t, i) => {
        const u = m.trades[i];
        assert.equal(u.entryT, t.entryT, `trade ${i} entry time`); assert.equal(u.exitT, t.exitT, `trade ${i} exit time`);
        for (const k of ["entry", "exit", "qty", "gross", "fees", "net"]) assert.ok(Math.abs(u[k] - t[k]) <= 1e-9 * Math.max(1, Math.abs(t[k])), `trade ${i} ${k}: ${u[k]} vs ${t[k]}`);
        assert.equal(u.reason === "signal" ? "signal" : u.reason, t.reason === "signal" ? "signal" : t.reason);
      });
      assert.ok(Math.abs(m.end - r.end) < 1e-9, `final equity ${m.end} vs ${r.end}`);
      assert.equal(m.skipped, r.skipped.min);
    });
  }
  it("the frozen settings are the round-2 Candidate B settings, LONG only, no leverage", () => {
    assert.deepEqual({ sma: M.PARAMS.sma, atr: M.PARAMS.atr, stopAtr: M.PARAMS.stopAtr, trailAtr: M.PARAMS.trailAtr, riskPct: M.PARAMS.riskPct, feePct: M.PARAMS.feePct, slipPct: M.PARAMS.slipPct, short: M.PARAMS.short, leverage: M.PARAMS.leverage },
      { sma: 50, atr: 14, stopAtr: 3, trailAtr: 3, riskPct: 2, feePct: 0.2, slipPct: 0.05, short: false, leverage: false });
    assert.ok(Object.isFrozen(M.PARAMS));
  });
  it("the reported round-2 figures are reproduced (development +21.10, validation +13.43, final test +4.12)", () => {
    const net = ([a, b]) => +(M.replayBars(K, { fromMs: a, toMs: b, capital: 100 }).end - 100).toFixed(2);
    assert.deepEqual([net(PERIODS.development), net(PERIODS.validation), net(PERIODS.final_test)], [21.1, 13.43, 4.12]);
  });
});

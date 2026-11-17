// Round 8 driver: eligibility screen, frozen acceptance, end-to-end evaluation on SYNTHETIC data (plumbing only; no
// result here is evidence about any strategy), Kraken minimum parsing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accept, equalWeightBuyHold, evaluate, minEquityPerSignal, screen } from "../src/research/r8/run.mjs";
import { parseAssetPairs } from "../src/research/r8/kraken-minimums.mjs";
import { CANDIDATES } from "../src/research/r8/families.mjs";

const DAY = 86_400_000;
/** Deterministic synthetic daily random walk with drift (test fixture, clearly not market data). */
function walk(n, seed, drift = 0.001, t0 = Date.UTC(2021, 0, 1)) {
  let s = seed, p = 10; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, (_, i) => { const o = p; p = p * (1 + drift + (rnd() - 0.5) * 0.08); const h = Math.max(o, p) * (1 + rnd() * 0.02), l = Math.min(o, p) * (1 - rnd() * 0.02); return { t: t0 + i * DAY, o, h, l, c: p }; });
}

describe("round 8 eligibility screen", () => {
  const meta = { "A-3600": { first: "2021-01-01T00:00:00Z", candles: 1000, missing_candles: 5 }, "A-86400": { first: "2021-01-01T00:00:00Z" },
    "B-3600": { first: "2022-03-01T00:00:00Z", candles: 1000, missing_candles: 0 }, "B-86400": { first: "2022-03-01T00:00:00Z" },
    "C-3600": { first: "2021-01-01T00:00:00Z", candles: 900, missing_candles: 100 }, "C-86400": { first: "2021-01-01T00:00:00Z" } };
  it("excludes late, gappy, unpriced or missing markets with reasons, never substituting", () => {
    const r = screen(["A", "B", "C", "D"], { meta, minimums: { A: {}, B: {}, C: {} } });
    assert.deepEqual(r.eligible, ["A"]);
    assert.deepEqual(r.excluded.map((x) => x.market), ["B", "C", "D"]);
    assert.match(r.excluded[0].reasons[0], /history starts/);
    assert.match(r.excluded[1].reasons[0], /missing/);
    assert.equal(r.underpowered, true);
  });
});

describe("round 8 acceptance", () => {
  const curve = Array.from({ length: 40 }, (_, i) => ({ t: Date.UTC(2022, i, 15), eq: 100 * 1.02 ** i }));
  const good = { net: 50, trades: 150, max_dd_pct: 10, by_year: { 2022: 5, 2023: 5, 2024: 5, 2025: 5, 2026: 5 }, largest_market_share_of_net: 0.2, executable_pct: 90 };
  it("passes only when every criterion holds", () => {
    assert.equal(accept({ sel: good, stress: { net: 10 }, curve }).pass, true);
    for (const [k, v, c] of [["net", -1, "c1_net_selected"], ["trades", 99, "c4_100_trades"], ["max_dd_pct", 31, "c5_drawdown_30"], ["largest_market_share_of_net", 0.5, "c7_concentration_40"], ["executable_pct", 59, "c8_feasible_60"]]) {
      const r = accept({ sel: { ...good, [k]: v }, stress: { net: 10 }, curve });
      assert.equal(r.pass, false); assert.ok(r.failed.includes(c), c);
    }
    assert.ok(accept({ sel: good, stress: { net: -1 }, curve }).failed.includes("c2_net_stress"));
    assert.ok(accept({ sel: { ...good, by_year: { 2022: 1, 2023: 1 } }, stress: { net: 1 }, curve }).failed.includes("c6_years_3_of_5"));
    const flatCurve = curve.map((x, i) => ({ ...x, eq: 100 + (i % 2 ? 3 : -3) }));
    assert.ok(accept({ sel: good, stress: { net: 1 }, curve: flatCurve }).failed.includes("c3_ci_995_monthly"));
  });
});

describe("round 8 end-to-end on synthetic data (plumbing only)", () => {
  const daily = Object.fromEntries(["M1", "M2", "M3", "M4", "M5", "M6"].map((m, k) => [m, walk(900, 11 + k * 7)]));
  const minimums = Object.fromEntries(Object.keys(daily).map((m) => [m, { minQty: 2, minCost: 0.5, lotDecimals: 4 }])); // $20 notional at $10
  const win = { from: Date.UTC(2021, 3, 1), to: Date.UTC(2023, 5, 1) };
  for (const cand of CANDIDATES.filter((c) => c.tf === 1440)) {
    it(`${cand.id}: every scenario and cost runs; gross - fees = net is reported; A is the least executable`, () => {
      const r = evaluate(cand, daily, minimums, win);
      assert.deepEqual(Object.keys(r.scenarios), ["A", "B", "C", "D"]);
      for (const k of ["B", "C", "D"]) for (const c of ["selected", "stress"]) {
        const x = r.scenarios[k][c];
        assert.ok(x.attempts >= x.filled_attempts && x.setups >= x.executed_setups && x.attempts >= x.setups);
        assert.equal(Object.values(x.rejections).reduce((a, b) => a + b, 0), x.attempts - x.filled_attempts, "every unfilled attempt has a recorded reason");
      }
      assert.ok(r.scenarios.A.selected.executable_pct <= r.scenarios.B.selected.executable_pct, "a $20 wallet cannot beat $100 on minimums");
      assert.ok(Array.isArray(r.acceptance.failed));
    });
  }
  it("median minimum equity per signal follows the formula", () => {
    assert.deepEqual(minEquityPerSignal([{ market: "X", px: 10, stop: 9 }], { X: { minQty: 2, minCost: 0.5 } }), [100]); // $20 x 10% / 2%
  });
  it("equal-weight buy and hold benchmark", () => {
    const b = { X: [{ t: 0, o: 10, h: 10, l: 10, c: 10 }, { t: DAY, o: 20, h: 20, l: 20, c: 20 }] };
    assert.equal(equalWeightBuyHold(b, { from: 0, to: 2 * DAY }, { feePct: 0, slipPct: 0 }), 100);
  });
});

describe("Kraken AssetPairs parsing", () => {
  it("keeps online USD pairs, maps XBT/XDG, drops dark pools and other quotes", () => {
    const m = parseAssetPairs({ XXBTZUSD: { wsname: "XBT/USD", ordermin: "0.00005", costmin: "0.5", lot_decimals: 8, status: "online" }, "XXBTZUSD.d": { wsname: "XBT/USD" },
      GRTUSD: { wsname: "GRT/USD", ordermin: "20", costmin: "0.5", lot_decimals: 8 }, GRTEUR: { wsname: "GRT/EUR", ordermin: "20" }, XDGUSD: { wsname: "XDG/USD", ordermin: "50", status: "cancel_only" } });
    assert.deepEqual(Object.keys(m).sort(), ["BTC", "GRT"]);
    assert.equal(m.BTC.minQty, 0.00005);
  });
});

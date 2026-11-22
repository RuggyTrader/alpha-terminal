// Phase 3 audit of the strongest DD2 strategies on REAL data (2016-2026): every single fill is checked against the rules
// (timing, price, slippage, fee, Kraken minimum, lot step, cash, position cap, risk per trade, stop distance), and
// look-ahead is checked by truncating the real history at many dates. Needs the git-ignored data:
//   ALPHA_DATA=<engine/data> node --test test/phase3-audit.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COSTS, MIN_QTY, backtest } from "../src/research/dd2/bt.mjs";

const DATA = process.env.ALPHA_DATA ?? null;
const have = !!DATA && existsSync(join(DATA, "strategy-select", "BTC-USD-86400-pre2021.json"));
function load(a) { const m = new Map(); for (const f of [`strategy-select/${a}-USD-86400-pre2021.json`, `research2/${a}-USD-86400.json`]) { const p = join(DATA, f); if (existsSync(p)) for (const k of JSON.parse(readFileSync(p, "utf8")).candles) m.set(k.t, k); } return [...m.values()].sort((x, y) => x.t - y.t); }
export const CANDIDATES = {
  "A BTC momentum 0.25 %": { uni: ["BTC"], spec: { family: "M", p: { L: 56, th: 0.05 }, k: 2, trail: true, r: 0.25, cb: 0 } },
  "B 3-asset momentum 0.10 %": { uni: ["BTC", "ETH", "SOL"], spec: { family: "M", p: { L: 56, th: 0.05 }, k: 1.5, trail: true, r: 0.1, cb: 0 } },
  "C 3-asset 55/10 breakout 0.25 %": { uni: ["BTC", "ETH", "SOL"], spec: { family: "B", p: { N: 55, M: 10 }, k: 2, trail: true, r: 0.25, cb: 0 } },
  "D 3-asset 20/10 breakout 0.25 %": { uni: ["BTC", "ETH", "SOL"], spec: { family: "B", p: { N: 20, M: 10 }, k: 1.5, trail: true, r: 0.25, cb: 0 } },
};
const FROM = Date.parse("2016-01-01"), TO = Date.parse("2026-11-15");

describe("Phase 3 audit: every fill of the strongest strategies obeys the rules (real data)", { skip: !have && "set ALPHA_DATA to engine/data" }, () => {
  const K = have ? { BTC: load("BTC"), ETH: load("ETH"), SOL: load("SOL") } : {};
  for (const [name, c] of Object.entries(CANDIDATES)) {
    it(`${name}: timing, prices, costs, minimums, cash, cap and risk on every fill`, () => {
      const assets = c.uni.map((a) => ({ name: a, K: K[a], minQty: MIN_QTY[a] })), cost = COSTS.base, audit = [];
      const r = backtest(assets, c.spec, { from: FROM, to: TO, ...cost, audit });
      const nextBar = (a, t) => { const KK = K[a], i = KK.findIndex((k) => k.t === t); return KK[i + 1]?.t; };
      const held = {};
      let entries = 0, stops = 0, exits = 0;
      for (const f of audit) {
        const near = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y));
        assert.ok(near(f.fee, f.notional * cost.fee), `${f.asset} ${f.t} fee`);
        if (f.side === "BUY") {
          entries++;
          assert.ok(!held[f.asset], "no second entry while holding");
          held[f.asset] = true;
          assert.equal(f.t, nextBar(f.asset, f.ref.decidedT), "entry fills at the NEXT bar's open after the decision");
          assert.ok(near(f.px, f.ref.open * (1 + cost.slip)), "entry price = open + 0.05 %");
          assert.ok(f.qty >= MIN_QTY[f.asset] && f.notional >= 0.5, "Kraken minimum");
          assert.ok(Math.abs(f.qty * 1e8 - Math.round(f.qty * 1e8)) < 1e-6, "1e-8 lot step");
          assert.ok(f.ref.cashAfter >= -1e-9, "cash never negative");
          assert.ok(f.notional <= f.ref.eqOpen / c.uni.length * (1 + 1e-9), "position cap 1/n of equity");
          assert.ok(near(f.px - f.stop, c.spec.k * f.ref.atr), "initial stop = k x ATR below entry");
          assert.ok(f.qty * (f.px - f.stop) <= (c.spec.r / 100) * f.ref.eqOpen * (1 + 1e-9), "risk at entry <= r % of equity");
        } else {
          assert.ok(held[f.asset], "sell only what is held");
          held[f.asset] = false;
          if (f.kind === "STOP") { stops++; assert.ok(f.ref.low <= f.ref.stop, "stop touched"); assert.ok(near(f.px, Math.min(f.ref.open, f.ref.stop) * (1 - cost.stopSlip)), "stop fill = min(open, stop) - 0.10 %"); }
          else { exits++; assert.equal(f.t, nextBar(f.asset, f.ref.decidedT), "exit fills at the next open"); assert.ok(near(f.px, f.ref.open * (1 - cost.slip)), "exit price = open - 0.05 %"); }
        }
      }
      assert.ok(entries > 20, `enough fills audited (${entries})`);
      assert.ok(Math.abs(r.fees - audit.reduce((s, f) => s + f.fee, 0)) < 1e-9, "reported fees = sum of fill fees");
      console.log(`${name}: ${entries} entries, ${exits} signal exits, ${stops} stops audited; final $${r.final.toFixed(2)}, DD ${r.dd_pct.toFixed(3)} %`);
    });
    it(`${name}: no look-ahead on real data (history truncated at 12 dates gives identical earlier results)`, () => {
      const assets = (cut) => c.uni.map((a) => ({ name: a, K: K[a].filter((k) => k.t < cut), minQty: MIN_QTY[a] }));
      const full = backtest(assets(Infinity), c.spec, { from: FROM, to: TO, ...COSTS.base });
      const byT = new Map(full.curve);
      for (let n = 1; n <= 12; n++) {
        const cut = FROM + Math.floor((TO - FROM) * n / 13 / 864e5) * 864e5;
        const part = backtest(assets(cut), c.spec, { from: FROM, to: TO, ...COSTS.base });
        // every day before the cut's last bar (whose pending order cannot fill in the truncated data) is identical
        for (const [t, eq] of part.curve.slice(0, -1)) assert.equal(eq, byT.get(t), `${new Date(t).toISOString().slice(0, 10)} (cut ${new Date(cut).toISOString().slice(0, 10)})`);
      }
    });
  }
});

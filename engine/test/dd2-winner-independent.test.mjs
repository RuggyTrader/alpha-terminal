// INDEPENDENT re-implementation of the DD2 winner (BTC, 56-day momentum > 5 %, 2 x ATR(14) trailing stop, 0.25 % risk
// per trade, Kraken minimums, 0.40 % fee, 0.05 % / 0.10 % slippage). Shares NO code with src/research/dd2/: its own data
// merge, indicators, execution and accounting, compared with docs/research/dd2/dd2-results.json.
//   ALPHA_DATA=<engine/data> node --test test/dd2-winner-independent.test.mjs   (skips without the git-ignored data)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.ALPHA_DATA ?? null;
const RES = JSON.parse(readFileSync(join(HERE, "..", "..", "docs", "research", "dd2", "dd2-results.json"), "utf8"));

function btc() {
  const m = {};
  for (const f of ["strategy-select/BTC-USD-86400-pre2021.json", "research2/BTC-USD-86400.json"]) { const p = join(DATA, f); if (existsSync(p)) for (const k of JSON.parse(readFileSync(p, "utf8")).candles) m[k.t] = k; }
  return Object.values(m).sort((a, b) => a.t - b.t);
}

/** The winner's rules, written from the pre-registration text. */
function winner(K, start, end) {
  const FEE = 0.004, SLIP = 0.0005, SSLIP = 0.001, RISK = 0.0025, KATR = 2, L = 56, TH = 0.05, MINQ = 0.00006;
  const atrAt = (i) => { if (i < 14) return null; let s = 0; for (let j = i - 13; j <= i; j++) { const k = K[j], pc = K[j - 1].c; s += Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc)); } return s / 14; };
  let cash = 100, qty = 0, stop = 0, best = 0, order = null, hi = 100, ddMax = 0, trades = 0, fees = 0;
  for (let i = 0; i < K.length; i++) {
    const k = K[i];
    if (k.t >= end) break;
    if (k.t < start) continue;
    if (order === "SELL" && qty > 0) { const px = k.o * (1 - SLIP); cash += qty * px * (1 - FEE); fees += qty * px * FEE; qty = 0; trades++; }
    else if (order && order.buy && qty === 0) {
      const px = k.o * (1 + SLIP), dist = KATR * order.atr, eq = cash;
      let q = Math.min(RISK * eq / dist, eq / px, cash / (px * (1 + FEE)));
      q = Math.floor(q * 1e8 + 1e-9) / 1e8;
      if (q >= MINQ && q * px >= 0.5) { cash -= q * px * (1 + FEE); fees += q * px * FEE; qty = q; stop = px - dist; best = k.c; }
    }
    order = null;
    if (qty > 0 && k.l <= stop) { const px = Math.min(k.o, stop) * (1 - SSLIP); cash += qty * px * (1 - FEE); fees += qty * px * FEE; qty = 0; trades++; }
    const eqClose = cash + qty * k.c, eqLow = cash + qty * k.l;
    hi = Math.max(hi, eqClose); ddMax = Math.max(ddMax, 1 - eqLow / hi);
    if (i + 1 >= K.length) continue;
    const a = atrAt(i), mom = i >= L ? k.c / K[i - L].c - 1 : null;
    if (qty > 0) { if (a !== null) { best = Math.max(best, k.c); stop = Math.max(stop, best - KATR * a); } if (mom !== null && mom < 0) order = "SELL"; }
    else if (a !== null && mom !== null && mom > TH) order = { buy: true, atr: a };
  }
  const last = K.filter((k) => k.t < end).at(-1);
  return { final: cash + qty * last.c, dd: ddMax * 100, trades, fees };
}

const have = !!DATA && existsSync(join(DATA, "strategy-select", "BTC-USD-86400-pre2021.json"));
describe("DD2 winner: independent reproduction", { skip: !have && "set ALPHA_DATA to engine/data" }, () => {
  const K = have ? btc() : [];
  const W = RES.candidates[0];
  const P = { train: ["2016-01-01", "2021-01-01"], validation: ["2021-01-01", "2023-07-01"], test: ["2023-07-01", "2026-11-15"] };
  it("the winner is the momentum rule reproduced here", () => assert.equal(W.id, "BTC · M L56 th0.05 k2 trail r0.25% cb0"));
  for (const [p, [a, b]] of Object.entries(P)) it(`${p}: final balance, drawdown, fees and closed trades match`, () => {
    const r = winner(K, Date.parse(a), Date.parse(b)), rep = W[p];
    assert.ok(Math.abs(r.final - rep.final) < 0.006, `final ${r.final} vs ${rep.final}`);
    assert.ok(Math.abs(r.dd - rep.dd_pct) < 0.0006, `dd ${r.dd} vs ${rep.dd_pct}`);
    assert.ok(Math.abs(r.fees - rep.fees) < 0.006, `fees ${r.fees} vs ${rep.fees}`);
    assert.equal(r.trades, rep.trades, "closed trades");
  });
});

// Time-ordered 5-minute reconstruction of the official drawdown (hand-computed cases).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructOfficialDD } from "../src/research/lab/reconstruct.mjs";

const T0 = Date.parse("2024-01-01"), F = 300_000;
const b = (i, h, l, c) => ({ t: T0 + i * F, o: c, h, l, c });
const close = (a, x, tol = 1e-9) => assert.ok(Math.abs(a - x) <= tol, `${a} != ${x}`);

test("time order matters: low before high is not a drawdown from that high", () => {
  // daily candle would be h 110 / l 99 -> the candle bound assumes 110 then 99 = 10 %
  const bars = [b(0, 101, 99, 100), b(1, 110, 105, 106), b(2, 106, 104, 106)];
  const audit = [{ t: T0, asset: "X", side: "BUY", kind: "ENTRY", px: 100, qty: 1, notional: 100, fee: 0 }];
  const r = reconstructOfficialDD(audit, { X: bars }, { capital: 100, from: T0, to: T0 + 3 * F });
  close(r.dd_official_5m_pct, (1 - 104 / 110) * 100); // 5.45 %: the third bar's low (104) after the 110 high; not 10 %
  close(r.final_marked, 106);
});

test("a stop exit is placed in the 5-minute bar that reached it and marked at its fill price", () => {
  const bars = [b(0, 100, 99, 99.5), b(1, 99.5, 97.5, 97.6), b(2, 98, 90, 91)];
  const audit = [
    { t: T0, asset: "X", side: "BUY", kind: "ENTRY", px: 100, qty: 1, notional: 100, fee: 0 },
    { t: T0, asset: "X", side: "SELL", kind: "STOP", px: 97.9, qty: 1, notional: 97.9, fee: 0, ref: { stop: 98 } },
  ];
  const r = reconstructOfficialDD(audit, { X: bars }, { capital: 100, from: T0, to: T0 + 3 * F });
  close(r.dd_official_5m_pct, (1 - 97.9 / 100) * 100); // not 97.5 (after the fill) and not 90 (position already sold)
  close(r.final_marked, 97.9); assert.equal(r.unresolved_stops, 0);
});

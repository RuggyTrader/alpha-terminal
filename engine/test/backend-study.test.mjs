import assert from 'node:assert/strict';
import { it } from 'node:test';
import { closedWithin, describeTrades, validateVariant } from '../research/backend-study.mjs';

it('research rejects unknown inputs and never scores a trade whose exit crosses the split', () => {
  assert.throws(() => validateVariant({ id: 'RESEARCH-TEST', tf: 60, overrides: { tp2EXt: -0.55 } }), /Unknown strategy input/);
  const ts = [{ entryTime: 1, exitTime: 9 }, { entryTime: 9, exitTime: 11 }, { entryTime: 10, exitTime: 19 }];
  assert.deepEqual(closedWithin(ts, 0, 10), [ts[0]]);
  assert.deepEqual(closedWithin(ts, 10, 20), [ts[2]]);
});

it('research costs reconcile gross, two fill fees, spread/slippage and net separately', () => {
  const r = describeTrades([{ gross: 2, entryNotional: 100, exitNotional: 102, holdMin: 60, movePct: 2, stopPct: 1, tpPct: 2 }], { fee_pct_per_fill: 0.2, spread_pct_per_side: 0.01, slippage_pct_per_side: 0.02, reference_risk_usd: 10, capital_usd: 1000 });
  assert.equal(r.gross, 2); assert.equal(r.fees, 0.4); // displayed cents; exact fee is $0.404
  assert.equal(r.spread_slippage_usd, 0.0606);
  assert.equal(r.net, 1.54); // $2 - $0.404 - $0.0606, rounded for display
  assert.equal(r.net_win_rate, 1);
  assert.equal(r.total_traded_notional, 202);
});

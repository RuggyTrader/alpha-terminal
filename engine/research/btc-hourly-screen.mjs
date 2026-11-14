// One fixed baseline screen on newly downloaded Kraken OHLC. No tuning; not a deployable profile.
// node engine/research/btc-hourly-screen.mjs /tmp/alpha-btc-public.json
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { profileInputs } from '../src/cli/fleet-backtest.mjs';
import { referenceTrades } from '../src/cli/economics.mjs';
import { closedWithin, describeTrades } from './backend-study.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (raw.error?.length) throw new Error(JSON.stringify(raw.error));
const rows = (Array.isArray(raw.rows) ? raw.rows : Object.entries(raw.result ?? {}).find(([k, v]) => k !== 'last' && Array.isArray(v))?.[1]);
if (!rows?.length) throw new Error('No provider rows');
// Kraken's last OHLC row is forming, regardless of when the request is made; never backtest it.
const completed = Array.isArray(raw.rows) ? rows : rows.slice(0, -1);
const candles = completed.map(([t, o, h, l, c]) => ({ t: Number(t) * 1000, o: +o, h: +h, l: +l, c: +c }));
for (let i = 0; i < candles.length; i++) {
  const k = candles[i];
  if (!(k.l > 0 && k.l <= Math.min(k.o, k.c) && k.h >= Math.max(k.o, k.c)) || (i && k.t <= candles[i - 1].t)) throw new Error('Invalid provider candle');
}
const inputs = { ...profileInputs(root, 'btcusd-5m'), riskUSD: 10 };
const cfg = { fee_pct_per_fill: 0.2, spread_pct_per_side: 0.01, slippage_pct_per_side: 0.02, reference_risk_usd: 10, capital_usd: 1000 };
const validation = Date.parse('2026-11-01T00:00:00Z');
// Earlier project parity had seen 13 Nov through 00:20 UTC. Begin the tiny fresh slice after that.
const fresh = Date.parse('2026-11-13T01:00:00Z');
const end = candles.at(-1).t + 3600000;
const replay = c => referenceTrades({ candles: c, symbol: 'BTCUSD', intervalMin: 60, inputs, fromMs: null, fill: { limitThroughTicks: 1, tick: 0.1 } });
const training = describeTrades(replay(candles.filter(k => k.t < validation)), cfg);
// No settings are selected or changed after the training run.
const trades = replay(candles);
const report = {
  id: 'RESEARCH-BE13-BTC-H60-DATA-SCREEN', label: 'RESEARCH ONLY; original BTC 5m inputs on 1h candles; no tuning and no activation',
  market: 'KRAKEN:BTCUSD', timeframe_min: 60, exact_inputs: inputs, costs: cfg,
  source: { url: 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60', fetched_at: raw.fetched_at ?? new Date(statSync(process.argv[2]).mtimeMs).toISOString(),
    provider_rows: raw.provider_rows ?? rows.length, completed_candles: candles.length, excluded_forming_rows: raw.excluded_forming_rows ?? 1,
    first: new Date(candles[0].t).toISOString(), last_completed: new Date(candles.at(-1).t).toISOString(),
    rows_sha256: createHash('sha256').update(JSON.stringify(completed)).digest('hex'),
    note: 'Public Kraken OHLC download. No interpolation. Does not cover the 103-day BTC dataset cited by earlier reports.' },
  training_reused: { from: new Date(candles[0].t).toISOString(), to_exclusive: new Date(validation).toISOString(), ...training },
  validation_reused: { from: new Date(validation).toISOString(), to_exclusive: new Date(fresh).toISOString(), ...describeTrades(closedWithin(trades, validation, fresh), cfg) },
  fresh_slice: { from: new Date(fresh).toISOString(), to_exclusive: new Date(end).toISOString(), candles: candles.filter(k => k.t >= fresh).length,
    ...describeTrades(closedWithin(trades, fresh, end), cfg), warning: 'Only about one day of fresh hourly candles. Too short for a meaningful final test; no robustness/profitability inference.' },
  recommendation: 'NONE: limited sample, no statistically useful untouched final period, and no configuration optimization performed.',
};
writeFileSync(join(root, 'research/public-BTCUSD-60m-2026-11-13.json'), JSON.stringify({ ...report.source, rows: completed }, null, 1) + '\n');
writeFileSync(join(root, '../docs/research/backend-btc-hourly-2026-11-13.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ source: report.source, training_trades: report.training_reused.trades, training_net: report.training_reused.net, validation_trades: report.validation_reused.trades, validation_net: report.validation_reused.net, fresh_trades: report.fresh_slice.trades, fresh_net: report.fresh_slice.net }));

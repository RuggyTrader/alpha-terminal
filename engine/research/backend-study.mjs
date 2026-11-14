// Reproducible, exploratory cost study. Original profiles and live engine are never written.
// node research/backend-study.mjs --out ../docs/research/backend-2026-11-13.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { profileInputs, runFleetBacktest } from '../src/cli/fleet-backtest.mjs';
import { aggregate } from '../src/cli/research.mjs';
import { referenceTrades, economics } from '../src/cli/economics.mjs';
import { regimes } from '../src/cli/research-variants.mjs';
import { DEFAULT_INPUTS } from '../src/ote.mjs';

export function validateVariant(v) {
  if (!/^RESEARCH-/.test(v.id) || ![15, 30, 60].includes(v.tf)) throw new Error('invalid RESEARCH identifier/timeframe');
  for (const k of Object.keys(v.overrides)) if (!Object.hasOwn(DEFAULT_INPUTS, k)) throw new Error(`Unknown strategy input: ${k}`);
}

// Attribute each trade only after its exit is known; a trade crossing a split is disclosed and excluded.
export function closedWithin(trades, start, end) {
  return trades.filter(t => t.entryTime >= start && t.exitTime < end);
}

export function describeTrades(trades, cfg) {
  const drag = (cfg.spread_pct_per_side + cfg.slippage_pct_per_side) / 100;
  const costs = trades.map(t => ({ ...t, gross: t.gross - (t.entryNotional + t.exitNotional) * drag }));
  const econ = economics(costs, cfg.fee_pct_per_fill, cfg.reference_risk_usd);
  const original = economics(trades, cfg.fee_pct_per_fill, cfg.reference_risk_usd);
  const round = v => Math.round(v * 1e6) / 1e6;
  let consecutive = 0, maxLosses = 0, equity = cfg.capital_usd, peak = equity, ddPct = 0;
  for (const t of costs) {
    const net = t.gross - (t.entryNotional + t.exitNotional) * cfg.fee_pct_per_fill / 100;
    consecutive = net < 0 ? consecutive + 1 : 0; maxLosses = Math.max(maxLosses, consecutive);
    equity += net; peak = Math.max(peak, equity); ddPct = Math.max(ddPct, (peak - equity) / peak * 100);
  }
  return { ...econ, gross: original.gross, fees: original.fees,
    gross_profit_factor: original.gross_profit_factor, gross_expectancy: original.gross_expectancy,
    avg_gross_per_trade: original.avg_gross_per_trade, avg_win: original.avg_win, avg_loss: original.avg_loss,
    fee_to_gross_profit: original.fee_to_gross_profit,
    spread_slippage_usd: round(trades.reduce((s, t) => s + (t.entryNotional + t.exitNotional) * drag, 0)),
    total_traded_notional: round(trades.reduce((s, t) => s + t.entryNotional + t.exitNotional, 0)),
    gross_win_rate: original.win_rate, net_win_rate: trades.length ? costs.filter(t => t.gross - (t.entryNotional + t.exitNotional) * cfg.fee_pct_per_fill / 100 > 0).length / trades.length : null,
    max_consecutive_losses: maxLosses, max_closed_drawdown_pct_on_reference_capital: round(ddPct),
    reference_capital_usd: cfg.capital_usd, reference_risk_usd: cfg.reference_risk_usd,
    avg_hold_min: original.avg_hold_min,
    break_even_fee_pct_per_fill_before_spread_slippage: original.break_even_fee_pct_per_fill,
    fee_sensitivity: [0, 0.02, 0.05, 0.1, 0.2].map(fee => ({ hypothetical_fee_pct_per_fill: fee, net: economics(costs, fee).net })),
    hold_duration: [[0, 60], [60, 240], [240, Infinity]].map(([a, b]) => {
      const raw = economics(trades.filter(t => t.holdMin >= a && t.holdMin < b), cfg.fee_pct_per_fill);
      const net = economics(costs.filter(t => t.holdMin >= a && t.holdMin < b), cfg.fee_pct_per_fill);
      return { minutes: [a, Number.isFinite(b) ? b : null], trades: raw.trades, gross: raw.gross, fees: raw.fees,
        net: net.net, max_drawdown_net: net.max_drawdown_net, net_expectancy: net.net_expectancy,
        break_even_fee_pct_per_fill: net.break_even_fee_pct_per_fill };
    }),
  };
}

export function runStudy() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const cfg = JSON.parse(readFileSync(join(root, 'research/backend-2026-11-13.json')));
  const file = join(root, 'test/fixtures/SOLUSD-5m-150d.rows.json.gz');
  const doc = JSON.parse(gunzipSync(readFileSync(file)));
  const hash = createHash('sha256').update(JSON.stringify(doc.rows)).digest('hex');
  if (hash !== doc.rows_sha256) throw new Error('candle checksum mismatch');
  const base = doc.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const input = { ...profileInputs(root, cfg.base_profile), riskUSD: cfg.reference_risk_usd };
  const trainEnd = Date.parse(cfg.train_end), validationEnd = Date.parse(cfg.validation_end);
  const lastEnd = base.at(-1).t + 300000;
  const replay = (v, end) => {
    validateVariant(v);
    const candles = aggregate(base.filter(k => k.t < end), v.tf);
    return referenceTrades({ candles, symbol: 'SOLUSD', intervalMin: v.tf, inputs: { ...input, ...v.overrides }, fromMs: null, fill: { limitThroughTicks: 1, tick: 0.01 } });
  };
  // Rank using TRAINING ONLY; later candles have not been replayed at selection time.
  const training = cfg.variants.map(v => ({ ...v, exact_inputs: { ...input, ...v.overrides }, training: describeTrades(replay(v, trainEnd), cfg) }));
  const ranked = training.filter(v => v.training.trades >= cfg.min_training_trades).sort((a, b) => b.training.net - a.training.net || a.id.localeCompare(b.id));
  const selected = ranked[0] ?? null;
  let diagnostics = null;
  if (selected) {
    const tr = replay(selected, lastEnd);
    const segment = (a, b) => describeTrades(closedWithin(tr, a, b), cfg);
    const candles = aggregate(base, selected.tf);
    const funded = runFleetBacktest({ bots: [{ id: selected.id, group: 'SOLANA', priority: 1, symbol: 'SOLUSD', intervalMin: selected.tf, inputs: selected.exact_inputs, candles, riskUSD: cfg.reference_risk_usd }], main: cfg.capital_usd, allocations: [{ group: 'SOLANA', amountUsd: cfg.capital_usd }], feePct: cfg.fee_pct_per_fill, slippagePct: cfg.spread_pct_per_side + cfg.slippage_pct_per_side, fromMs: trainEnd });
    diagnostics = {
      validation_reused: segment(trainEnd, validationEnd), later_diagnostic_reused: segment(validationEnd, lastEnd),
      split_crossing_trades_excluded: tr.filter(t => [trainEnd, validationEnd].some(b => t.entryTime < b && t.exitTime >= b)).length,
      by_month: Object.fromEntries([...new Set(tr.map(t => new Date(t.exitTime).toISOString().slice(0, 7)))].map(m => [m, describeTrades(tr.filter(t => new Date(t.exitTime).toISOString().startsWith(m)), cfg)])),
      funded_paper_model_validation_and_later: funded,
    };
  }
  return {
    label: 'EXPLORATORY RESEARCH ONLY; no untouched final test; no activation or profitability recommendation',
    method: cfg, market: 'KRAKEN:SOLUSD', source: { file: 'engine/test/fixtures/SOLUSD-5m-150d.rows.json.gz', source: doc.source, fetched_at: doc.fetchedAt, rows_sha256: hash, first: new Date(base[0].t).toISOString(), last: new Date(base.at(-1).t).toISOString(), raw_candles: base.length, checks: doc.check },
    assumptions: { funded_model_scope: 'Existing FleetLedgerSim model (candle-close reference plus 0.03% adverse adjustment), separate from conservative reference fills. Does not replay HTTP timing or the new server-side stop-risk recheck; not exact post-fix execution parity.', reference: 'Fixed $10 planned stop risk, unlimited buying power. $1000 is the drawdown denominator, not proof that every reference trade is affordable. Funded simulation is separately reported.', costs: '0.20% every fill, plus assumed 0.01% spread and 0.02% slippage per side. Not measured venue spreads. No maker discount.', fills: 'Must trade one tick through the limit. Ambiguous intrabar path follows existing broker emulator. Missing 5m intervals are not fabricated; incomplete higher-timeframe buckets excluded.', drawdown: 'Closed-trade only; intratrade drawdown may be larger. No claim of under 1% drawdown.', selection: 'Highest training net among candidates with >=20 training trades; a negative best result remains a rejection.' },
    training, selected_id_on_training_only: selected?.id ?? null, selected_training_net_positive: (selected?.training.net ?? -Infinity) > 0,
    diagnostics, final_untouched_test: { status: 'NOT_AVAILABLE', reason: cfg.history_warning },
    recommendation: 'NONE. All results require fresh untouched data and adequate trade counts before further PAPER observation can be recommended.',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runStudy();
  const out = process.argv[process.argv.indexOf('--out') + 1];
  if (process.argv.includes('--out')) writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ training: result.training.map(v => ({ id: v.id, trades: v.training.trades, gross: v.training.gross, net: v.training.net })), selected: result.selected_id_on_training_only, validation: result.diagnostics?.validation_reused, later: result.diagnostics?.later_diagnostic_reused, recommendation: result.recommendation }));
}

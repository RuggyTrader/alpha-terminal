// Read-only report of the forward PAPER trial (GET /api/dashboard/trial) and its one-time owner activation.
// Everything here is the ISOLATED research account; it is never added to the portfolio's figures.
import { PARAMS } from "./ma50";
import { ACCOUNT_ID } from "./trial";

const usd = (m: number | null | undefined) => (m === null || m === undefined ? null : Math.round(m) / 1e6);
const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/** Round-2 research figures of this exact rule (historical backtest; NOT forward results). */
export const RESEARCH_REFERENCE = Object.freeze({
  label: "Historical backtest (research round 2), Coinbase daily candles, $100, 2 % risk, 0.20 % fee + 0.05 % slippage",
  periods: [
    { name: "Development 2021-07 to 2023-12", net_usd: 21.1, trades: 30, profit_factor: 2.55, win_rate: 0.333, max_dd_pct: 11.5 },
    { name: "Validation 2024-01 to 2025-06", net_usd: 13.43, trades: 25, profit_factor: 2.48, win_rate: 0.2, max_dd_pct: 6.7 },
    { name: "Final test 2025-07 to 2026-11", net_usd: 4.12, trades: 19, profit_factor: 1.57, win_rate: 0.211, max_dd_pct: 6.5 },
  ],
  trades_per_year: 11,
});

function bootstrapCi(nets: number[]) {
  if (nets.length < 5) return null;
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ms: number[] = [];
  for (let b = 0; b < 2000; b++) { let s = 0; for (let j = 0; j < nets.length; j++) s += nets[Math.floor(rnd() * nets.length)]; ms.push(s / nets.length); }
  ms.sort((a, b) => a - b);
  return [r2(ms[50]), r2(ms[1949])];
}

/** What the data can establish about a simulated fill: the candle it happened in (not an exact time inside it), the
 *  candle size, and whether it was reconstructed after a gap in processing (coarser candles or recorded late). */
export function evidence(candleT: number, intervalMin: number, lateMin: number) {
  const reconstructed = intervalMin > 1 || lateMin > 5;
  return { candle_from: new Date(candleT).toISOString(), candle_to: new Date(candleT + intervalMin * 60_000).toISOString(), interval_min: intervalMin, recorded_late_min: lateMin,
    kind: reconstructed ? "RECONSTRUCTED" : "NORMAL",
    note: reconstructed ? `reconstructed after an outage from ${intervalMin}-minute candles; the price was reached within this candle, the exact time is not known`
      : "within this 1-minute candle (simulated; not an exchange execution)" };
}

export async function trialReport(db: D1Database) {
  const has = await db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'trial_accounts'`).first().catch(() => null);
  if (!has) return { available: false };
  const a = await db.prepare(`SELECT * FROM trial_accounts WHERE account_id = ?`).bind(ACCOUNT_ID).first<Record<string, unknown>>();
  if (!a) return { available: false };
  const closed = (await db.prepare(`SELECT * FROM trial_positions WHERE account_id = ? AND status = 'CLOSED' ORDER BY closed_at`).bind(ACCOUNT_ID).all<Record<string, number & string>>()).results;
  const open = await db.prepare(`SELECT * FROM trial_positions WHERE account_id = ? AND status = 'OPEN'`).bind(ACCOUNT_ID).first<Record<string, number & string>>();
  const eq = (await db.prepare(`SELECT day_t, close, cash_micro, position_qty, equity_micro FROM trial_equity WHERE account_id = ? ORDER BY day_t`).bind(ACCOUNT_ID).all<Record<string, number>>()).results;
  const orders = (await db.prepare(`SELECT order_id, kind, status, reason, signal_candle_t, signal_close, accepted_at, fill_candle_t, fill_interval_min, ref_price, fill_price, qty, fee_micro, code FROM trial_orders WHERE account_id = ? ORDER BY accepted_at DESC LIMIT 20`).bind(ACCOUNT_ID).all()).results;
  const events = (await db.prepare(`SELECT at, kind, detail_json FROM trial_events WHERE account_id = ? ORDER BY id DESC LIMIT 20`).bind(ACCOUNT_ID).all()).results;
  const start = Number(a.start_equity_micro), cash = Number(a.cash_micro);
  const mark = eq.at(-1)?.close ?? null;
  const posValue = open && mark ? Math.round(open.qty * mark * 1e6) : open ? Number(open.cost_micro) : 0;
  const equity = cash + posValue;
  const nets = closed.map((p) => Number(p.net_micro) / 1e6);
  const wins = nets.filter((v) => v > 0), losses = nets.filter((v) => v <= 0);
  let streak = 0, worst = 0; for (const v of nets) { streak = v <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  let peak = start, dd = 0, ddPct = 0;
  for (const e of eq) { peak = Math.max(peak, e.equity_micro); dd = Math.max(dd, peak - e.equity_micro); ddPct = Math.max(ddPct, (peak - e.equity_micro) / peak); }
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  const fees = sum(closed.map((p) => Number(p.entry_fee_micro) + Number(p.exit_fee_micro))) / 1e6;
  const f = PARAMS.feePct / 100;
  const bh = eq.length ? (() => { const units = 100 / (eq[0].close * (1 + f)); return { net_usd: r2(units * eq.at(-1)!.close * (1 - f) - 100), from_close: eq[0].close, to_close: eq.at(-1)!.close }; })() : null;
  return {
    available: true, label: "Forward PAPER trial — a separate research account; not part of your portfolio, its P&L or its funding",
    account: { id: a.account_id, name: a.name, status: a.status, strategy: a.strategy, activated_at: a.activated_at, last_run_at: a.last_run_at, last_error: a.last_error },
    settings: { ...PARAMS, frozen: true },
    execution: { orders: "market orders at the open of the first Kraken candle starting after acceptance", stops: "simulated stop-market, checked on 1-minute Kraken candles by the always-on Worker (not an exchange-native order)",
      slippage_pct: PARAMS.slipPct, fee_pct_per_fill: PARAMS.feePct },
    equity: { start_usd: usd(start), cash_usd: usd(cash), position_value_usd: usd(posValue), equity_usd: usd(equity), net_usd: r2((equity - start) / 1e6), marked_at_close: mark },
    trades: {
      completed: closed.length, gross_usd: r2(sum(closed.map((p) => Number(p.gross_micro))) / 1e6), fees_usd: r2(fees), net_usd: r2(sum(nets)),
      win_rate: closed.length ? r2(wins.length / closed.length) : null, profit_factor: losses.length && sum(losses) < 0 ? r2(sum(wins) / -sum(losses)) : null,
      avg_net_usd: closed.length ? r2(sum(nets) / closed.length) : null, avg_net_ci95: bootstrapCi(nets),
      avg_hold_days: closed.length ? r2(sum(closed.map((p) => (Number(p.exit_candle_t) - Number(p.opened_candle_t)) / 86_400_000)) / closed.length) : null,
      longest_losing_streak: worst, avg_risk_usd: closed.length ? r2(sum(closed.map((p) => Number(p.risk_usd))) / closed.length) : null,
      recorded_late: closed.filter((p) => Number(p.recorded_late_min) > 5).length,
      evidence: closed.length < 30 ? `${closed.length} of 30 completed trades: not yet an initial evidence milestone` : "30+ completed trades: an initial milestone, not proof",
      list: closed.slice(-20).map((p) => ({ opened_at: p.opened_at, entry: p.entry_price, exit: p.exit_price, qty: p.qty, reason: p.exit_reason, net_usd: usd(Number(p.net_micro)), exit_evidence: evidence(Number(p.exit_candle_t), Number(p.exit_interval_min), Number(p.recorded_late_min)) })),
    },
    open_position: open ? { opened_at: open.opened_at, qty: open.qty, entry: open.entry_price, stop: open.stop, initial_stop: open.initial_stop, risk_at_entry_usd: r2(Number(open.risk_usd)),
      open_risk_usd: mark ? r2(Math.max(0, mark - Number(open.stop)) * Number(open.qty)) : null, mark } : null,
    drawdown: { max_usd: r2(dd / 1e6), max_pct: r2(ddPct * 100), basis: "daily closes" },
    time_in_cash_pct: eq.length ? r2((eq.filter((e) => !e.position_qty).length / eq.length) * 100) : null,
    benchmarks: { cash: { net_usd: 0 }, buy_and_hold_btc: bh, research: RESEARCH_REFERENCE },
    equity_curve: eq.map((e) => [e.day_t, Math.round(e.equity_micro) / 1e6]),
    orders, events,
  };
}

/** One-time owner activation (passphrase checked by the caller): PROPOSED -> ACTIVE. Idempotent. */
export async function activateTrial(db: D1Database) {
  const a = await db.prepare(`SELECT status FROM trial_accounts WHERE account_id = ?`).bind(ACCOUNT_ID).first<{ status: string }>().catch(() => null);
  if (!a) return { ok: false, code: "TRIAL_NOT_INSTALLED", message: "the trial account does not exist (migration 0008 not applied)" };
  if (a.status === "ACTIVE") return { ok: true, duplicate: true, status: "ACTIVE" };
  if (a.status !== "PROPOSED") return { ok: false, code: "TRIAL_NOT_PROPOSED", message: `the trial is ${a.status}` };
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE trial_accounts SET status = 'ACTIVE', activated_at = ? WHERE account_id = ? AND status = 'PROPOSED'`).bind(now, ACCOUNT_ID),
    db.prepare(`INSERT INTO trial_events (account_id, at, kind, detail_json) VALUES (?, ?, 'ACTIVATED', ?)`).bind(ACCOUNT_ID, now, JSON.stringify({ by: "owner (passphrase)" })),
  ]);
  return { ok: true, status: "ACTIVE", activated_at: now, note: "the first decision is made at the first daily close (00:00 UTC) after activation" };
}

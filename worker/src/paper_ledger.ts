// ALPHA PAPER ledger: internal simulated positions, fills, trades and activity in D1.
//
// An accepted DRY-RUN order intent is "filled" at the truthful reference price the risk decision used.
// These are NOT broker positions: no broker is contacted, and nothing from Alpaca is read here; the risk
// account for this path (balance, exposure, today's P&L) also comes from D1 (ledgerRiskSnapshot).
// Marks come only from the instrument's configured source; when that fails the last mark is kept and
// flagged, never estimated.

import { buyStatements, fromMicro, isStrategyWallet, sellStatements } from "./portfolio";
import type { RiskAccount } from "./trade_core";
import { feeSchemaReady } from "./fee_compat";
import {
  getInstrument,
  referencePrices,
  type Instrument,
  type MarketDataConfig,
} from "./instruments";

export interface LedgerEnv extends MarketDataConfig {
  DB: D1Database;
  PAPER_MARK_MIN_INTERVAL_SECONDS?: string;
  PAPER_MARK_STALE_SECONDS?: string;
}

export const LEDGER_LABEL = "ALPHA PAPER";

// Quantities are stored as REAL; this absorbs float noise when a reduction empties a position.
const QTY_EPSILON = 1e-9;

export interface PositionRow {
  id: number;
  symbol: string;
  side: string;
  status: "OPEN" | "CLOSED";
  qty: number;
  avg_entry_price: number;
  multiplier: number;
  strategy: string | null;
  opened_at: string;
  closed_at: string | null;
  entry_qty_total: number;
  entry_value_total: number;
  exit_qty_total: number;
  exit_value_total: number;
  realized_pnl: number;
  mark_price: number | null;
  mark_at: string | null;
  mark_source: string | null;
  mark_error: string | null;
  mark_error_at: string | null;
  logged_unrealized_pnl: number | null;
  open_alert_id: string;
  open_order_id: string;
  last_order_id: string;
  close_alert_id: string | null;
  close_order_id: string | null;
  updated_at: string;
  // PAPER portfolio (migration 0003): funding balance and reserved cost basis; null wallet = not in the portfolio.
  wallet?: string | null;
  reserved_micro?: number;
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(round(n)).toFixed(2)}`;
const fmtQty = (n: number) => String(round(n, 8));
const fmtPrice = (n: number) => String(round(n, 8));
const signedPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;

// ============================================================
// ACTIVITY
// ============================================================

export interface ActivityInput {
  category: "alert" | "risk" | "order" | "paper" | "market" | "system";
  level: "info" | "success" | "warn" | "error";
  message: string;
  alertId?: string | null;
  symbol?: string | null;
  action?: string | null;
  strategy?: string | null;
  qty?: number | string | null;
  validationResult?: string | null;
  riskResult?: string | null;
  rejectionReason?: string | null;
  errorDetail?: string | null;
  positionId?: number | null;
}

function activityStatement(env: LedgerEnv, e: ActivityInput, ts = new Date().toISOString()): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO activity_events
      (ts, category, level, message, alert_id, symbol, action, strategy, qty,
       validation_result, risk_result, rejection_reason, error_detail, position_fk)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    ts,
    e.category,
    e.level,
    e.message.slice(0, 500),
    e.alertId ?? null,
    e.symbol ?? null,
    e.action ?? null,
    e.strategy ?? null,
    e.qty === null || e.qty === undefined ? null : String(e.qty),
    e.validationResult ?? null,
    e.riskResult ?? null,
    e.rejectionReason ?? null,
    e.errorDetail ?? null,
    e.positionId ?? null
  );
}

/** Persists one activity event. Logging never breaks the trading pipeline. */
export async function logActivity(env: LedgerEnv, e: ActivityInput): Promise<void> {
  try {
    await activityStatement(env, e).run();
  } catch {
    /* activity is a log; the alert/risk/order records remain the evidence */
  }
}

// ============================================================
// RISK SNAPSHOT (ledger positions, not broker positions)
// ============================================================

/** Ledger positions in the shape the risk engine reads (qty, qty_available, market_value). */
export async function ledgerRiskSnapshot(env: LedgerEnv, symbol: string) {
  const rows = (
    await env.DB.prepare(`SELECT * FROM paper_positions WHERE status = 'OPEN'`).all<PositionRow>()
  ).results;
  const shape = (p: PositionRow): Record<string, unknown> => ({
    symbol: p.symbol,
    qty: p.qty,
    qty_available: p.qty,
    // Valued at the last truthful mark (the fill price at worst), never an estimate.
    market_value: p.qty * (p.mark_price ?? p.avg_entry_price) * p.multiplier,
  });
  const own = rows.find((p) => p.symbol === symbol);
  return { position: own ? shape(own) : null, positions: rows.map(shape), account: await ledgerAccount(env, symbol, rows) };
}

/**
 * The ALPHA PAPER account for risk, from D1 only (no broker):
 *  - buying power = the symbol's strategy balance, available funds (no leverage). A balance never funded is $0;
 *    a symbol with no strategy balance has $0; a missing balance row is unknown (rejected, never assumed).
 *  - today's P&L = PAPER P&L realized since 00:00 UTC today + the unrealized P&L of open positions at their last
 *    truthful mark (conservative: an older open loss counts today). If an open position's mark failed, today's P&L
 *    is unknown and new entries are rejected until it is marked again.
 *  - long-only: the ledger never holds a short.
 */
async function ledgerAccount(env: LedgerEnv, symbol: string, open: PositionRow[]): Promise<RiskAccount> {
  const strategy = isStrategyWallet(symbol);
  const w = strategy
    ? await env.DB.prepare(`SELECT available_micro FROM portfolio_wallets WHERE wallet = ?`).bind(symbol).first<{ available_micro: number }>()
    : null;
  const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00`;
  // Schema 4: fees charged earlier today (before a rollback) still count as realized losses for the daily limit.
  const ready = await feeSchemaReady(env.DB);
  const realized = await env.DB.prepare(
    `SELECT COALESCE(SUM(realized_pnl), 0)${ready ? " - COALESCE(SUM(fee_micro), 0) / 1000000.0" : ""} AS pnl FROM paper_fills WHERE filled_at >= ?`
  ).bind(dayStart).first<{ pnl: number }>();
  const unmarked = open.filter((p) => p.mark_error !== null);
  const unrealized = open.reduce((s, p) => s + ((p.mark_price ?? p.avg_entry_price) - p.avg_entry_price) * p.qty * p.multiplier, 0);
  const reasons: string[] = [];
  if (strategy && !w) reasons.push(`the ${symbol} PAPER balance was not found`);
  if (unmarked.length) reasons.push(`no current mark for the open ${unmarked.map((p) => p.symbol).join(", ")} PAPER position (today's P&L is unknown)`);
  return {
    source: "ALPHA_PAPER_D1",
    status: "ACTIVE",
    blocked: false,
    shortingEnabled: false,
    buyingPower: !strategy ? 0 : w ? fromMicro(w.available_micro) : null,
    buyingPowerLabel: strategy ? `${symbol} PAPER balance available` : `PAPER balance (${symbol} has no strategy balance)`,
    insufficientCode: "INSUFFICIENT_PAPER_CAPITAL",
    todaysPnl: unmarked.length || realized === null ? null : Math.round((Number(realized.pnl) + unrealized) * 1e6) / 1e6,
    todaysPnlLabel: "ALPHA PAPER realized today (UTC) + open unrealized",
    ...(reasons.length ? { unavailableReason: `ALPHA PAPER account data unavailable: ${reasons.join("; ")}; nothing is assumed` } : {}),
  };
}

// ============================================================
// FILLS
// ============================================================

export interface DryRunCommit {
  alertId: string;
  alertFk: number | null;
  clientOrderId: string;
  riskDecisionId: number | null;
  symbol: string;
  action: "buy" | "sell" | "close";
  side: "buy" | "sell";
  qty: number;
  price: number;
  priceSource: string;
  priceAt: string;
  strategy: string;
  orderType: "market";
  timeInForce: "day";
}

export type CommitResult =
  | {
      ok: true;
      kind: "OPEN" | "ADD" | "REDUCE" | "CLOSE";
      order: Record<string, unknown>;
      fill: Record<string, unknown>;
      position: PositionRow;
      trade: Record<string, unknown> | null;
    }
  | { ok: false; code: string; message: string; committed: boolean };

// One row is always selected: when the position guard does not match, p.* is NULL and the NOT NULL
// columns of paper_fills reject the insert, which rolls back the whole batch.
const FILL_FROM_POSITION = `
  INSERT INTO paper_fills
    (order_fk, client_order_id, alert_id, risk_decision_fk, position_fk, symbol, side, kind, qty, price,
     price_source, price_at, realized_pnl, position_qty_after, avg_entry_after, filled_at)
  SELECT (SELECT id FROM orders WHERE client_order_id = ?), ?, ?, ?, p.id, p.symbol, ?, %KIND%, ?, ?, ?, ?,
     %REALIZED%, p.qty, p.avg_entry_price, ?
  FROM (SELECT 1) AS one
  LEFT JOIN paper_positions p ON %WHERE% AND p.last_order_id = ?`;

// Fee-compatible rollback: the trade insert on schema 4. Same bind order as the schema-3 statement (position id, order id).
const FEE_AWARE_TRADE_INSERT = `INSERT INTO trades
    (symbol, direction, status, strategy, open_alert_id, open_order_id, close_order_id,
     entry_qty, entry_avg_price, exit_qty, exit_avg_price, open_qty, closed_cost_basis,
     realized_pnl, return_pct, opened_at, closed_at, leg_order_ids_json,
     source, position_fk, close_alert_id, price_sources,
     gross_pnl, fees_usd, slippage_usd, cost_profile)
   SELECT p.symbol, 'LONG', 'CLOSED', p.strategy, p.open_alert_id, p.open_order_id, p.close_order_id,
     round(p.entry_qty_total, 8), round(p.entry_value_total / p.entry_qty_total, 8),
     round(p.exit_qty_total, 8), round(p.exit_value_total / p.exit_qty_total, 8), '0',
     round(p.entry_value_total * p.multiplier, 8),
     round(p.realized_pnl - p.fees_micro / 1000000.0, 8),
     round((p.realized_pnl - p.fees_micro / 1000000.0) / (p.entry_value_total * p.multiplier) * 100, 6),
     p.opened_at, p.closed_at,
     (SELECT json_group_array(client_order_id) FROM (SELECT client_order_id FROM paper_fills WHERE position_fk = p.id ORDER BY id)),
     'ALPHA_PAPER', p.id, p.close_alert_id,
     (SELECT group_concat(DISTINCT price_source) FROM paper_fills WHERE position_fk = p.id),
     round(p.realized_pnl + p.slippage_micro / 1000000.0, 8), round(p.fees_micro / 1000000.0, 8),
     round(p.slippage_micro / 1000000.0, 8), 'none'
   FROM (SELECT 1) AS one
   LEFT JOIN paper_positions p ON p.id = ? AND p.last_order_id = ? AND p.status = 'CLOSED'`;

/**
 * Commits one approved DRY-RUN signal as ONE D1 batch (a single transaction):
 *   order intent → position change → simulated fill → (trade on full close) → alert DRY_RUN_ACCEPTED.
 * Either all of it is durable or none of it is. The position change is guarded (BUY: the one OPEN row;
 * SELL/CLOSE: the exact row version read, via last_order_id), and the fill insert fails unless that guarded
 * change happened, so a concurrent change or an injected failure rolls everything back. Order intents and
 * fills are UNIQUE per alert, so a retry can never apply twice.
 */
export async function commitDryRun(env: LedgerEnv, f: DryRunCommit): Promise<CommitResult> {
  const instrument = getInstrument(f.symbol);
  if (!instrument) return { ok: false, code: "INVALID_SYMBOL", message: `${f.symbol} is not a supported instrument`, committed: false };
  if (!(f.price > 0) || !(f.qty > 0)) {
    return { ok: false, code: "INVALID_FILL", message: "a simulated fill needs a positive truthful price and quantity", committed: false };
  }
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    // 1. The dry-run order intent (never sent to a broker).
    env.DB.prepare(
      `INSERT INTO orders
        (alert_fk, source, client_order_id, symbol, side, qty, order_type, time_in_force, status,
         market_open_at_submit, submitted_at, filled_qty, updated_at, error_detail)
       VALUES (?, 'dry_run', ?, ?, ?, ?, ?, ?, 'submitting', NULL, ?, '0', ?, 'DRY RUN: no broker request sent')`
    ).bind(f.alertFk, f.clientOrderId, f.symbol, f.side, String(f.qty), f.orderType, f.timeInForce, now, now),
    env.DB.prepare(
      `UPDATE orders SET status = 'dry_run_accepted', updated_at = ?,
         error_detail = 'DRY RUN: committed together with its ALPHA PAPER fill; no broker request sent'
       WHERE client_order_id = ?`
    ).bind(now, f.clientOrderId),
  ];

  let fillQty = f.qty;
  let sellPortfolio: D1PreparedStatement[] | null = null;
  if (f.side === "buy") {
    // 2. Open, or add to the one OPEN position (weighted average entry from the stored row).
    statements.push(
      env.DB.prepare(
        `INSERT INTO paper_positions
          (symbol, side, status, qty, avg_entry_price, multiplier, strategy, opened_at,
           entry_qty_total, entry_value_total, mark_price, mark_at, mark_source,
           open_alert_id, open_order_id, last_order_id, updated_at)
         VALUES (?, 'long', 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) WHERE status = 'OPEN' DO UPDATE SET
           avg_entry_price = (avg_entry_price * qty + excluded.avg_entry_price * excluded.qty) / (qty + excluded.qty),
           qty = qty + excluded.qty,
           entry_qty_total = entry_qty_total + excluded.entry_qty_total,
           entry_value_total = entry_value_total + excluded.entry_value_total,
           mark_price = excluded.mark_price,
           mark_at = excluded.mark_at,
           mark_source = excluded.mark_source,
           mark_error = NULL,
           mark_error_at = NULL,
           logged_unrealized_pnl = NULL,
           last_order_id = excluded.last_order_id,
           updated_at = excluded.updated_at`
      ).bind(
        f.symbol, f.qty, f.price, instrument.multiplier, f.strategy, now,
        f.qty, f.qty * f.price, f.price, f.priceAt, f.priceSource,
        f.alertId, f.clientOrderId, f.clientOrderId, now
      )
    );
    // 3. The fill.
    statements.push(
      env.DB.prepare(
        FILL_FROM_POSITION.replace("%KIND%", "CASE WHEN p.open_order_id = ? THEN 'OPEN' ELSE 'ADD' END")
          .replace("%REALIZED%", "0")
          .replace("%WHERE%", "p.symbol = ? AND p.status = 'OPEN'")
      ).bind(
        f.clientOrderId, f.clientOrderId, f.alertId, f.riskDecisionId, "buy", f.clientOrderId,
        f.qty, f.price, f.priceSource, f.priceAt, now, f.symbol, f.clientOrderId
      )
    );
    // 4. PAPER portfolio: reserve the position value from its strategy balance (fails the batch if short of funds).
    statements.push(...(await buyStatements(env.DB, f, now)));
  } else {
    // SELL reduces, CLOSE empties. Never below zero, never a short.
    const pos = await env.DB.prepare(
      `SELECT * FROM paper_positions WHERE symbol = ? AND status = 'OPEN'`
    ).bind(f.symbol).first<PositionRow>();
    if (!pos) return { ok: false, code: "NO_POSITION", message: `no open ${LEDGER_LABEL} position in ${f.symbol}`, committed: false };
    const q = f.action === "close" ? pos.qty : f.qty;
    if (q > pos.qty + QTY_EPSILON) {
      return { ok: false, code: "SELL_EXCEEDS_POSITION", message: `SELL ${q} is greater than the ${LEDGER_LABEL} position ${pos.qty}`, committed: false };
    }
    fillQty = q;
    const closes = pos.qty - q <= QTY_EPSILON;
    // 2. Reduce/close exactly the row version that was read (last_order_id), or nothing.
    statements.push(
      env.DB.prepare(
        `UPDATE paper_positions SET
           realized_pnl = realized_pnl + (? - avg_entry_price) * ? * multiplier,
           exit_qty_total = exit_qty_total + ?,
           exit_value_total = exit_value_total + ? * ?,
           qty = CASE WHEN ? THEN 0 ELSE qty - ? END,
           status = CASE WHEN ? THEN 'CLOSED' ELSE 'OPEN' END,
           closed_at = CASE WHEN ? THEN ? ELSE NULL END,
           close_alert_id = CASE WHEN ? THEN ? ELSE NULL END,
           close_order_id = CASE WHEN ? THEN ? ELSE NULL END,
           mark_price = ?, mark_at = ?, mark_source = ?, mark_error = NULL, mark_error_at = NULL,
           logged_unrealized_pnl = NULL,
           last_order_id = ?,
           updated_at = ?
         WHERE id = ? AND status = 'OPEN' AND last_order_id = ?`
      ).bind(
        f.price, q,
        q,
        q, f.price,
        closes ? 1 : 0, q,
        closes ? 1 : 0,
        closes ? 1 : 0, now,
        closes ? 1 : 0, f.alertId,
        closes ? 1 : 0, f.clientOrderId,
        f.price, f.priceAt, f.priceSource,
        f.clientOrderId,
        now,
        pos.id, pos.last_order_id
      )
    );
    // 3. The fill.
    statements.push(
      env.DB.prepare(
        FILL_FROM_POSITION.replace("%KIND%", "CASE WHEN p.status = 'CLOSED' THEN 'CLOSE' ELSE 'REDUCE' END")
          .replace("%REALIZED%", "(? - p.avg_entry_price) * ? * p.multiplier")
          .replace("%WHERE%", "p.id = ?")
      ).bind(
        f.clientOrderId, f.clientOrderId, f.alertId, f.riskDecisionId, "sell",
        q, f.price, f.priceSource, f.priceAt, f.price, q, now, pos.id, f.clientOrderId
      )
    );
    // PAPER portfolio: release the reserved cost basis and credit the realized P&L to the position's balance.
    sellPortfolio = sellStatements(env.DB, pos, { qty: q, price: f.price, alertId: f.alertId, clientOrderId: f.clientOrderId, closes }, now);
    if (closes) {
      // 4. The trade (fails, and rolls back, unless this order closed the position).
      // Schema 4: the position may have paid fees before the rollback; the trade is then recorded NET of them, with the
      // gross P&L, fees and slippage beside it (cost_profile 'none': no cost charged by this release).
      const ready = await feeSchemaReady(env.DB);
      statements.push(
        env.DB.prepare(
          ready ? FEE_AWARE_TRADE_INSERT : `INSERT INTO trades
            (symbol, direction, status, strategy, open_alert_id, open_order_id, close_order_id,
             entry_qty, entry_avg_price, exit_qty, exit_avg_price, open_qty, closed_cost_basis,
             realized_pnl, return_pct, opened_at, closed_at, leg_order_ids_json,
             source, position_fk, close_alert_id, price_sources)
           SELECT p.symbol, 'LONG', 'CLOSED', p.strategy, p.open_alert_id, p.open_order_id, p.close_order_id,
             round(p.entry_qty_total, 8), round(p.entry_value_total / p.entry_qty_total, 8),
             round(p.exit_qty_total, 8), round(p.exit_value_total / p.exit_qty_total, 8), '0',
             round(p.entry_value_total * p.multiplier, 8),
             round(p.realized_pnl, 8), round(p.realized_pnl / (p.entry_value_total * p.multiplier) * 100, 6),
             p.opened_at, p.closed_at,
             (SELECT json_group_array(client_order_id) FROM (SELECT client_order_id FROM paper_fills WHERE position_fk = p.id ORDER BY id)),
             'ALPHA_PAPER', p.id, p.close_alert_id,
             (SELECT group_concat(DISTINCT price_source) FROM paper_fills WHERE position_fk = p.id)
           FROM (SELECT 1) AS one
           LEFT JOIN paper_positions p ON p.id = ? AND p.last_order_id = ? AND p.status = 'CLOSED'`
        ).bind(pos.id, f.clientOrderId)
      );
    }
  }

  if (sellPortfolio) statements.push(...sellPortfolio);

  // 5. The alert becomes DRY_RUN_ACCEPTED in the same transaction.
  statements.push(
    env.DB.prepare(
      `UPDATE alerts SET status = 'dry_run', processed_at = ?, accepted_qty = ?, response_code = 'DRY_RUN_ACCEPTED',
         http_status = 200, rejection_reason = NULL
       WHERE alert_id = ?`
    ).bind(now, String(fillQty), f.alertId)
  );

  try {
    await env.DB.batch(statements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The batch is one transaction; confirm that nothing from it is visible.
    const leftover = await env.DB.prepare(`SELECT id FROM orders WHERE client_order_id = ?`).bind(f.clientOrderId).first();
    if (leftover) {
      return { ok: false, code: "LEDGER_INCONSISTENT", message: `order intent exists after a failed ledger batch: ${msg.slice(0, 200)}`, committed: true };
    }
    if (/CHECK constraint failed/i.test(msg) && /available_micro|reserved_micro/i.test(msg)) {
      return { ok: false, code: "INSUFFICIENT_PAPER_CAPITAL", message: `the ${f.symbol} PAPER balance cannot cover this fill; nothing was committed`, committed: false };
    }
    return {
      ok: false,
      code: /UNIQUE/i.test(msg) ? "LEDGER_DUPLICATE" : "LEDGER_ERROR",
      message: `nothing was committed (order intent, fill and position unchanged): ${msg.slice(0, 200)}`,
      committed: false,
    };
  }

  const order = (await env.DB.prepare(`SELECT * FROM orders WHERE client_order_id = ?`).bind(f.clientOrderId).first()) as Record<string, unknown>;
  const fill = (await env.DB.prepare(`SELECT * FROM paper_fills WHERE client_order_id = ?`).bind(f.clientOrderId).first()) as Record<string, unknown>;
  const position = (await env.DB.prepare(`SELECT * FROM paper_positions WHERE id = ?`)
    .bind(fill.position_fk).first<PositionRow>()) as PositionRow;
  const trade = fill.kind === "CLOSE"
    ? await env.DB.prepare(`SELECT * FROM trades WHERE position_fk = ?`).bind(position.id).first()
    : null;
  return { ok: true, kind: fill.kind as "OPEN" | "ADD" | "REDUCE" | "CLOSE", order, fill, position, trade };
}

/** One concise activity line for a ledger change. */
export function fillActivity(r: Extract<CommitResult, { ok: true }>, f: DryRunCommit): ActivityInput {
  const p = r.position;
  const at = `${fmtQty(Number(r.fill.qty))} @ ${fmtPrice(Number(r.fill.price))}`;
  const realized = Number(r.fill.realized_pnl);
  const message =
    r.kind === "OPEN" ? `${LEDGER_LABEL} position opened · ${at} (${f.priceSource})`
    : r.kind === "ADD" ? `${LEDGER_LABEL} position increased · +${at} → ${fmtQty(p.qty)} @ avg ${fmtPrice(round(p.avg_entry_price, 8))}`
    : r.kind === "REDUCE" ? `${LEDGER_LABEL} position reduced · −${at} · realized ${money(realized)} · ${fmtQty(p.qty)} left`
    : `${LEDGER_LABEL} position closed · ${at} · realized ${money(p.realized_pnl)}${r.trade ? ` (${signedPct(Number(r.trade.return_pct))}) · trade recorded` : ""}`;
  return {
    category: "paper",
    level: r.kind === "CLOSE" ? (p.realized_pnl >= 0 ? "success" : "warn") : "info",
    message,
    alertId: f.alertId,
    symbol: f.symbol,
    action: f.action,
    strategy: f.strategy,
    qty: Number(r.fill.qty),
    positionId: p.id,
  };
}

// ============================================================
// MARK TO MARKET
// ============================================================

const secondsEnv = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const unrealizedPnl = (p: Pick<PositionRow, "qty" | "avg_entry_price" | "multiplier">, mark: number) =>
  (mark - p.avg_entry_price) * p.qty * p.multiplier;

/**
 * Refreshes marks for OPEN ledger positions from their configured sources: one request for all Kraken
 * pairs, at most once per PAPER_MARK_MIN_INTERVAL_SECONDS (default 15) across all dashboards. A failed
 * source keeps the last mark and records the error; no price is estimated. Activity is written only on a
 * material P&L move or when market data becomes unavailable / available again.
 */
export async function refreshMarks(env: LedgerEnv): Promise<{ refreshed: boolean; positions: number }> {
  const open = (await env.DB.prepare(`SELECT * FROM paper_positions WHERE status = 'OPEN'`).all<PositionRow>()).results;
  if (open.length === 0) return { refreshed: false, positions: 0 };

  const interval = secondsEnv(env.PAPER_MARK_MIN_INTERVAL_SECONDS, 15);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const claim = await env.DB.prepare(
    `INSERT INTO app_meta (key, value) VALUES ('paper_marks_refreshed_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE app_meta.value <= ?`
  ).bind(now, new Date(nowMs - interval * 1000).toISOString()).run();
  if (!claim.meta || claim.meta.changes === 0) return { refreshed: false, positions: open.length };

  const instruments = open.map((p) => getInstrument(p.symbol)).filter((i): i is Instrument => i !== null);
  const prices = await referencePrices(instruments, env);
  const statements: D1PreparedStatement[] = [];

  for (const p of open) {
    const r = prices.get(p.symbol);
    if (r && r.ok && r.price !== null) {
      const upl = unrealizedPnl(p, r.price);
      const baseline = p.logged_unrealized_pnl ?? (p.mark_price !== null ? unrealizedPnl(p, p.mark_price) : 0);
      const material = Math.abs(upl - baseline) >= Math.max(1, 0.005 * p.avg_entry_price * p.qty * p.multiplier);
      statements.push(
        env.DB.prepare(
          `UPDATE paper_positions SET mark_price = ?, mark_at = ?, mark_source = ?, mark_error = NULL,
             mark_error_at = NULL, logged_unrealized_pnl = ?
           WHERE id = ? AND status = 'OPEN'`
        ).bind(r.price, r.at, r.source, material ? upl : baseline, p.id)
      );
      if (p.mark_error) {
        statements.push(activityStatement(env, {
          category: "market", level: "info", symbol: p.symbol, positionId: p.id,
          message: `Market data available again · mark ${fmtPrice(r.price)} (${r.source})`,
        }, now));
      }
      if (material) {
        const cost = p.avg_entry_price * p.qty * p.multiplier;
        statements.push(activityStatement(env, {
          category: "paper", level: "info", symbol: p.symbol, positionId: p.id,
          message: `${LEDGER_LABEL} mark ${fmtPrice(r.price)} (${r.source}) · unrealized ${money(upl)} (${signedPct((upl / cost) * 100)})`,
        }, now));
      }
    } else {
      const reason = !r ? "no market-data source"
        : !r.ok ? r.message
        : r.reason;
      statements.push(
        env.DB.prepare(
          `UPDATE paper_positions SET mark_error = ?, mark_error_at = ? WHERE id = ? AND status = 'OPEN'`
        ).bind(reason.slice(0, 300), now, p.id)
      );
      if (!p.mark_error) {
        statements.push(activityStatement(env, {
          category: "market", level: "warn", symbol: p.symbol, positionId: p.id,
          message: `Market data unavailable · last mark kept, P&L is stale`,
          errorDetail: reason.slice(0, 300),
        }, now));
      }
    }
  }
  await env.DB.batch(statements);
  return { refreshed: true, positions: open.length };
}

// ============================================================
// DASHBOARD
// ============================================================

/** ALPHA PAPER section of the dashboard: ledger positions and performance. Never broker figures. */
export async function paperSection(env: LedgerEnv) {
  const [open, realizedRow, closedRow] = await Promise.all([
    env.DB.prepare(`SELECT * FROM paper_positions WHERE status = 'OPEN' ORDER BY opened_at DESC`).all<PositionRow>(),
    feeSchemaReady(env.DB).then((ready) => env.DB.prepare(ready
      ? `SELECT COALESCE(SUM(realized_pnl), 0) AS realized, COALESCE(SUM(fees_micro), 0) AS fees, COALESCE(SUM(slippage_micro), 0) AS slippage FROM paper_positions`
      : `SELECT COALESCE(SUM(realized_pnl), 0) AS realized, 0 AS fees, 0 AS slippage FROM paper_positions`).first<{ realized: number; fees: number; slippage: number }>()),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM trades WHERE source = 'ALPHA_PAPER'`).first<{ n: number }>(),
  ]);
  const staleAfter = secondsEnv(env.PAPER_MARK_STALE_SECONDS, 120);
  const nowMs = Date.now();
  const positions = open.results.map((p) => {
    const markAgeSeconds = p.mark_at ? Math.max(0, Math.round((nowMs - Date.parse(p.mark_at)) / 1000)) : null;
    const status =
      p.mark_price === null ? "UNAVAILABLE"
      : p.mark_error ? "STALE"
      : markAgeSeconds !== null && markAgeSeconds > staleAfter ? "STALE"
      : "FRESH";
    const costBasis = p.avg_entry_price * p.qty * p.multiplier;
    const upl = p.mark_price === null ? null : unrealizedPnl(p, p.mark_price);
    return {
      id: p.id,
      label: LEDGER_LABEL,
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      avg_entry_price: p.avg_entry_price,
      multiplier: p.multiplier,
      cost_basis: round(costBasis, 8),
      mark_price: p.mark_price,
      mark_at: p.mark_at,
      mark_source: p.mark_source,
      mark_age_seconds: markAgeSeconds,
      mark_status: status,
      mark_error: p.mark_error,
      market_value: p.mark_price === null ? null : round(p.mark_price * p.qty * p.multiplier, 8),
      unrealized_pnl: upl === null ? null : round(upl, 8),
      unrealized_pct: upl === null || costBasis <= 0 ? null : round((upl / costBasis) * 100, 6),
      realized_pnl: round(p.realized_pnl, 8),
      strategy: p.strategy,
      opened_at: p.opened_at,
      open_alert_id: p.open_alert_id,
      open_order_id: p.open_order_id,
    };
  });
  const unrealizedKnown = positions.every((p) => p.unrealized_pnl !== null);
  const unrealized = positions.reduce((s, p) => s + (p.unrealized_pnl ?? 0), 0);
  // Net of simulated fees recorded before the rollback (this release charges none).
  const fees = Number(realizedRow?.fees ?? 0) / 1e6;
  const slippage = Number(realizedRow?.slippage ?? 0) / 1e6;
  const realized = Number(realizedRow?.realized ?? 0) - fees;
  return {
    label: LEDGER_LABEL,
    simulated: true,
    broker_positions: false,
    positions,
    performance: {
      fees_usd: round(fees, 6),
      slippage_usd: round(slippage, 6),
      realized_pnl: round(realized, 8),
      unrealized_pnl: unrealizedKnown ? round(unrealized, 8) : null,
      total_pnl: unrealizedKnown ? round(realized + unrealized, 8) : null,
      marks_stale: positions.some((p) => p.mark_status !== "FRESH"),
      open_positions: positions.length,
      closed_trades: closedRow?.n ?? 0,
    },
  };
}

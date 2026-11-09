// ALPHA PAPER portfolio: the unallocated MAIN balance plus one balance per crypto strategy (migration 0003).
// PAPER money only. Nothing here moves real funds, touches a broker or an exchange.
//
// Accounting (integer micro-dollars, one authoritative table pair):
//   * portfolio_wallets holds each balance: available, reserved (cost basis of open PAPER positions),
//     realized P&L (closed PAPER trades only) and net funding (deposits/transfers; never P&L).
//   * portfolio_entries is the append-only history; every balance change is one row with a UNIQUE key.
//   * A BUY fill reserves qty × price × multiplier from its strategy balance in the SAME D1 batch as the fill;
//     a SELL/CLOSE releases the reserved cost basis and credits the realized P&L to that balance. Profits stay
//     there until the user transfers them.
//   * Transfers move only available funds, atomically, and leave total equity unchanged.
// The strategy balance is the ALPHA PAPER buying power (risk reads it from D1; no broker account is used).
// Before any deposit every balance is $0, so every exposure-increasing BUY is rejected: unfunded balances
// cannot spend money that does not exist. "Active" (first deposit) only changes what the dashboard shows.

import { authorizePaperAction } from "./auth_session";
import { getInstrument } from "./instruments";
import { secureEqual } from "./trade_core";
import { costProfile, PAPER_FILL_DISCLOSURE } from "./costs";

export const MICRO = 1_000_000;
export const toMicro = (usd: number): number => Math.round(usd * MICRO);
export const fromMicro = (m: number): number => Math.round(Number(m)) / MICRO;
export const STRATEGY_WALLETS = ["SOLUSD", "ETHUSD", "BTCUSD", "HYPEUSD", "KAITOUSD"] as const;
export const WALLETS = ["MAIN", ...STRATEGY_WALLETS] as const;
export const isStrategyWallet = (s: string): boolean => (STRATEGY_WALLETS as readonly string[]).includes(s);
const MAX_USD = 1_000_000_000;
const MAX_BODY = 4096;

export interface PortfolioEnv {
  DB: D1Database;
  DASHBOARD_PASSPHRASE?: string;
  DASHBOARD_ORIGINS?: string;
  DAILY_LOSS_LIMIT?: string;
}

interface WalletRow {
  wallet: string;
  kind: "MAIN" | "STRATEGY";
  available_micro: number;
  reserved_micro: number;
  realized_pnl_micro: number;
  net_funding_micro: number;
  fees_micro: number; // simulated execution fees paid (migration 0004)
  updated_at: string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function portfolioActive(db: D1Database): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM portfolio_entries WHERE kind = 'DEPOSIT' LIMIT 1`).first());
}

const wallet = (db: D1Database, w: string) =>
  db.prepare(`SELECT * FROM portfolio_wallets WHERE wallet = ?`).bind(w).first<WalletRow>();

// ============================================================
// FILLS (called by the ledger, inside its single D1 batch)
// ============================================================

export interface PortfolioRejection {
  code: string;
  message: string;
}

/**
 * Pre-check for an exposure-increasing BUY (a second check after the risk rules, which read the same balance):
 * the strategy balance must cover the full position value (qty × price × multiplier). No leverage and no
 * borrowing: a $10 stop risk does not mean a $10 position. An unfunded balance is $0. Returns null when allowed.
 */
export async function portfolioGate(
  db: D1Database,
  f: { symbol: string; side: "buy" | "sell"; qty: number; price: number; feeMicro?: number }
): Promise<PortfolioRejection | null> {
  if (f.side !== "buy") return null;
  if (!isStrategyWallet(f.symbol)) {
    return { code: "NOT_IN_PAPER_PORTFOLIO", message: `${f.symbol} has no PAPER strategy balance; only crypto strategies trade from the PAPER portfolio` };
  }
  const pos = await db.prepare(`SELECT wallet FROM paper_positions WHERE symbol = ? AND status = 'OPEN'`).bind(f.symbol).first<{ wallet: string | null }>();
  if (pos && pos.wallet === null) {
    return { code: "POSITION_NOT_IN_PAPER_PORTFOLIO", message: `the open ${f.symbol} PAPER position predates the portfolio; close it before adding` };
  }
  const mult = getInstrument(f.symbol)?.multiplier ?? 1;
  const value = toMicro(f.qty * f.price * mult);
  const fee = Math.max(0, Math.round(f.feeMicro ?? 0));
  const need = value + fee;
  const w = await wallet(db, f.symbol);
  const have = w?.available_micro ?? 0;
  if (need > have) {
    return {
      code: "INSUFFICIENT_PAPER_CAPITAL",
      message: `${f.symbol} PAPER balance has $${fromMicro(have).toFixed(2)} available; this BUY needs $${fromMicro(need).toFixed(2)} (qty ${f.qty} × $${f.price}${fee ? ` + $${fromMicro(fee).toFixed(2)} simulated fee` : ""}, no leverage). Allocate more PAPER capital or lower the risk per trade.`,
    };
  }
  return null;
}

/** A simulated execution fee: debits the strategy balance and is recorded as its own FEE entry (once per fill). */
function feeStatements(db: D1Database, walletName: string, f: { feeMicro: number; alertId: string; clientOrderId: string; note: string },
  positionFk: number | null, positionLookup: { symbol: string } | null, now: string): D1PreparedStatement[] {
  const fee = Math.max(0, Math.round(f.feeMicro));
  if (fee === 0) return [];
  return [
    // CHECK (available_micro >= 0) fails the whole fill batch if the fee cannot be paid.
    db.prepare(`UPDATE portfolio_wallets SET available_micro = available_micro - ?, fees_micro = fees_micro + ?, updated_at = ? WHERE wallet = ?`)
      .bind(fee, fee, now, walletName),
    positionLookup
      ? db.prepare(
        `INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, ref, position_fk, note)
         VALUES (?, ?, ?, 'FEE', ?, ?, 0, ?, (SELECT id FROM paper_positions WHERE symbol = ? AND status = 'OPEN' AND last_order_id = ?), ?)`
      ).bind(`FEE:${f.clientOrderId}`, f.clientOrderId, now, walletName, -fee, f.alertId, positionLookup.symbol, f.clientOrderId, f.note)
      : db.prepare(
        `INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, ref, position_fk, note)
         VALUES (?, ?, ?, 'FEE', ?, ?, 0, ?, ?, ?)`
      ).bind(`FEE:${f.clientOrderId}`, f.clientOrderId, now, walletName, -fee, f.alertId, positionFk, f.note),
  ];
}

/** Statements appended to the BUY fill batch (after the position upsert). */
export async function buyStatements(
  db: D1Database,
  f: { symbol: string; qty: number; price: number; alertId: string; clientOrderId: string; feeMicro?: number; feeNote?: string },
  now: string
): Promise<D1PreparedStatement[]> {
  if (!isStrategyWallet(f.symbol)) return [];
  const mult = getInstrument(f.symbol)?.multiplier ?? 1;
  const need = toMicro(f.qty * f.price * mult);
  return [
    // CHECK (available_micro >= 0) fails the whole batch if the balance cannot cover it.
    db.prepare(`UPDATE portfolio_wallets SET available_micro = available_micro - ?, reserved_micro = reserved_micro + ?, updated_at = ? WHERE wallet = ?`)
      .bind(need, need, now, f.symbol),
    db.prepare(
      `INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, ref, position_fk, note)
       VALUES (?, ?, ?, 'RESERVE', ?, ?, ?, ?, (SELECT id FROM paper_positions WHERE symbol = ? AND status = 'OPEN' AND last_order_id = ?), ?)`
    ).bind(`RESERVE:${f.clientOrderId}`, f.clientOrderId, now, f.symbol, -need, need, f.alertId, f.symbol, f.clientOrderId,
      `BUY ${f.qty} @ ${f.price}: position value reserved`),
    db.prepare(`UPDATE paper_positions SET wallet = ?, reserved_micro = reserved_micro + ? WHERE symbol = ? AND status = 'OPEN' AND last_order_id = ?`)
      .bind(f.symbol, need, f.symbol, f.clientOrderId),
    ...feeStatements(db, f.symbol, { feeMicro: f.feeMicro ?? 0, alertId: f.alertId, clientOrderId: f.clientOrderId, note: f.feeNote ?? "simulated execution fee" },
      null, { symbol: f.symbol }, now),
  ];
}

/** Statements appended to a SELL/CLOSE fill batch (after the guarded position update). */
export function sellStatements(
  db: D1Database,
  pos: { id: number; qty: number; avg_entry_price: number; multiplier: number; wallet?: string | null; reserved_micro?: number },
  f: { qty: number; price: number; alertId: string; clientOrderId: string; closes: boolean; feeMicro?: number; feeNote?: string },
  now: string
): D1PreparedStatement[] {
  if (!pos.wallet) return [];
  const reserved = Number(pos.reserved_micro ?? 0);
  const release = f.closes ? reserved : Math.floor((reserved * f.qty) / pos.qty);
  const pnl = toMicro((f.price - pos.avg_entry_price) * f.qty * pos.multiplier);
  return [
    db.prepare(
      `UPDATE portfolio_wallets SET reserved_micro = reserved_micro - ?, available_micro = available_micro + ?,
         realized_pnl_micro = realized_pnl_micro + ?, updated_at = ? WHERE wallet = ?`
    ).bind(release, release + pnl, pnl, now, pos.wallet),
    db.prepare(
      `INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, ref, position_fk, note)
       VALUES (?, ?, ?, 'RELEASE', ?, ?, ?, ?, ?, ?)`
    ).bind(`RELEASE:${f.clientOrderId}`, f.clientOrderId, now, pos.wallet, release, -release, f.alertId, pos.id, `SELL ${f.qty} @ ${f.price}: cost basis released`),
    db.prepare(
      `INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, ref, position_fk, note)
       VALUES (?, ?, ?, 'REALIZED_PNL', ?, ?, 0, ?, ?, ?)`
    ).bind(`PNL:${f.clientOrderId}`, f.clientOrderId, now, pos.wallet, pnl, f.alertId, pos.id, `realized PAPER P&L`),
    db.prepare(`UPDATE paper_positions SET reserved_micro = reserved_micro - ? WHERE id = ? AND last_order_id = ?`)
      .bind(release, pos.id, f.clientOrderId),
    // The exit fee comes out of the proceeds just credited (proceeds >= fee, so the balance cannot go negative).
    ...feeStatements(db, pos.wallet, { feeMicro: f.feeMicro ?? 0, alertId: f.alertId, clientOrderId: f.clientOrderId, note: f.feeNote ?? "simulated execution fee" },
      pos.id, null, now),
  ];
}

// ============================================================
// DASHBOARD ACTIONS: POST /api/paper/{fund,transfer,risk}
// ============================================================

function parseAmount(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_USD) return null;
  if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return null; // cents
  return v;
}
const validRequestId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v);

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, code: "PAYLOAD_TOO_LARGE" }, 413);
  try {
    const b = JSON.parse(text);
    return b && typeof b === "object" ? (b as Record<string, unknown>) : json({ ok: false, code: "INVALID_JSON" }, 400);
  } catch {
    return json({ ok: false, code: "INVALID_JSON", message: "Body must be JSON" }, 400);
  }
}

const isCheckFailure = (e: unknown) => /CHECK constraint failed/i.test(String(e instanceof Error ? e.message : e));
const isUnique = (e: unknown) => /UNIQUE/i.test(String(e instanceof Error ? e.message : e));

export async function handlePaperApi(request: Request, env: PortfolioEnv, pathname: string): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const denied = await authorizePaperAction(request, env, body.passphrase);
  if (denied) return denied;
  if (pathname === "/api/paper/fund") return fund(env, body);
  if (pathname === "/api/paper/transfer") return transfer(env, body);
  if (pathname === "/api/paper/risk") return applyRisk(env, body);
  return json({ ok: false, code: "NOT_FOUND" }, 404);
}

/** Earlier result of the same request id, or a rejection if the id was reused for something else. */
async function replay(db: D1Database, key: string, same: (row: Record<string, unknown>) => boolean): Promise<Response | null> {
  const row = await db.prepare(`SELECT * FROM portfolio_entries WHERE entry_key = ?`).bind(key).first<Record<string, unknown>>();
  if (!row) return null;
  if (!same(row)) return json({ ok: false, code: "REQUEST_ID_REUSED", message: "this request id was already used for a different action" }, 409);
  return json({ ok: true, duplicate: true, mode: "PAPER", message: "already applied; nothing changed", portfolio: await walletSummary(db) });
}

async function fund(env: PortfolioEnv, b: Record<string, unknown>): Promise<Response> {
  const action = b.action === "deposit" ? "DEPOSIT" : b.action === "withdraw" ? "WITHDRAW" : null;
  const amount = parseAmount(b.amount_usd);
  if (!action || amount === null || !validRequestId(b.request_id)) {
    return json({ ok: false, code: "INVALID_REQUEST", message: "action (deposit|withdraw), amount_usd (> 0, cents) and request_id are required" }, 400);
  }
  const key = `${action}:${b.request_id}`;
  const m = toMicro(amount);
  const change = action === "DEPOSIT" ? m : -m;
  const again = await replay(env.DB, key, (r) => r.kind === action && Number(r.available_change_micro) === change);
  if (again) return again;
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE portfolio_wallets SET available_micro = available_micro + ?, net_funding_micro = net_funding_micro + ?, updated_at = ? WHERE wallet = 'MAIN'`)
        .bind(change, change, now),
      env.DB.prepare(
        `INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, ref, note)
         VALUES (?, ?, ?, ?, 'MAIN', ?, ?, ?)`
      ).bind(key, key, now, action, change, b.request_id, action === "DEPOSIT" ? "PAPER funding added (not profit)" : "PAPER funding removed (not a loss)"),
    ]);
  } catch (e) {
    if (isCheckFailure(e)) return json({ ok: false, code: "INSUFFICIENT_AVAILABLE", message: "MAIN does not have that much unallocated PAPER capital; nothing changed" }, 409);
    if (isUnique(e)) return (await replay(env.DB, key, () => true)) ?? json({ ok: false, code: "CONFLICT" }, 409);
    throw e;
  }
  return json({ ok: true, duplicate: false, mode: "PAPER", portfolio: await walletSummary(env.DB) });
}

async function transfer(env: PortfolioEnv, b: Record<string, unknown>): Promise<Response> {
  const from = typeof b.from === "string" ? b.from : "";
  const to = typeof b.to === "string" ? b.to : "";
  const amount = parseAmount(b.amount_usd);
  if (!(WALLETS as readonly string[]).includes(from) || !(WALLETS as readonly string[]).includes(to) || from === to || amount === null || !validRequestId(b.request_id)) {
    return json({ ok: false, code: "INVALID_REQUEST", message: "from and to must be different PAPER balances; amount_usd > 0 in cents; request_id required" }, 400);
  }
  const m = toMicro(amount);
  const outKey = `XFER:${b.request_id}:out`;
  const again = await replay(env.DB, outKey, (r) => r.wallet === from && r.counterparty === to && Number(r.available_change_micro) === -m);
  if (again) return again;
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      // CHECK (available_micro >= 0): reserved funds can never leave, and nothing goes below zero.
      env.DB.prepare(`UPDATE portfolio_wallets SET available_micro = available_micro - ?, net_funding_micro = net_funding_micro - ?, updated_at = ? WHERE wallet = ?`)
        .bind(m, m, now, from),
      env.DB.prepare(`UPDATE portfolio_wallets SET available_micro = available_micro + ?, net_funding_micro = net_funding_micro + ?, updated_at = ? WHERE wallet = ?`)
        .bind(m, m, now, to),
      env.DB.prepare(
        `INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, counterparty, ref, note)
         VALUES (?, ?, ?, 'TRANSFER_OUT', ?, ?, ?, ?, 'PAPER transfer (not P&L)')`
      ).bind(outKey, `XFER:${b.request_id}`, now, from, -m, to, b.request_id),
      env.DB.prepare(
        `INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, counterparty, ref, note)
         VALUES (?, ?, ?, 'TRANSFER_IN', ?, ?, ?, ?, 'PAPER transfer (not P&L)')`
      ).bind(`XFER:${b.request_id}:in`, `XFER:${b.request_id}`, now, to, m, from, b.request_id),
    ]);
  } catch (e) {
    if (isCheckFailure(e)) {
      const w = await wallet(env.DB, from);
      return json({
        ok: false, code: "INSUFFICIENT_AVAILABLE",
        message: `${from} has $${fromMicro(w?.available_micro ?? 0).toFixed(2)} available (reserved for open PAPER positions: $${fromMicro(w?.reserved_micro ?? 0).toFixed(2)}); nothing was transferred`,
      }, 409);
    }
    if (isUnique(e)) return (await replay(env.DB, outKey, () => true)) ?? json({ ok: false, code: "CONFLICT" }, 409);
    throw e;
  }
  return json({ ok: true, duplicate: false, mode: "PAPER", portfolio: await walletSummary(env.DB) });
}

// ============================================================
// RISK PER TRADE (versioned; applied only after the engine confirms)
// ============================================================

export const MIN_RISK_USD = 1; // Pine input minval

async function applyRisk(env: PortfolioEnv, b: Record<string, unknown>): Promise<Response> {
  const strategy = typeof b.strategy === "string" ? b.strategy : "";
  const risk = parseAmount(b.risk_usd);
  if (!isStrategyWallet(strategy) || risk === null || risk < MIN_RISK_USD || !validRequestId(b.request_id)) {
    return json({ ok: false, code: "INVALID_REQUEST", message: `strategy, risk_usd (at least $${MIN_RISK_USD}, cents) and request_id are required` }, 400);
  }
  const prior = await env.DB.prepare(`SELECT * FROM strategy_settings WHERE request_key = ?`).bind(b.request_id).first<Record<string, unknown>>();
  if (prior) {
    if (prior.strategy !== strategy || Number(prior.risk_usd) !== risk) return json({ ok: false, code: "REQUEST_ID_REUSED" }, 409);
    return json({ ok: true, duplicate: true, mode: "PAPER", settings: await settingsFor(env.DB, strategy) });
  }
  const w = await wallet(env.DB, strategy);
  const equity = fromMicro((w?.available_micro ?? 0) + (w?.reserved_micro ?? 0));
  if (risk > equity) {
    return json({
      ok: false, code: "RISK_EXCEEDS_ALLOCATION",
      message: `$${risk} risk per trade is more than the ${strategy} PAPER balance ($${equity.toFixed(2)}). Allocate capital first; nothing changed.`,
    }, 422);
  }
  const daily = Number(env.DAILY_LOSS_LIMIT ?? "");
  if (Number.isFinite(daily) && daily > 0 && risk > daily) {
    return json({ ok: false, code: "RISK_EXCEEDS_DAILY_LOSS_LIMIT", message: `$${risk} is above the daily loss limit ($${daily}); nothing changed.` }, 422);
  }
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE strategy_settings SET status = 'SUPERSEDED' WHERE strategy = ? AND status = 'PENDING'`).bind(strategy),
      env.DB.prepare(
        `INSERT INTO strategy_settings (strategy, version, risk_usd, status, requested_at, request_key, note)
         VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM strategy_settings WHERE strategy = ?), ?, 'PENDING', ?, ?, 'set from the dashboard')`
      ).bind(strategy, strategy, risk, now, b.request_id),
    ]);
  } catch (e) {
    if (isUnique(e)) return json({ ok: false, code: "CONFLICT", message: "another change was saved at the same time; reload and try again" }, 409);
    throw e;
  }
  return json({
    ok: true, duplicate: false, mode: "PAPER",
    message: "Saved as PENDING. It becomes Applied when the engine confirms; it affects new PAPER entries only.",
    settings: await settingsFor(env.DB, strategy),
  });
}

export async function settingsFor(db: D1Database, strategy: string) {
  const rows = (await db.prepare(`SELECT version, risk_usd, status, requested_at, applied_at, note FROM strategy_settings WHERE strategy = ? ORDER BY version DESC LIMIT 20`)
    .bind(strategy).all<{ version: number; risk_usd: number; status: string; requested_at: string; applied_at: string | null; note: string | null }>()).results;
  return {
    strategy,
    applied: rows.find((r) => r.status === "APPLIED") ?? null,
    pending: rows.find((r) => r.status === "PENDING") ?? null,
    history: rows,
    compounding: false,
  };
}

/**
 * Engine side of the risk setting. The engine reports which version it is using (settings_applied); a matching
 * PENDING version becomes APPLIED. Returns what the engine should use next (latest PENDING, else APPLIED).
 */
export async function engineSettingsExchange(db: D1Database, strategy: string, reported: unknown) {
  if (!isStrategyWallet(strategy)) return null;
  const r = reported && typeof reported === "object" ? (reported as Record<string, unknown>) : null;
  const version = r && typeof r.version === "number" ? r.version : null;
  const risk = r && typeof r.risk_usd === "number" ? r.risk_usd : null;
  if (version !== null && risk !== null) {
    const row = await db.prepare(`SELECT id FROM strategy_settings WHERE strategy = ? AND version = ? AND risk_usd = ? AND status = 'PENDING'`)
      .bind(strategy, version, risk).first<{ id: number }>();
    if (row) {
      const now = new Date().toISOString();
      await db.batch([
        db.prepare(`UPDATE strategy_settings SET status = 'SUPERSEDED' WHERE strategy = ? AND status = 'APPLIED'`).bind(strategy),
        db.prepare(`UPDATE strategy_settings SET status = 'APPLIED', applied_at = ? WHERE id = ? AND status = 'PENDING'`).bind(now, row.id),
      ]);
    }
  }
  const s = await settingsFor(db, strategy);
  const next = s.pending ?? s.applied;
  return next ? { strategy, version: next.version, risk_usd: next.risk_usd, status: next.status } : null;
}

// ============================================================
// BACKTEST CACHE: POST /webhook/engine-backtest (engine), GET /api/dashboard/backtest
// ============================================================

const MAX_BACKTEST_BYTES = 512 * 1024;

export async function handleEngineBacktest(request: Request, env: { DB: D1Database; WEBHOOK_SECRET: string }): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BACKTEST_BYTES) return json({ ok: false, code: "TOO_LARGE" }, 413);
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(text);
  } catch {
    return json({ ok: false, code: "INVALID_JSON" }, 400);
  }
  if (typeof b.secret !== "string" || !(await secureEqual(b.secret, env.WEBHOOK_SECRET))) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  const r = b.result && typeof b.result === "object" ? (b.result as Record<string, unknown>) : null;
  const strategy = typeof r?.strategy === "string" ? r.strategy : "";
  const data = r?.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : null;
  const hash = typeof r?.config_hash === "string" ? r.config_hash : "";
  if (!r || !isStrategyWallet(strategy) || !data || typeof data.from !== "string" || typeof data.to !== "string" || !/^[0-9a-f]{8,64}$/.test(hash) || !Array.isArray(r.trades)) {
    return json({ ok: false, code: "INVALID_BACKTEST" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO backtest_results (strategy, created_at, data_from, data_to, config_hash, body) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (strategy, config_hash, data_from, data_to) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`
  ).bind(strategy, new Date().toISOString(), data.from, data.to, hash, JSON.stringify(r)).run();
  return json({ ok: true, mode: "PAPER", stored: true });
}

export async function latestBacktest(db: D1Database, strategy: string) {
  const row = await db.prepare(`SELECT body, created_at FROM backtest_results WHERE strategy = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .bind(strategy).first<{ body: string; created_at: string }>();
  return row ? { cached_at: row.created_at, result: JSON.parse(row.body) } : null;
}

// ============================================================
// DASHBOARD SECTION
// ============================================================

async function walletSummary(db: D1Database) {
  const rows = (await db.prepare(`SELECT * FROM portfolio_wallets`).all<WalletRow>()).results;
  const open = (await db.prepare(`SELECT wallet, qty, avg_entry_price, multiplier, mark_price FROM paper_positions WHERE status = 'OPEN' AND wallet IS NOT NULL`)
    .all<{ wallet: string; qty: number; avg_entry_price: number; multiplier: number; mark_price: number | null }>()).results;
  const order = (w: string) => (WALLETS as readonly string[]).indexOf(w);
  const wallets = rows.sort((a, b) => order(a.wallet) - order(b.wallet)).map((w) => {
    const mine = open.filter((p) => p.wallet === w.wallet);
    const known = mine.every((p) => p.mark_price !== null);
    const upl = mine.reduce((s, p) => s + (p.mark_price === null ? 0 : (p.mark_price - p.avg_entry_price) * p.qty * p.multiplier), 0);
    const book = w.available_micro + w.reserved_micro;
    return {
      wallet: w.wallet, kind: w.kind,
      available_usd: fromMicro(w.available_micro), reserved_usd: fromMicro(w.reserved_micro),
      realized_pnl_usd: fromMicro(w.realized_pnl_micro), net_funding_usd: fromMicro(w.net_funding_micro),
      fees_usd: fromMicro(Number(w.fees_micro ?? 0)), net_realized_pnl_usd: fromMicro(w.realized_pnl_micro - Number(w.fees_micro ?? 0)),
      unrealized_pnl_usd: known ? Math.round(upl * 100) / 100 : null,
      book_balance_usd: fromMicro(book),
      equity_usd: known ? Math.round((fromMicro(book) + upl) * 100) / 100 : null,
      open_positions: mine.length, updated_at: w.updated_at,
    };
  });
  const sum = (k: "available_micro" | "reserved_micro" | "realized_pnl_micro" | "net_funding_micro" | "fees_micro") => rows.reduce((s, w) => s + Number(w[k] ?? 0), 0);
  const unrealizedKnown = wallets.every((w) => w.unrealized_pnl_usd !== null);
  const book = sum("available_micro") + sum("reserved_micro");
  return {
    wallets,
    totals: {
      book_balance_usd: fromMicro(book),
      unallocated_usd: fromMicro(rows.find((w) => w.wallet === "MAIN")?.available_micro ?? 0),
      available_usd: fromMicro(sum("available_micro")),
      reserved_usd: fromMicro(sum("reserved_micro")),
      realized_pnl_usd: fromMicro(sum("realized_pnl_micro")),
      fees_usd: fromMicro(sum("fees_micro")),
      net_realized_pnl_usd: fromMicro(sum("realized_pnl_micro") - sum("fees_micro")),
      net_funding_usd: fromMicro(sum("net_funding_micro")),
      unrealized_pnl_usd: unrealizedKnown ? Math.round(wallets.reduce((s, w) => s + (w.unrealized_pnl_usd ?? 0), 0) * 100) / 100 : null,
    },
  };
}

/** Accounting identities, recomputed from the history on every read. Any false value is shown as a warning. */
async function consistency(db: D1Database) {
  const sums = (await db.prepare(
    `SELECT w.wallet, w.available_micro, w.reserved_micro, w.realized_pnl_micro, w.net_funding_micro, w.fees_micro,
       COALESCE(SUM(e.available_change_micro), 0) AS avail_sum, COALESCE(SUM(e.reserved_change_micro), 0) AS res_sum,
       COALESCE(SUM(CASE WHEN e.kind = 'REALIZED_PNL' THEN e.available_change_micro END), 0) AS pnl_sum,
       COALESCE(SUM(CASE WHEN e.kind = 'FEE' THEN -e.available_change_micro END), 0) AS fee_sum,
       COALESCE(SUM(CASE WHEN e.kind IN ('DEPOSIT', 'WITHDRAW', 'TRANSFER_IN', 'TRANSFER_OUT') THEN e.available_change_micro END), 0) AS funding_sum
     FROM portfolio_wallets w LEFT JOIN portfolio_entries e ON e.wallet = w.wallet GROUP BY w.wallet`
  ).all<Record<string, number | string>>()).results;
  const pos = (await db.prepare(`SELECT wallet, COALESCE(SUM(reserved_micro), 0) AS r FROM paper_positions WHERE wallet IS NOT NULL AND status = 'OPEN' GROUP BY wallet`)
    .all<{ wallet: string; r: number }>()).results;
  const issues: string[] = [];
  for (const s of sums) {
    if (Number(s.available_micro) !== Number(s.avail_sum)) issues.push(`${s.wallet}: available differs from its history`);
    if (Number(s.reserved_micro) !== Number(s.res_sum)) issues.push(`${s.wallet}: reserved differs from its history`);
    if (Number(s.realized_pnl_micro) !== Number(s.pnl_sum)) issues.push(`${s.wallet}: realized P&L differs from its history`);
    if (Number(s.net_funding_micro) !== Number(s.funding_sum)) issues.push(`${s.wallet}: net funding differs from its history`);
    if (Number(s.fees_micro) !== Number(s.fee_sum)) issues.push(`${s.wallet}: fees differ from its history`);
    if (Number(s.fees_micro) < 0) issues.push(`${s.wallet}: negative fees`);
    const r = pos.find((p) => p.wallet === s.wallet)?.r ?? 0;
    if (Number(s.reserved_micro) !== Number(r)) issues.push(`${s.wallet}: reserved differs from its open positions`);
  }
  const total = sums.reduce((a, s) => a + Number(s.available_micro) + Number(s.reserved_micro), 0);
  const ident = sums.reduce((a, s) => a + Number(s.net_funding_micro) + Number(s.realized_pnl_micro) - Number(s.fees_micro), 0);
  if (total !== ident) issues.push("book balance differs from funding + realized P&L - fees");
  return { ok: issues.length === 0, issues };
}

export async function portfolioSection(
  db: D1Database,
  vars: {
    MAX_ORDER_NOTIONAL?: string; MAX_POSITION_EXPOSURE?: string; MAX_TOTAL_EXPOSURE?: string; MAX_OPEN_POSITIONS?: string;
    DAILY_LOSS_LIMIT?: string; SHORT_SELLING_ENABLED?: string; PAPER_COST_PROFILE?: string;
  } = {}
) {
  const lim = (v?: string) => (v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const [summary, active, check, entries, settings] = await Promise.all([
    walletSummary(db),
    portfolioActive(db),
    consistency(db),
    db.prepare(`SELECT id, created_at, kind, wallet, available_change_micro, reserved_change_micro, counterparty, ref, note FROM portfolio_entries ORDER BY id DESC LIMIT 60`)
      .all<Record<string, unknown>>(),
    settingsFor(db, "SOLUSD"),
  ]);
  return {
    label: "ALPHA PAPER",
    simulated: true,
    active,
    ...summary,
    consistency: check,
    history: entries.results.map((e) => ({
      id: e.id, at: e.created_at, kind: e.kind, wallet: e.wallet, counterparty: e.counterparty, ref: e.ref, note: e.note,
      available_change_usd: fromMicro(Number(e.available_change_micro)), reserved_change_usd: fromMicro(Number(e.reserved_change_micro ?? 0)),
    })),
    strategies: { SOLUSD: { validated_engine: true, settings } },
    validated_engines: ["SOLUSD"],
    // The Worker's own limits, so the dashboard's constrained simulation uses the same rules.
    limits: {
      max_order_notional_usd: lim(vars.MAX_ORDER_NOTIONAL),
      max_position_exposure_usd: lim(vars.MAX_POSITION_EXPOSURE),
      // Read-only display of the remaining limits the risk engine enforces (null = not configured).
      max_total_exposure_usd: lim(vars.MAX_TOTAL_EXPOSURE),
      max_open_positions: lim(vars.MAX_OPEN_POSITIONS),
      daily_loss_limit_usd: lim(vars.DAILY_LOSS_LIMIT),
      short_selling_enabled: vars.SHORT_SELLING_ENABLED === "true",
    },
    // The execution-cost profile applied to new PAPER fills, with where each number comes from.
    costs: (() => {
      const p = costProfile(vars);
      return p
        ? { profile: p.id, name: p.name, maker_pct: p.makerPct, taker_pct: p.takerPct, taker_slippage_pct: p.takerSlipPct,
            min_qty: p.minQty, min_notional_usd: p.minNotionalUsd, fee_source: p.feeSource, slippage_source: p.slippageSource, caveat: p.caveat,
            fill_disclosure: PAPER_FILL_DISCLOSURE }
        : { profile: vars.PAPER_COST_PROFILE ?? null, invalid: true, fill_disclosure: PAPER_FILL_DISCLOSURE };
    })(),
  };
}

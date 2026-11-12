// Bot trade records for the Trades page filters, the Performance bot filter and the bot trade proof page. READ-ONLY.
//   GET /api/dashboard/bot-trades?bot=ALPHA-01&signal=<id>&limit=50
//   GET /api/dashboard/bot-trade?id=<trade_id>
// One normalized row per trade from the AUTHORITATIVE tables only:
//   bot-ledger bots  bot_positions (+ bot_fills, bot_orders, portfolio_entries)
//   legacy ALPHA-02  trades / paper_positions owned by bot_id (migration 0007)
// The proof recomputes the trade's arithmetic from its own rows and says whether it matches; nothing is estimated.

type Obj = Record<string, unknown>;
const µ = (v: unknown) => (v === null || v === undefined ? null : Number(v) / 1e6);
const ID_RE = /^[A-Za-z0-9:_.\-]{1,160}$/;
const BOT_RE = /^ALPHA-\d{2}$/;

export interface BotTradeRow {
  trade_id: string; bot_id: string; ledger: "bot" | "legacy"; symbol: string; side: string; status: string; qty: number;
  entry_price: number; exit_price: number | null; opened_at: string; closed_at: string | null;
  gross_usd: number | null; fees_usd: number | null; net_usd: number | null; swept_usd: number | null; stop: number | null; tp: number | null; proof_url: string;
}

async function tableSet(db: D1Database): Promise<Set<string>> {
  return new Set((await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>()).results.map((r) => r.name));
}

export async function botTrades(db: D1Database, q: { bot?: string | null; signal?: string | null; limit?: number }) {
  const t = await tableSet(db);
  if (!t.has("bots")) return { available: false, trades: [], orders: [], signals: [] };
  const bot = q.bot && BOT_RE.test(q.bot) ? q.bot : null;
  const signal = q.signal && ID_RE.test(q.signal) ? q.signal : null;
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 5000);
  const trades: BotTradeRow[] = [];
  const where = (col: string) => (bot ? ` AND ${col} = ?` : "");
  const args = bot ? [bot] : [];
  const pos = (await db.prepare(`SELECT * FROM bot_positions WHERE 1 = 1${where("bot_id")}${signal ? " AND (trade_id = ? OR close_order_id = ?)" : ""} ORDER BY id DESC LIMIT ?`)
    .bind(...args, ...(signal ? [signal, signal] : []), limit).all<Obj>()).results;
  for (const p of pos) {
    trades.push({ trade_id: String(p.trade_id), bot_id: String(p.bot_id), ledger: "bot", symbol: String(p.symbol), side: String(p.side), status: String(p.status), qty: Number(p.qty),
      entry_price: Number(p.entry_price), exit_price: p.exit_price === null ? null : Number(p.exit_price), opened_at: String(p.opened_at), closed_at: (p.closed_at as string) ?? null,
      gross_usd: µ(p.gross_pnl_micro), fees_usd: p.status === "CLOSED" ? (Number(p.entry_fee_micro) + Number(p.exit_fee_micro ?? 0)) / 1e6 : Number(p.entry_fee_micro) / 1e6,
      net_usd: µ(p.net_pnl_micro), swept_usd: µ(p.swept_micro), stop: (p.stop as number) ?? null, tp: (p.tp as number) ?? null,
      proof_url: `/bots/trade/${encodeURIComponent(String(p.trade_id))}` });
  }
  // Legacy bot (ALPHA-02 until stage S1): its closed trades in the original ledger, with the existing proof page.
  const legacy = (await db.prepare(`SELECT bot_id FROM bots WHERE ledger_api = 'legacy'${where("bot_id")}`).bind(...args).all<{ bot_id: string }>()).results.map((r) => r.bot_id);
  for (const id of legacy) {
    const rows = (await db.prepare(`SELECT id, symbol, qty, entry_price, exit_price, opened_at, closed_at, COALESCE(gross_pnl, realized_pnl) AS gross, COALESCE(fees_usd, 0) AS fees,
        realized_pnl AS net, open_alert_id FROM trades WHERE bot_id = ? AND source = 'ALPHA_PAPER'${signal ? " AND (open_alert_id = ? OR close_alert_id = ?)" : ""} ORDER BY id DESC LIMIT ?`)
      .bind(id, ...(signal ? [signal, signal] : []), limit).all<Obj>().catch(() => ({ results: [] as Obj[] }))).results;
    for (const r of rows) {
      trades.push({ trade_id: String(r.open_alert_id ?? r.id), bot_id: id, ledger: "legacy", symbol: String(r.symbol), side: "LONG", status: "CLOSED", qty: Number(r.qty),
        entry_price: Number(r.entry_price), exit_price: r.exit_price === null ? null : Number(r.exit_price), opened_at: String(r.opened_at), closed_at: (r.closed_at as string) ?? null,
        gross_usd: Number(r.gross), fees_usd: Number(r.fees), net_usd: Number(r.net), swept_usd: null, stop: null, tp: null, proof_url: `/trades/${r.id}` });
    }
  }
  trades.sort((a, b) => (b.opened_at > a.opened_at ? 1 : b.opened_at < a.opened_at ? -1 : 0));
  const orders = (await db.prepare(`SELECT order_id, bot_id, action, symbol, requested_qty, status, code, message, trade_id, received_at FROM bot_orders
      WHERE 1 = 1${where("bot_id")}${signal ? " AND (order_id = ? OR trade_id = ?)" : ""} ORDER BY received_at DESC LIMIT ?`)
    .bind(...args, ...(signal ? [signal, signal] : []), limit).all<Obj>()).results;
  // Legacy signals (alerts) for the bot or the exact signal id, with the shared status words.
  const hasBotCol = t.has("alerts");
  const signals = hasBotCol ? (await db.prepare(`SELECT id, alert_id, received_at, symbol, action, status, response_code, rejection_reason, bot_id FROM alerts
      WHERE 1 = 1${bot ? " AND bot_id = ?" : ""}${signal ? " AND alert_id = ?" : ""} ORDER BY id DESC LIMIT ?`)
    .bind(...args, ...(signal ? [signal] : []), limit).all<Obj>().catch(() => ({ results: [] as Obj[] }))).results : [];
  return { available: true, filter: { bot, signal }, trades: trades.slice(0, limit), orders, signals };
}

export async function botTradeProof(db: D1Database, tradeId: string) {
  if (!ID_RE.test(tradeId)) return null;
  const t = await tableSet(db);
  if (!t.has("bot_positions")) return null;
  const p = await db.prepare(`SELECT * FROM bot_positions WHERE trade_id = ?`).bind(tradeId).first<Obj>();
  if (!p) return null;
  const bot = await db.prepare(`SELECT bot_id, name, symbol, timeframe_min, profile, inputs_hash, wallet FROM bots WHERE bot_id = ?`).bind(p.bot_id).first<Obj>();
  const orderIds = [String(p.trade_id), ...(p.close_order_id ? [String(p.close_order_id)] : [])];
  const marks = orderIds.map(() => "?").join(", ");
  const orders = (await db.prepare(`SELECT order_id, action, requested_qty, status, code, message, received_at, payload_json FROM bot_orders WHERE order_id IN (${marks}) ORDER BY received_at`)
    .bind(...orderIds).all<Obj>()).results.map((o) => {
      let payload: Obj | null = null;
      try { payload = o.payload_json ? JSON.parse(String(o.payload_json)) : null; } catch { payload = null; }
      if (payload) delete payload.secret; // never shown (the Worker never stores it; defensive)
      const { payload_json: _p, ...rest } = o;
      return { ...rest, engine_payload: payload ? { stop: payload.stop ?? null, tp: payload.tp ?? null, risk_usd: payload.risk_usd ?? null, timestamp: payload.timestamp ?? null,
        profile: payload.profile ?? null, config_hash: payload.config_hash ?? null, qty: payload.qty ?? null } : null };
    });
  const fills = (await db.prepare(`SELECT fill_id, kind, side, qty, price, notional_micro, fee_rate_pct, fee_micro, fee_model, price_source, price_at, filled_at FROM bot_fills WHERE trade_id = ? ORDER BY id`)
    .bind(tradeId).all<Obj>()).results.map((f): Obj => ({ ...f, notional_usd: µ(f.notional_micro), fee_usd: µ(f.fee_micro) }));
  const entries = (await db.prepare(`SELECT entry_key, kind, wallet, available_change_micro, reserved_change_micro, counterparty, ref, note, created_at FROM portfolio_entries
      WHERE group_key IN (${marks}) OR entry_key LIKE ? ORDER BY id`).bind(...orderIds, `SWEEP:${tradeId}:%`).all<Obj>()).results
    .map((e): Obj => ({ ...e, available_change_usd: µ(e.available_change_micro), reserved_change_usd: µ(e.reserved_change_micro) }));
  const events = t.has("trade_events") ? (await db.prepare(`SELECT kind, occurred_at, url FROM trade_events WHERE ref = ? ORDER BY id`).bind(tradeId).all<Obj>().catch(() => ({ results: [] as Obj[] }))).results : [];
  // Arithmetic check from the trade's own rows (micro-USD, integer).
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const entry = fills.find((f) => f.kind === "ENTRY"), exit = fills.find((f) => f.kind === "EXIT");
  if (entry) checks.push({ name: "entry fee = 0.20% × entry notional", ok: Number(entry.fee_micro) === Math.round(Number(entry.notional_micro) * Number(entry.fee_rate_pct) / 100), detail: `${µ(entry.fee_micro)} of ${µ(entry.notional_micro)}` });
  if (entry) checks.push({ name: "position collateral = entry notional", ok: Number(p.collateral_micro) === Number(entry.notional_micro), detail: `${µ(p.collateral_micro)}` });
  if (exit && p.status === "CLOSED") {
    const dir = p.side === "LONG" ? 1 : -1;
    const gross = dir * (Number(exit.notional_micro) - Number(entry?.notional_micro ?? 0));
    checks.push({ name: "exit fee = 0.20% × exit notional", ok: Number(exit.fee_micro) === Math.round(Number(exit.notional_micro) * Number(exit.fee_rate_pct) / 100), detail: `${µ(exit.fee_micro)} of ${µ(exit.notional_micro)}` });
    checks.push({ name: "gross = direction × (exit notional − entry notional)", ok: gross === Number(p.gross_pnl_micro), detail: `${µ(gross)} vs recorded ${µ(p.gross_pnl_micro)}` });
    const net = Number(p.gross_pnl_micro) - Number(p.entry_fee_micro) - Number(p.exit_fee_micro);
    checks.push({ name: "net = gross − entry fee − exit fee", ok: net === Number(p.net_pnl_micro), detail: `${µ(net)} vs recorded ${µ(p.net_pnl_micro)}` });
    checks.push({ name: "swept to MAIN = max(net, 0)", ok: Number(p.swept_micro) === Math.max(0, Number(p.net_pnl_micro)), detail: `${µ(p.swept_micro)}` });
  }
  const sweepIn = entries.filter((e) => String(e.entry_key).endsWith(":IN")).reduce((s, e) => s + Number(e.available_change_micro), 0);
  if (p.status === "CLOSED") checks.push({ name: "MAIN received exactly the swept amount", ok: sweepIn === Number(p.swept_micro), detail: `${µ(sweepIn)}` });
  return {
    bot, position: { ...p, entry_fee_usd: µ(p.entry_fee_micro), exit_fee_usd: µ(p.exit_fee_micro), collateral_usd: µ(p.collateral_micro), gross_usd: µ(p.gross_pnl_micro),
      net_usd: µ(p.net_pnl_micro), swept_usd: µ(p.swept_micro), shortfall_usd: µ(p.shortfall_micro) },
    orders, fills, wallet_entries: entries, events, checks, all_checks_ok: checks.every((c) => c.ok),
    labels: { mode: "PAPER (simulated; no broker order)", fee_model: String(p.fee_model), short_model: p.side === "SHORT" ? "simulated, fully collateralised (no borrowing)" : null },
  };
}

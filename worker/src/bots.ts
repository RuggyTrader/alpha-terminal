// Independent bots (docs/MULTI-BOT-ARCHITECTURE.md, migration 0007).
//
// Every ledger row has an OWNER: a registered bot id ("ALPHA-02"), or "" (no bot: TradingView alerts and other
// single-owner callers, exactly the pre-0007 behaviour). Positions are unique per (owner, symbol), so two bots hold
// separate positions in the same market and one bot's exit can only ever reach its own position.
//
// Owner resolution for a signal:
//   * bot_id given: it must be a registered ACTIVE bot whose market and timeframe match the signal; otherwise rejected.
//   * no bot_id: the market's legacy bot (ALPHA-02 for SOLUSD) only for requests of the PRE-FLEET ENGINE:
//       - a funded signal whose id is that engine's own (ENG-<symbol>-<timeframe>-…, e.g. ENG-SOLUSD-5-…);
//       - an engine-only request (ledger view, status) whose timeframe matches or is absent (ledger queries carry none).
//     Everything else (TradingView alerts, tests, any other caller) is "" (no bot): exactly the old behaviour.
// Before migration 0007 (no bots table) the owner is null: the ledger then runs exactly the pre-0007 SQL (no ownership
// columns), so this Worker is safe on schema 6 too and the Worker/migration order of a deployment does not matter.

export const BOT_ID_RE = /^ALPHA-\d{2}$/;

export interface BotRow {
  bot_id: string;
  name: string;
  symbol: string;
  timeframe_min: number;
  profile: string | null;
  wallet: string;
  status: "ACTIVE" | "PROPOSED" | "DISABLED";
  legacy_default: number;
  entries_paused: number;
  allocation_cap_micro: number | null;
  reserved_micro: number;
  risk_pct: number;
  max_risk_usd: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

export type OwnerResult =
  | { ok: true; owner: string | null; bot: BotRow | null }
  | { ok: false; code: string; message: string };

const noBotsTable = (e: unknown) => /no such table: bots/i.test(String(e instanceof Error ? e.message : e));

export async function getBot(db: D1Database, botId: string): Promise<BotRow | null> {
  try {
    return await db.prepare(`SELECT * FROM bots WHERE bot_id = ?`).bind(botId).first<BotRow>();
  } catch (e) {
    if (noBotsTable(e)) return null;
    throw e;
  }
}

const timeframeOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/m$/i, "")) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The owner of a funded signal (see the header). */
export async function resolveOwner(db: D1Database, body: Record<string, unknown>, symbol: string, opts: { alertId?: string } = {}): Promise<OwnerResult> {
  const tf = timeframeOf(body.timeframe);
  if (body.bot_id !== undefined && body.bot_id !== null) {
    const id = body.bot_id;
    if (typeof id !== "string" || !BOT_ID_RE.test(id)) return { ok: false, code: "INVALID_BOT_ID", message: "bot_id must look like ALPHA-NN" };
    let bot: BotRow | null;
    try {
      bot = await db.prepare(`SELECT * FROM bots WHERE bot_id = ?`).bind(id).first<BotRow>();
    } catch (e) {
      if (noBotsTable(e)) return { ok: false, code: "BOTS_NOT_AVAILABLE", message: "this ledger has no bot registry yet (migration 0007)" };
      throw e;
    }
    if (!bot) return { ok: false, code: "UNKNOWN_BOT", message: `${id} is not a registered bot` };
    if (bot.status !== "ACTIVE") return { ok: false, code: "BOT_NOT_ACTIVE", message: `${id} is ${bot.status}; only ACTIVE bots trade` };
    if (bot.symbol !== symbol) return { ok: false, code: "BOT_MARKET_MISMATCH", message: `${id} trades ${bot.symbol}, not ${symbol}` };
    if (tf !== null && tf !== bot.timeframe_min) return { ok: false, code: "BOT_TIMEFRAME_MISMATCH", message: `${id} trades ${bot.timeframe_min}m, not ${tf}m` };
    return { ok: true, owner: bot.bot_id, bot };
  }
  try {
    const bot = await db.prepare(`SELECT * FROM bots WHERE symbol = ? AND legacy_default = 1 AND status = 'ACTIVE'`)
      .bind(symbol).first<BotRow>();
    if (!bot || (tf !== null && tf !== bot.timeframe_min)) return { ok: true, owner: "", bot: null };
    // A signal belongs to the legacy bot only if the pre-fleet engine made it (its own id format).
    if (opts.alertId !== undefined && !opts.alertId.startsWith(`ENG-${symbol}-${bot.timeframe_min}-`)) return { ok: true, owner: "", bot: null };
    return { ok: true, owner: bot.bot_id, bot };
  } catch (e) {
    if (noBotsTable(e)) return { ok: true, owner: null, bot: null };
    throw e;
  }
}

/** Capital a bot may still reserve: its wallet's available balance, limited by its own allocation cap. Micro-USD. */
export function botAvailableMicro(bot: BotRow, walletAvailableMicro: number): number {
  const cap = bot.allocation_cap_micro;
  return cap === null || cap === undefined ? walletAvailableMicro : Math.max(0, Math.min(walletAvailableMicro, cap - bot.reserved_micro));
}

/** Engine status storage key: one per bot; the legacy default bot also keeps the single-engine key the dashboard reads. */
export const statusKeys = (bot: BotRow | null): string[] =>
  bot ? [`engine_status:${bot.bot_id}`, ...(bot.legacy_default ? ["engine_status"] : [])] : ["engine_status"];

/**
 * The fleet as the dashboard shows it (read-only): every registered bot with its own ledger figures (open positions,
 * reserved capital, realized PAPER P&L, trade statistics) and its own latest engine report. Hypothetical mirror results
 * are kept in a separate field and never added to the PAPER figures.
 */
export async function fleetSection(db: D1Database) {
  let bots: BotRow[];
  try {
    bots = (await db.prepare(`SELECT * FROM bots ORDER BY priority, bot_id`).all<BotRow>()).results;
  } catch (e) {
    if (noBotsTable(e)) return { available: false, bots: [] };
    throw e;
  }
  const out = [];
  for (const b of bots) {
    const [open, stats, status, mirror] = await Promise.all([
      db.prepare(`SELECT id, symbol, qty, avg_entry_price, mark_price, mark_at, opened_at, open_alert_id, reserved_micro FROM paper_positions WHERE bot_id = ? AND status = 'OPEN'`)
        .bind(b.bot_id).all<Record<string, unknown>>(),
      db.prepare(
        `SELECT COUNT(*) AS trades, COALESCE(SUM(realized_pnl), 0) AS net,
           COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
           COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END), 0) AS gross_win,
           COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN -realized_pnl ELSE 0 END), 0) AS gross_loss
         FROM trades WHERE bot_id = ? AND source = 'ALPHA_PAPER'`
      ).bind(b.bot_id).first<{ trades: number; net: number; wins: number; gross_win: number; gross_loss: number }>(),
      db.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(`engine_status:${b.bot_id}`).first<{ value: string }>(),
      db.prepare(`SELECT a.account_id, a.last_candle_time, a.candles_processed, a.last_contiguous_seq,
           (SELECT COUNT(*) FROM mirror_trades t WHERE t.account_id = a.account_id) AS trades,
           (SELECT COALESCE(SUM(gross_pnl), 0) FROM mirror_trades t WHERE t.account_id = a.account_id) AS gross
         FROM mirror_accounts a WHERE a.bot_id = ?`).bind(b.bot_id).all<Record<string, unknown>>(),
    ]);
    // Trade-level drawdown of realized PAPER P&L (peak-to-trough of the cumulative net), from the ledger's own trades.
    const seq = (await db.prepare(`SELECT realized_pnl FROM trades WHERE bot_id = ? AND source = 'ALPHA_PAPER' ORDER BY closed_at, id`)
      .bind(b.bot_id).all<{ realized_pnl: number }>()).results;
    let cum = 0, peak = 0, dd = 0;
    for (const t of seq) { cum += Number(t.realized_pnl); peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    let report: Record<string, unknown> | null = null;
    try { report = status?.value ? JSON.parse(status.value) : null; } catch { report = null; }
    const s = stats ?? { trades: 0, net: 0, wins: 0, gross_win: 0, gross_loss: 0 };
    out.push({
      bot_id: b.bot_id, name: b.name, symbol: b.symbol, timeframe: `${b.timeframe_min}m`, profile: b.profile, status: b.status,
      entries_paused: b.entries_paused === 1, wallet: b.wallet,
      allocation_cap_usd: b.allocation_cap_micro === null ? null : b.allocation_cap_micro / 1e6,
      reserved_usd: b.reserved_micro / 1e6, risk_pct: b.risk_pct, max_risk_usd: b.max_risk_usd,
      open_positions: open.results,
      paper: {
        trades: Number(s.trades), realized_net_usd: Number(s.net), wins: Number(s.wins),
        win_rate: Number(s.trades) ? Number(s.wins) / Number(s.trades) : null,
        profit_factor: Number(s.gross_loss) > 0 ? Number(s.gross_win) / Number(s.gross_loss) : null,
        max_drawdown_usd: dd,
      },
      // Hypothetical (Strategy Mirror): reported separately, never part of PAPER balances or P&L.
      mirror: mirror.results.map((m) => ({ ...m, hypothetical: true })),
      engine: report,
    });
  }
  return { available: true, bots: out };
}

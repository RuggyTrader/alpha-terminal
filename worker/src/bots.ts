// Independent bots (docs/MULTI-BOT-ARCHITECTURE.md, migration 0007).
//
// Fleet bots (ledger_api 'bot') trade through bot_ledger.ts with their OWN wallets and positions (bot_positions).
// The legacy bot (ALPHA-02 today) still trades through /webhook/dry-run and paper_positions; its rows carry its bot id.
//
// Owner resolution for the LEGACY path (/webhook/dry-run, /webhook/engine-ledger, /webhook/engine-status):
//   * bot_id given: it must be a registered ACTIVE bot of the same market and timeframe. A fleet bot is refused here
//     (it must use /webhook/bot-order), so no bot can reach the legacy ledger by mistake.
//   * no bot_id: the market's legacy bot only for requests of the PRE-FLEET ENGINE: a funded signal whose id is that
//     engine's own (ENG-<symbol>-<timeframe>-…), or an engine-only request (ledger view, status) whose timeframe
//     matches or is absent. Everything else (TradingView alerts, tests) is "" (no bot): exactly the old behaviour.
// Before migration 0007 (no bots table) the owner is null: the ledger then runs exactly the pre-0007 SQL.

export const BOT_ID_RE = /^ALPHA-\d{2}$/;

export interface BotRow {
  bot_id: string;
  name: string;
  group_id: string;
  symbol: string;
  timeframe_min: number;
  profile: string | null;
  inputs_hash: string | null;
  wallet: string;
  status: "ACTIVE" | "PROPOSED" | "DISABLED";
  ledger_api: "bot" | "legacy";
  legacy_default: number;
  entries_paused: number;
  risk_usd: number;
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

/** The owner of a LEGACY-path request (see the header). */
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
    if (bot.ledger_api === "bot") return { ok: false, code: "BOT_LEDGER_PATH", message: `${id} trades through /webhook/bot-order with its own wallet` };
    if (bot.symbol !== symbol) return { ok: false, code: "BOT_MARKET_MISMATCH", message: `${id} trades ${bot.symbol}, not ${symbol}` };
    if (tf !== null && tf !== bot.timeframe_min) return { ok: false, code: "BOT_TIMEFRAME_MISMATCH", message: `${id} trades ${bot.timeframe_min}m, not ${tf}m` };
    return { ok: true, owner: bot.bot_id, bot };
  }
  try {
    const bot = await db.prepare(`SELECT * FROM bots WHERE symbol = ? AND legacy_default = 1 AND status = 'ACTIVE'`)
      .bind(symbol).first<BotRow>();
    if (!bot || (tf !== null && tf !== bot.timeframe_min)) return { ok: true, owner: "", bot: null };
    if (opts.alertId !== undefined && !opts.alertId.startsWith(`ENG-${symbol}-${bot.timeframe_min}-`)) return { ok: true, owner: "", bot: null };
    return { ok: true, owner: bot.bot_id, bot };
  } catch (e) {
    if (noBotsTable(e)) return { ok: true, owner: null, bot: null };
    throw e;
  }
}

/** Engine status storage key: one per bot; the legacy bot also keeps the single-engine key the dashboard reads. */
export const statusKeys = (bot: BotRow | null): string[] =>
  bot ? [`engine_status:${bot.bot_id}`, ...(bot.legacy_default ? ["engine_status"] : [])] : ["engine_status"];

const µ = (v: unknown) => Number(v ?? 0) / 1e6;

/**
 * The fleet as the dashboard shows it (read-only), grouped by cryptocurrency. Every figure is the bot's own:
 *   balances    available / reserved (collateral) / shortfall, from its own portfolio wallet
 *   funding     allocated in, withdrawn out, net profit swept to MAIN (from the wallet's entry history)
 *   performance closed trades only: gross P&L, fees (entry + exit), net P&L (= gross − fees), LONG/SHORT counts, wins,
 *               losses, break-even, win rate, profit factor (Σ net wins ÷ |Σ net losses|), expectancy (Σ net ÷ trades),
 *               maximum drawdown of the cumulative net P&L by close time. Sweeps are NOT trading profit and are not
 *               added; the bot's return is its net P&L, not "balance − initial allocation" (profits leave the wallet).
 *   open        its own open position(s), with the last truthful mark
 *   mirror      hypothetical Strategy Mirror figures, separate, never added to PAPER.
 * The legacy bot's figures come from the legacy tables (paper_positions / trades) until it moves to its own wallet.
 */
export async function fleetSection(db: D1Database) {
  let bots: BotRow[];
  try {
    bots = (await db.prepare(`SELECT * FROM bots ORDER BY priority, bot_id`).all<BotRow>()).results;
  } catch (e) {
    if (noBotsTable(e)) return { available: false, groups: [], bots: [] };
    throw e;
  }
  const groups = (await db.prepare(`SELECT group_id, name, symbol FROM allocation_groups ORDER BY group_id`).all<{ group_id: string; name: string; symbol: string }>()).results;
  const out = [];
  for (const b of bots) {
    const [wallet, funding, settings, status, mirror] = await Promise.all([
      db.prepare(`SELECT available_micro, reserved_micro, shortfall_micro FROM portfolio_wallets WHERE wallet = ?`).bind(b.wallet).first<Record<string, number>>(),
      db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN kind = 'TRANSFER_IN' AND group_key LIKE 'ALLOC:%' THEN available_change_micro END), 0) AS allocated,
          COALESCE(SUM(CASE WHEN kind = 'TRANSFER_IN' AND group_key NOT LIKE 'ALLOC:%' THEN available_change_micro END), 0) AS transferred_in,
          COALESCE(-SUM(CASE WHEN kind = 'TRANSFER_OUT' AND group_key LIKE 'SWEEP:%' THEN available_change_micro END), 0) AS swept,
          COALESCE(-SUM(CASE WHEN kind IN ('TRANSFER_OUT', 'WITHDRAW') AND group_key NOT LIKE 'SWEEP:%' THEN available_change_micro END), 0) AS withdrawn
        FROM portfolio_entries WHERE wallet = ?`).bind(b.wallet).first<Record<string, number>>(),
      db.prepare(`SELECT version, risk_usd, status, requested_at, applied_at FROM bot_settings WHERE bot_id = ? ORDER BY version DESC LIMIT 1`).bind(b.bot_id).first<Record<string, unknown>>(),
      db.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(`engine_status:${b.bot_id}`).first<{ value: string }>(),
      db.prepare(`SELECT a.account_id, a.last_candle_time, a.candles_processed, a.last_contiguous_seq,
           (SELECT COUNT(*) FROM mirror_trades t WHERE t.account_id = a.account_id) AS trades,
           (SELECT COALESCE(SUM(gross_pnl), 0) FROM mirror_trades t WHERE t.account_id = a.account_id) AS gross,
           (SELECT COALESCE(SUM(net_modelled_pnl), 0) FROM mirror_trades t WHERE t.account_id = a.account_id) AS net_modelled
         FROM mirror_accounts a WHERE a.bot_id = ?`).bind(b.bot_id).all<Record<string, unknown>>(),
    ]);
    let closed: { side: string; gross: number; fees: number; net: number; swept: number; closed_at: string }[];
    let open: Record<string, unknown>[];
    if (b.ledger_api === "bot") {
      closed = (await db.prepare(`SELECT side, gross_pnl_micro / 1e6 AS gross, (entry_fee_micro + exit_fee_micro) / 1e6 AS fees, net_pnl_micro / 1e6 AS net,
          swept_micro / 1e6 AS swept, closed_at FROM bot_positions WHERE bot_id = ? AND status = 'CLOSED' ORDER BY closed_at, id`).bind(b.bot_id).all<never>()).results;
      open = (await db.prepare(`SELECT trade_id, symbol, side, qty, entry_price, stop, tp, collateral_micro / 1e6 AS collateral_usd, entry_fee_micro / 1e6 AS entry_fee_usd,
          opened_at, mark_price, mark_at, risk_usd FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'`).bind(b.bot_id).all<Record<string, unknown>>()).results;
    } else {
      closed = (await db.prepare(`SELECT 'LONG' AS side, COALESCE(gross_pnl, realized_pnl) AS gross, COALESCE(fees_usd, 0) AS fees, realized_pnl AS net, 0 AS swept, closed_at
          FROM trades WHERE bot_id = ? AND source = 'ALPHA_PAPER' ORDER BY closed_at, id`).bind(b.bot_id).all<never>()).results;
      open = (await db.prepare(`SELECT open_alert_id AS trade_id, symbol, 'LONG' AS side, qty, avg_entry_price AS entry_price, NULL AS stop, NULL AS tp,
          reserved_micro / 1e6 AS collateral_usd, opened_at, mark_price, mark_at FROM paper_positions WHERE bot_id = ? AND status = 'OPEN'`).bind(b.bot_id).all<Record<string, unknown>>()).results;
    }
    const nets = closed.map((t) => Number(t.net));
    let cum = 0, peak = 0, dd = 0;
    for (const v of nets) { cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    const wins = nets.filter((v) => v > 0), losses = nets.filter((v) => v < 0);
    const lossSum = -losses.reduce((s, v) => s + v, 0);
    let report: Record<string, unknown> | null = null;
    try { report = status?.value ? JSON.parse(status.value) : null; } catch { report = null; }
    out.push({
      bot_id: b.bot_id, name: b.name, group: b.group_id, symbol: b.symbol, timeframe: `${b.timeframe_min}m`, profile: b.profile, inputs_hash: b.inputs_hash,
      status: b.status, ledger_api: b.ledger_api, entries_paused: b.entries_paused === 1, wallet: b.wallet,
      risk_usd: b.risk_usd, risk_setting: settings ?? null,
      balances: { available_usd: µ(wallet?.available_micro), reserved_usd: µ(wallet?.reserved_micro), shortfall_usd: µ(wallet?.shortfall_micro) },
      funding: { allocated_usd: µ(funding?.allocated), transferred_in_usd: µ(funding?.transferred_in), withdrawn_usd: µ(funding?.withdrawn), profit_swept_to_main_usd: µ(funding?.swept) },
      open_positions: open,
      paper: {
        trades: nets.length, long_trades: closed.filter((t) => t.side === "LONG").length, short_trades: closed.filter((t) => t.side === "SHORT").length,
        wins: wins.length, losses: losses.length, break_even: nets.length - wins.length - losses.length,
        gross_usd: closed.reduce((s, t) => s + Number(t.gross), 0), fees_usd: closed.reduce((s, t) => s + Number(t.fees), 0), net_usd: cum,
        win_rate: nets.length ? wins.length / nets.length : null, profit_factor: lossSum > 0 ? wins.reduce((s, v) => s + v, 0) / lossSum : null,
        expectancy_usd: nets.length ? cum / nets.length : null, max_drawdown_usd: dd,
      },
      mirror: mirror.results.map((m) => ({ ...m, hypothetical: true })),
      engine: report,
    });
  }
  const main = await db.prepare(`SELECT available_micro, net_funding_micro FROM portfolio_wallets WHERE wallet = 'MAIN'`).first<Record<string, number>>();
  const swept = await db.prepare(`SELECT COALESCE(SUM(available_change_micro), 0) AS v FROM portfolio_entries WHERE wallet = 'MAIN' AND kind = 'TRANSFER_IN' AND group_key LIKE 'SWEEP:%'`).first<{ v: number }>();
  return { available: true, generated_at: new Date().toISOString(), main: { available_usd: µ(main?.available_micro), profit_received_usd: µ(swept?.v) }, groups, bots: out };
}

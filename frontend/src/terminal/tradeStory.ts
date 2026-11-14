// Plain-language trade explanations, built ONLY from what the engine recorded with the trade (worker/src/trade_story.ts;
// engine/src/tradeplan.mjs). Every sentence maps to a recorded field; a field that was not recorded is never guessed —
// the explanation says it is unavailable instead. One normalized TradeView feeds the trade card, the chart and the
// assistant, so they cannot disagree.

import type { BotTradeRow } from "./botTrades";
import type { TradeRow } from "./types";

export interface TradePlan {
  side: "LONG" | "SHORT" | null; setup_at: string | null; swing_origin: number | null; swing_end: number | null; ote_705: number | null;
  order_type: string | null; order_placed_at: string | null; planned_entry: number | null; strategy_entry: number | null; filled_at: string | null;
  initial_stop: number | null; tp2: number | null; score: number | null; confluence: string[]; profile: string | null; inputs_hash: string | null;
  rules: { entry_mode: string | null; sl_mode: string | null; sl_buf_atr: number | null; tp2_ext: number | null; min_score: number | null } | null;
}
export interface TradeExit { kind: string | null; result: string | null; exit_r: number | null; strategy_exit: number | null; initial_stop: number | null;
  stop_at_exit: number | null; tp2: number | null; stop_history: { at: string | null; stop: number | null; reason: string | null }[] }
export interface TradeStory { plan: TradePlan | null; exit: TradeExit | null; missing: string[] }

export interface TradeView {
  key: string; ledger: "bot" | "legacy"; tradeId: string; botId: string | null; botLabel: string; symbol: string; timeframe: string | null;
  side: "LONG" | "SHORT"; status: "OPEN" | "CLOSED"; qty: number | null; entry: number | null; exit: number | null;
  gross: number | null; fees: number | null; net: number | null; returnPct: number | null; openedAt: string | null; closedAt: string | null;
  costProfile: string | null; swept: number | null; story: TradeStory | null; proofUrl: string; chartUrl: string | null;
  slippage: number | null; source: "VERIFIED PAPER" | "ALPHA PAPER" | "UNVERIFIED SOURCE";
}

export const CONFLUENCE: Record<string, string> = { FVG: "Fair Value Gap", OB: "Order Block", RB: "Rejection Block" };
const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const p = (v: number | null) => (v === null ? "unavailable" : String(Number(v.toFixed(8))));

/** The legacy single engine's alert ids are ENG-<SYMBOL>-<TF>-<time>-<ACTION>: that is ALPHA-02 (SOLUSD 5m). */
export function legacyBotOf(alertId: string | null | undefined): { botId: string | null; timeframe: string | null } {
  const m = /^ENG-([A-Z]+)-(\d+)-/.exec(String(alertId ?? ""));
  if (!m) return { botId: null, timeframe: null };
  return { botId: m[1] === "SOLUSD" && m[2] === "5" ? "ALPHA-02" : null, timeframe: `${m[2]}m` };
}
const label = (id: string | null) => (id ? id.replace("-", " ") : "Engine");

export function fromLegacyTrade(t: TradeRow & { story?: TradeStory | null }): TradeView {
  const b = legacyBotOf(t.open_alert_id);
  const closed = t.status === "CLOSED";
  return { key: `legacy-${t.id}`, ledger: "legacy", tradeId: String(t.id), botId: b.botId, botLabel: label(b.botId), symbol: String(t.symbol), timeframe: b.timeframe,
    side: String(t.direction).toLowerCase() === "short" ? "SHORT" : "LONG", status: closed ? "CLOSED" : "OPEN", qty: n(t.entry_qty), entry: n(t.entry_avg_price), exit: closed ? n(t.exit_avg_price) : null,
    gross: n(t.gross_pnl ?? t.realized_pnl), fees: n(t.fees_usd), net: n(t.realized_pnl), returnPct: n(t.return_pct), openedAt: t.opened_at ?? null, closedAt: t.closed_at ?? null,
    costProfile: (t.cost_profile as string | null) ?? null, swept: null, story: t.story ?? null, proofUrl: `/trades/${t.id}`,
    slippage: n(t.slippage_usd), source: t.source === "ALPHA_PAPER" ? (closed ? "VERIFIED PAPER" : "ALPHA PAPER") : "UNVERIFIED SOURCE",
    chartUrl: b.botId ? `/bots/${b.botId}/chart?ledger=legacy&trade=${t.id}` : null };
}

/** The registered bots' timeframes (engine/src/bots.mjs); never parsed from an order id. */
export const BOT_TIMEFRAME: Record<string, string> = { "ALPHA-01": "1m", "ALPHA-02": "5m", "ALPHA-03": "1m", "ALPHA-04": "5m" };

export function fromBotTrade(r: BotTradeRow & { story?: TradeStory | null }): TradeView {
  const tf = BOT_TIMEFRAME[r.bot_id]?.replace("m", "") ?? null;
  // A legacy (ALPHA-02) row is identified by its trades.id everywhere else (dashboard list, proof page, chart): use the
  // same id so the same trade never appears twice and its chart link resolves.
  const id = r.ledger === "legacy" && r.legacy_id !== undefined && r.legacy_id !== null ? String(r.legacy_id) : r.trade_id;
  return { key: `${r.ledger}-${id}`, ledger: r.ledger, tradeId: id, botId: r.bot_id, botLabel: label(r.bot_id), symbol: r.symbol,
    timeframe: tf ? `${tf}m` : null, side: r.side === "SHORT" ? "SHORT" : "LONG", status: r.status === "OPEN" ? "OPEN" : "CLOSED", qty: r.qty, entry: r.entry_price, exit: r.exit_price,
    gross: r.gross_usd, fees: r.fees_usd, net: r.net_usd, returnPct: r.net_usd !== null && r.entry_price ? (r.net_usd / (r.qty * r.entry_price)) * 100 : null,
    openedAt: r.opened_at, closedAt: r.closed_at, costProfile: r.ledger === "bot" ? "ndax-flat-0.20" : null, swept: r.swept_usd, story: r.story ?? null, proofUrl: r.proof_url,
    slippage: null, source: r.status === "CLOSED" ? "VERIFIED PAPER" : "ALPHA PAPER",
    chartUrl: `/bots/${r.bot_id}/chart?ledger=${r.ledger}&trade=${encodeURIComponent(id)}` };
}

/** Why the bot entered — every clause is a recorded field. Null when no plan was recorded. */
export function explainEntry(v: TradeView): string | null {
  const pl = v.story?.plan;
  if (!pl) return null;
  const dir = pl.side ?? v.side;
  const swingWord = dir === "LONG" ? "bullish" : "bearish";
  const parts: string[] = [];
  parts.push(`${v.botLabel} (${v.symbol}${v.timeframe ? ` ${v.timeframe}` : ""}) found a ${swingWord} swing${pl.swing_origin !== null && pl.swing_end !== null ? ` from ${p(pl.swing_origin)} to ${p(pl.swing_end)}` : ""}.`);
  if (pl.ote_705 !== null) parts.push(`Its OTE entry is the 70.5% retracement of that swing (${p(pl.ote_705)}).`);
  const conf = pl.confluence.map((t) => CONFLUENCE[t] ?? t);
  if (conf.length) parts.push(`The setup qualified with ${conf.join(" and ")} confluence${pl.score !== null ? ` (score ${pl.score}${pl.rules?.min_score !== null && pl.rules?.min_score !== undefined ? `, minimum ${pl.rules.min_score}` : ""})` : ""}.`);
  else if (pl.score !== null) parts.push(`Confluence score ${pl.score}; the qualifying PD-array types were not recorded.`);
  if (pl.planned_entry !== null) parts.push(`It placed a ${dir} ${pl.order_type === "LIMIT" ? "limit order" : "order"} at ${p(pl.planned_entry)}, stop ${p(pl.initial_stop)} (beyond the swing origin), target ${p(pl.tp2)}.`);
  return parts.join(" ");
}

const EXIT_TEXT: Record<string, string> = {
  SL: "Stop loss reached", TP2: "Take profit (TP2) reached", BREAK_EVEN: "Break-even stop reached (the stop had been moved to the entry price)",
  TRAILING_SL: "Trailing stop reached (the stop had been trailed behind the market)", TIME_EXIT: "Closed by the strategy's trading-hours / sleep rule",
  SAME_BAR: "Entered and exited within the same candle", RECONCILE_AFTER_DATA_GAP: "Closed by the engine's safety reconciliation after a market-data gap",
};

/** Why the bot exited — from the strategy's own recorded exit result. Null when not recorded. */
export function explainExit(v: TradeView): string | null {
  const e = v.story?.exit;
  if (v.status !== "CLOSED" || !e) return null;
  const head = EXIT_TEXT[e.result ?? ""] ?? (e.kind === "TP" ? "Take profit reached" : e.kind === "SL" ? "A stop order filled" : null);
  if (!head) return null;
  const at = e.strategy_exit !== null ? ` at ${p(e.strategy_exit)}` : "";
  const r = e.exit_r !== null ? ` (${e.exit_r >= 0 ? "+" : ""}${e.exit_r.toFixed(2)}R)` : "";
  const last = e.stop_history.length ? e.stop_history[e.stop_history.length - 1] : null;
  const moved = last ? ` The stop moved ${e.stop_history.length} time${e.stop_history.length > 1 ? "s" : ""} before the exit (last: ${p(last.stop)}, ${String(last.reason ?? "").toLowerCase().replace("_", "-")}).` : "";
  return `${head}${at}${r}.${moved}`;
}

/** The plan's dollar figures for this trade's actual quantity (estimates from recorded levels; null when unknown). */
export function planFigures(v: TradeView) {
  const pl = v.story?.plan;
  const qty = v.qty;
  const entry = pl?.planned_entry ?? null;
  const risk = qty !== null && entry !== null && pl?.initial_stop !== null && pl?.initial_stop !== undefined ? Math.abs(entry - pl.initial_stop) * qty : null;
  const reward = qty !== null && entry !== null && pl?.tp2 !== null && pl?.tp2 !== undefined ? Math.abs(pl.tp2 - entry) * qty : null;
  const fillGap = entry !== null && v.entry !== null && pl ? v.entry - entry : null;
  return { risk, reward, rr: risk && reward ? reward / risk : null, fillGap };
}

/** For a fee-free legacy trade: what the official Ndax 0.20%/fill benchmark would have charged (a comparison only). */
export function hypotheticalFees(v: TradeView, pct = 0.2) {
  if (v.qty === null || v.entry === null) return null;
  const fees = (v.qty * v.entry + (v.exit !== null ? v.qty * v.exit : 0)) * pct / 100;
  return { fees, net: v.gross !== null ? v.gross - fees : null };
}

/** Owner-readable sizing / refusal reasons. The code is always kept next to it. */
export function humanReason(code: string | null | undefined, ctx: { available?: number | null; cost?: number | null; minQty?: number | null; unit?: string } = {}): string | null {
  const c = String(code ?? "");
  const usd = (v: number | null | undefined) => (v === null || v === undefined ? "unknown" : `$${v.toFixed(2)}`);
  switch (c) {
    case "": return null;
    case "BELOW_MIN_QTY": return `The position this bot can afford is smaller than Kraken's minimum order${ctx.minQty ? ` (${ctx.minQty} ${ctx.unit ?? ""})`.replace(/ \)$/, ")") : ""}, so the order was skipped. More allocated capital (or a wider stop) would be needed.`;
    case "BELOW_MIN_COST": return "The order value is below Kraken's minimum order value, so it was skipped.";
    case "INSUFFICIENT_BOT_CAPITAL": return `This bot's wallet (${usd(ctx.available)} available) cannot pay for the order${ctx.cost !== null && ctx.cost !== undefined ? ` (${usd(ctx.cost)} with fees)` : ""}, and even the smallest allowed size could not fit. Another bot's money is never used.`;
    case "SHORT_NOT_ALLOWED": return "This release's PAPER ledger is long-only, so the strategy's SHORT setup was recorded but not executed.";
    case "STALE_PRICE": return "The market price was too old to size the order safely, so nothing was sent.";
    case "BALANCE_UNKNOWN": return "The bot could not read its PAPER balance, so it did not place an order.";
    case "NO_CAPITAL": return "This bot has no available PAPER capital.";
    case "MAX_ORDER_NOTIONAL": case "MAX_TOTAL_EXPOSURE": case "MAX_OPEN_POSITIONS": case "EXPOSURE_LIMIT": return "The order would exceed one of the account's safety limits, so it was refused.";
    case "BOT_ENTRIES_PAUSED": return "New entries are paused for this bot by the owner; open positions are still managed.";
    case "BOT_PROFILE_MISMATCH": return "The order came from an engine whose strategy settings do not match this bot's registered original profile, so no new entry was opened. (A close is still accepted so a position is never trapped.)";
    case "BOT_SHORTFALL": return "This bot has an unpaid loss (shortfall) from an earlier trade. New entries and resuming stay blocked until it is settled; MAIN never covers it automatically.";
    case "CONCURRENT_ORDER": return "The account changed at the same moment (another order, a slot or a pause), so nothing was committed. The engine retries with the same order id.";
    case "SIGNAL_EXPIRED": return "The signal was not delivered in time (the engine was catching up), so it was not sent at a later, different price.";
    default: return null;
  }
}

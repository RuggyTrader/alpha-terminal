// Trade events, the activity feed and Web Push notifications (migration 0006).
//
// Every event is backed by an authoritative row; nothing here invents activity:
//   FUNDED_*      an accepted ALPHA PAPER fill (paper_fills) with the ledger's recorded P&L and fees (trades)
//   MIRROR_ENTRY  an explicit Strategy Mirror entry record sent by the engine (mirror_open_events), i.e. the
//                 simulated fill confirmed on its candle; never inferred from a pending limit order
//   MIRROR_CLOSE  a completed Strategy Mirror trade (mirror_trades): hypothetical gross and modelled net
// Each source row becomes exactly one event (unique event_key, cursor per source, one atomic batch). Each event is
// planned at most once per device (UNIQUE event + subscription) and sent at most once; retries never duplicate.
// This module runs AFTER the response (ctx.waitUntil): a failure here never blocks a signal, a fill or ingestion.

import { authorizePaperAction, hasValidSession, sameOriginOk } from "./auth_session";
import { allowedEndpoint, sendPush, validKeys, type VapidConfig } from "./webpush";

export interface EventsEnv {
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  DASHBOARD_PASSPHRASE?: string;
  DASHBOARD_ORIGINS?: string;
}

type Obj = Record<string, unknown>;
const json = (data: unknown, status = 200) => Response.json(data, { status });
const MAX_SUBSCRIPTIONS = 10;
const PUSHES_PER_RUN = 3;     // per invocation: ~0.9 ms CPU each (measured locally); inside Workers Free (50 subrequests, 10 ms CPU)
const MAX_ATTEMPTS = 6;
const CLAIM_TIMEOUT_MS = 5 * 60_000; // a claimed send not recorded within this time was interrupted
const SYNC_BATCH = 50;

// ------------------------------------------------------------------ schema presence (works before 0006 too)

let tablesKnown: Promise<Set<string>> | null = null;
export async function tables(db: D1Database): Promise<Set<string>> {
  tablesKnown ??= db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>()
    .then((r) => new Set(r.results.map((x) => x.name)))
    .catch(() => { tablesKnown = null; return new Set<string>(); });
  return tablesKnown;
}
export const resetTableCache = () => { tablesKnown = null; };
const ready = async (db: D1Database) => (await tables(db)).has("trade_events");

// ------------------------------------------------------------------ preferences

export interface Prefs {
  enabled: boolean;
  funded_entry: boolean; funded_close: boolean; mirror_entry: boolean; mirror_close: boolean;
  include_pnl: boolean; hide_amounts: boolean;
  include_catch_up: boolean; include_historical: boolean;
  bot_orders: boolean;  // a bot's limit order pending / cancelled (from its own engine reports)
  bot_stops: boolean;   // a bot's stop moved to break-even / trailing stop moved
  muted_bots?: string[];
}
export const DEFAULT_PREFS: Prefs = {
  enabled: true, funded_entry: true, funded_close: true, mirror_entry: true, mirror_close: true, bot_orders: true, bot_stops: true, muted_bots: [],
  include_pnl: true, hide_amounts: false,
  // Only genuine live events by default: no flood from warm-up replays or catch-up after the PC was off.
  include_catch_up: false, include_historical: false,
};
export function cleanPrefs(v: unknown, base: Prefs = DEFAULT_PREFS): Prefs {
  const o = v && typeof v === "object" ? (v as Obj) : {};
  const out = { ...base, muted_bots: [...(base.muted_bots ?? [])] };
  // Per-bot preference: bots whose events this device does not want (ALPHA-NN ids only).
  if (Array.isArray(o.muted_bots)) out.muted_bots = o.muted_bots.filter((x): x is string => typeof x === "string" && /^ALPHA-\d{2}$/.test(x)).slice(0, 20);
  for (const k of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) if (k !== "muted_bots" && typeof o[k] === "boolean") (out as unknown as Record<string, boolean>)[k] = o[k] as boolean;
  return out;
}

/** Whether one device wants one event. TEST events go only to the device that asked for them. */
export function wants(p: Prefs, e: { kind: string; classification: string; ref?: string | null; bot_id?: string | null }, subId: number): boolean {
  if (e.kind === "TEST") return e.ref === String(subId);
  if (!p.enabled) return false;
  if (e.bot_id && (p.muted_bots ?? []).includes(e.bot_id)) return false;
  if (e.classification === "historical" && !p.include_historical) return false;
  if (e.classification === "catch_up" && !p.include_catch_up) return false;
  if (e.kind === "FUNDED_ENTRY" || e.kind === "FUNDED_ADD") return p.funded_entry;
  if (e.kind === "FUNDED_CLOSE" || e.kind === "FUNDED_REDUCE") return p.funded_close;
  if (e.kind === "MIRROR_ENTRY") return p.mirror_entry;
  if (e.kind === "MIRROR_CLOSE") return p.mirror_close;
  if (e.kind === "ORDER_PENDING" || e.kind === "ORDER_CANCELLED") return p.bot_orders;
  if (e.kind === "STOP_TO_BREAK_EVEN" || e.kind === "TRAILING_STOP_MOVED") return p.bot_stops;
  return false;
}

// ------------------------------------------------------------------ message text

const usd = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
const px = (v: number) => (v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toPrecision(4));
const qty = (v: number) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4)).replace(/\.?0+$/, "");

export interface EventRow { id: number; event_key: string; kind: string; source: string; symbol: string | null; side: string | null; qty: number | null; price: number | null;
  pnl: number | null; pnl_net: number | null; fees: number | null; classification: string; ref: string | null; account_id: string | null; url: string | null; occurred_at: string;
  bot_id?: string | null; detail_json?: string | null }

/** The notification for one event and one device's preferences. Amounts are left out when hide_amounts is on. */
export function message(e: EventRow, p: Prefs): { title: string; body: string; url: string; tag: string } {
  const amounts = !p.hide_amounts;
  const pnl = amounts && p.include_pnl;
  const label = e.classification === "live" ? "" : e.classification === "catch_up" ? " (catch-up)" : " (historical)";
  const base = { url: e.url ?? "/", tag: e.event_key };
  // Fleet bots: "ALPHA 01 | SOLUSD 1m", then the recorded figures (never estimates).
  let d: Obj | null = null;
  try { d = e.detail_json ? JSON.parse(e.detail_json) : null; } catch { d = null; }
  if (e.bot_id && d) {
    const head = `${String(d.bot_name ?? e.bot_id)} | ${e.symbol} ${String(d.timeframe ?? "")}`.trim();
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    if (e.kind === "FUNDED_ENTRY") {
      const parts = amounts ? [e.price !== null ? `Entry $${px(e.price)}` : null, e.qty !== null ? `Qty ${qty(e.qty)}` : null,
        n(d.stop) !== null ? `Stop $${px(n(d.stop)!)}` : null, n(d.tp) !== null ? `Target $${px(n(d.tp)!)}` : null].filter(Boolean) : [];
      return { ...base, title: head, body: `PAPER ${String(e.side)} entered${parts.length ? ` · ${parts.join(" · ")}` : ""} · simulated${e.side === "SHORT" ? " (hypothetical short)" : ""}` };
    }
    if (e.kind === "FUNDED_CLOSE") {
      const parts = pnl ? [n(d.gross) !== null ? `Gross ${usd(n(d.gross)!)}` : null, n(e.fees) !== null ? `Fees $${e.fees!.toFixed(2)}` : null,
        n(e.pnl) !== null ? `Net ${usd(e.pnl!)}` : null, n(d.swept) !== null ? `Transferred to MAIN $${n(d.swept)!.toFixed(2)}` : null].filter(Boolean) : [];
      return { ...base, title: head, body: `PAPER ${String(e.side)} closed${parts.length ? ` · ${parts.join(" · ")}` : ""}` };
    }
    if (e.kind === "ORDER_PENDING") {
      const parts = amounts ? [e.price !== null ? `Limit $${px(e.price)}` : null, e.qty !== null ? `Qty ${qty(e.qty)}` : null,
        n(d.stop) !== null ? `Stop $${px(n(d.stop)!)}` : null, n(d.tp) !== null ? `Target $${px(n(d.tp)!)}` : null].filter(Boolean) : [];
      return { ...base, title: head, body: `${String(e.side)} limit order pending${parts.length ? ` · ${parts.join(" · ")}` : ""} · not filled yet` };
    }
    if (e.kind === "ORDER_CANCELLED") {
      return { ...base, title: head, body: `${String(e.side)} pending order cancelled before a fill${amounts && e.price !== null ? ` · limit was $${px(e.price)}` : ""}${d.reason ? ` · ${String(d.reason)}` : ""}` };
    }
    if (e.kind === "STOP_TO_BREAK_EVEN") {
      return { ...base, title: head, body: `${String(e.side)} stop moved to break-even${amounts && e.price !== null ? ` · stop $${px(e.price)}` : ""}` };
    }
    if (e.kind === "TRAILING_STOP_MOVED") {
      return { ...base, title: head, body: `${String(e.side)} trailing stop moved${amounts && e.price !== null ? ` to $${px(e.price)}` : ""}${amounts && n(d.previous_stop) !== null ? ` (was $${px(n(d.previous_stop)!)})` : ""}` };
    }
    if (e.kind === "MIRROR_ENTRY" || e.kind === "MIRROR_CLOSE") {
      const what = e.kind === "MIRROR_ENTRY" ? `${e.side} opened` : `closed${pnl && e.pnl !== null ? ` · ${usd(e.pnl)} hypothetical gross` : ""}`;
      return { ...base, title: head, body: `STRATEGY MIRROR (hypothetical) ${what}${label} · not an order` };
    }
  }
  switch (e.kind) {
    case "FUNDED_ENTRY": case "FUNDED_ADD":
      return { ...base, title: `ALPHA PAPER · ${e.symbol} ${String(e.side).toUpperCase()} filled`,
        body: amounts && e.qty !== null && e.price !== null ? `${qty(e.qty)} at $${px(e.price)} · simulated PAPER fill` : "Simulated PAPER fill" };
    case "FUNDED_CLOSE": case "FUNDED_REDUCE":
      return { ...base, title: `ALPHA PAPER · ${e.symbol} ${e.kind === "FUNDED_CLOSE" ? "closed" : "reduced"}${pnl && e.pnl !== null ? ` · ${usd(e.pnl)} PAPER P&L` : ""}`,
        body: amounts && e.price !== null ? `At $${px(e.price)}${pnl && e.fees ? ` · fees $${e.fees.toFixed(2)}` : ""} · simulated, not broker money` : "Simulated, not broker money" };
    case "MIRROR_ENTRY":
      return { ...base, title: `STRATEGY MIRROR · ${e.symbol} ${e.side} opened${label}`,
        body: `${amounts && e.qty !== null && e.price !== null ? `${qty(e.qty)} at $${px(e.price)} · ` : ""}Hypothetical, not an order` };
    case "MIRROR_CLOSE":
      return { ...base, title: `STRATEGY MIRROR · ${e.symbol} closed${pnl && e.pnl !== null ? ` · ${usd(e.pnl)} hypothetical gross` : ""}${label}`,
        body: `${pnl && e.pnl_net !== null ? `Modelled net ${usd(e.pnl_net)} (estimated costs) · ` : ""}Hypothetical, not executable performance` };
    default:
      return { ...base, title: "ALPHA TERMINAL · test notification", body: "Notifications work on this device. Delivery depends on device settings and the push service." };
  }
}

// ------------------------------------------------------------------ bot lifecycle (from a bot's own engine reports)

export interface LifecycleEvent { key: string; kind: "ORDER_PENDING" | "ORDER_CANCELLED" | "STOP_TO_BREAK_EVEN" | "TRAILING_STOP_MOVED"; side: string; qty: number | null;
  price: number | null; occurred_at: string; detail: Obj }
const numOr = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The lifecycle changes between a bot's previous and current engine report: a new pending limit order, a pending order
 * that disappeared without a fill, the stop moved to break-even, the trailing stop moved. Only what the engine recorded
 * in its structured strategy_state; nothing is inferred from text. Keys are deterministic, so a repeated report never
 * creates a second event.
 */
export function lifecycleEvents(prev: Obj | null, next: Obj, bot: { bot_id: string; name: string; timeframe: string }): LifecycleEvent[] {
  const st = (next.strategy_state && typeof next.strategy_state === "object" ? next.strategy_state : null) as Obj | null;
  const ps = (prev?.strategy_state && typeof prev.strategy_state === "object" ? prev.strategy_state : null) as Obj | null;
  if (!st) return [];
  const at = typeof next.last_candle_time === "string" ? next.last_candle_time : new Date().toISOString();
  const pos = (next.position && typeof next.position === "object" ? next.position : null) as Obj | null;
  const out: LifecycleEvent[] = [];
  const base = { bot_name: bot.name, timeframe: bot.timeframe };
  const po = (st.pending_order && typeof st.pending_order === "object" ? st.pending_order : null) as Obj | null;
  const ppo = (ps?.pending_order && typeof ps.pending_order === "object" ? ps.pending_order : null) as Obj | null;
  const orderKey = (o: Obj, s: Obj | null) => `${bot.bot_id}:${String(o.side)}:${numOr(s?.leg_start)}:${numOr(s?.leg_end)}:${numOr(o.limit)}:${numOr(o.stop)}`;
  if (po && (!ppo || orderKey(po, st) !== orderKey(ppo, ps))) {
    out.push({ key: `BOTPEND:${orderKey(po, st)}`, kind: "ORDER_PENDING", side: String(po.side), qty: numOr(po.qty), price: numOr(po.limit), occurred_at: at,
      detail: { ...base, stop: numOr(po.stop), tp: numOr(po.tp) } });
  }
  if (ppo && (!po || orderKey(po, st) !== orderKey(ppo, ps)) && !pos) {
    out.push({ key: `BOTCANCEL:${orderKey(ppo, ps)}`, kind: "ORDER_CANCELLED", side: String(ppo.side), qty: numOr(ppo.qty), price: numOr(ppo.limit), occurred_at: at,
      detail: { ...base, stop: numOr(ppo.stop), tp: numOr(ppo.tp), reason: po ? "replaced by a new setup" : "setup expired or invalidated (engine record)" } });
  }
  if (pos && pos.side) {
    const tradeKey = `${bot.bot_id}:${String(pos.side)}:${numOr(pos.entry)}`;
    const stop = numOr(st.current_stop);
    if (st.break_even_done === true && ps?.break_even_done !== true) {
      out.push({ key: `BOTBE:${tradeKey}`, kind: "STOP_TO_BREAK_EVEN", side: String(pos.side), qty: numOr(pos.qty), price: stop, occurred_at: at, detail: { ...base, entry: numOr(pos.entry) } });
    }
    if (st.trailing === true && stop !== null && stop !== numOr(ps?.current_stop)) {
      out.push({ key: `BOTTRAIL:${tradeKey}:${stop}`, kind: "TRAILING_STOP_MOVED", side: String(pos.side), qty: numOr(pos.qty), price: stop, occurred_at: at,
        detail: { ...base, entry: numOr(pos.entry), previous_stop: numOr(ps?.current_stop) } });
    }
  }
  return out;
}

/** Records lifecycle events (INSERT OR IGNORE by key). Before the schema allows these kinds it records nothing. */
export async function recordLifecycle(db: D1Database, bot: { bot_id: string; name: string; symbol: string; timeframe: string }, events: LifecycleEvent[], now = new Date().toISOString()): Promise<number> {
  if (!events.length || !(await ready(db))) return 0;
  try {
    await db.batch(events.map((e) => db.prepare(
      `INSERT OR IGNORE INTO trade_events (event_key, kind, source, symbol, side, qty, price, pnl, pnl_net, fees, classification, ref, account_id, url, occurred_at, created_at, bot_id, detail_json)
       VALUES (?, ?, 'funded', ?, ?, ?, ?, NULL, NULL, NULL, 'live', NULL, NULL, ?, ?, ?, ?, ?)`).bind(
      e.key, e.kind, bot.symbol, e.side, e.qty, e.price, `/bots/${encodeURIComponent(bot.bot_id)}/chart`, e.occurred_at, now, bot.bot_id, JSON.stringify(e.detail))));
    return events.length;
  } catch {
    return 0; // schema before migration 0007 (kind CHECK / columns): lifecycle notifications are simply not recorded yet
  }
}

// ------------------------------------------------------------------ source rows -> events (idempotent)

const mirrorSymbol = (tradeId: string) => /^MIR-([A-Z0-9]+)-/.exec(tradeId)?.[1] ?? null;

/** Turns new authoritative rows into events. Bounded: ≤ 4 queries and ≤ 50 rows per source per call. */
export async function syncTradeEvents(db: D1Database, now = new Date().toISOString()): Promise<number> {
  if (!(await ready(db))) return 0;
  const t = await tables(db);
  const cur = Object.fromEntries((await db.prepare(`SELECT name, last_id FROM event_cursors`).all<{ name: string; last_id: number }>()).results.map((r) => [r.name, r.last_id]));
  const stmts: D1PreparedStatement[] = [];
  const add = (key: string, e: Omit<EventRow, "id" | "event_key"> & { source: string }) => stmts.push(db.prepare(
    `INSERT OR IGNORE INTO trade_events (event_key, kind, source, symbol, side, qty, price, pnl, pnl_net, fees, classification, ref, account_id, url, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(key, e.kind, e.source, e.symbol, e.side, e.qty, e.price, e.pnl, e.pnl_net, e.fees, e.classification, e.ref, e.account_id, e.url, e.occurred_at, now));
  const cursor = (name: string, id: number) => stmts.push(db.prepare(`UPDATE event_cursors SET last_id = ? WHERE name = ? AND last_id < ?`).bind(id, name, id));

  // Funded PAPER fills (accepted, committed). P&L and fees come from the ledger's own trade row.
  const fills = (await db.prepare(
    `SELECT f.id, f.kind, f.side, f.symbol, f.qty, f.price, f.realized_pnl, f.fee_micro, f.filled_at, tr.id AS trade_id, tr.realized_pnl AS trade_pnl, tr.fees_usd AS trade_fees
     FROM paper_fills f LEFT JOIN trades tr ON tr.position_fk = f.position_fk
     WHERE f.id > ? ORDER BY f.id LIMIT ?`).bind(cur.paper_fills ?? 0, SYNC_BATCH).all<Obj>()).results;
  for (const f of fills) {
    const kind = { OPEN: "FUNDED_ENTRY", ADD: "FUNDED_ADD", REDUCE: "FUNDED_REDUCE", CLOSE: "FUNDED_CLOSE" }[String(f.kind)] ?? "FUNDED_ENTRY";
    const closing = kind === "FUNDED_CLOSE";
    const pnl = closing ? Number(f.trade_pnl ?? f.realized_pnl) : kind === "FUNDED_REDUCE" ? Number(f.realized_pnl) : null;
    const fees = closing && f.trade_fees !== null && f.trade_fees !== undefined ? Number(f.trade_fees) : f.fee_micro ? Number(f.fee_micro) / 1e6 : null;
    add(`FILL:${f.id}`, { kind, source: "funded", symbol: String(f.symbol), side: String(f.side), qty: Number(f.qty), price: Number(f.price), pnl, pnl_net: pnl, fees,
      classification: "live", ref: f.trade_id === null || f.trade_id === undefined ? null : String(f.trade_id), account_id: null,
      url: f.trade_id ? `/trades/${f.trade_id}` : "/trades", occurred_at: String(f.filled_at) });
  }
  if (fills.length) cursor("paper_fills", Number(fills[fills.length - 1].id));

  // Strategy Mirror entries (explicit engine records) and completed trades.
  if (t.has("mirror_open_events")) {
    const opens = (await db.prepare(`SELECT * FROM mirror_open_events WHERE id > ? ORDER BY id LIMIT ?`).bind(cur.mirror_open_events ?? 0, SYNC_BATCH).all<Obj>()).results;
    for (const o of opens) {
      add(`MOPEN:${o.id}`, { kind: "MIRROR_ENTRY", source: "mirror", symbol: mirrorSymbol(String(o.trade_id)), side: String(o.side), qty: Number(o.qty), price: Number(o.entry_price),
        pnl: null, pnl_net: null, fees: null, classification: String(o.classification), ref: String(o.trade_id), account_id: String(o.account_id),
        url: `/mirror?account=${encodeURIComponent(String(o.account_id))}`, occurred_at: String(o.entry_time) });
    }
    if (opens.length) cursor("mirror_open_events", Number(opens[opens.length - 1].id));
  }
  const closes = (await db.prepare(
    `SELECT id, account_id, trade_id, side, qty, exit_price, exit_time, gross_pnl, net_modelled_pnl, est_fees, est_slippage, classification
     FROM mirror_trades WHERE id > ? ORDER BY id LIMIT ?`).bind(cur.mirror_trades ?? 0, SYNC_BATCH).all<Obj>()).results;
  for (const c of closes) {
    add(`MCLOSE:${c.id}`, { kind: "MIRROR_CLOSE", source: "mirror", symbol: mirrorSymbol(String(c.trade_id)), side: String(c.side), qty: Number(c.qty), price: Number(c.exit_price),
      pnl: Number(c.gross_pnl), pnl_net: Number(c.net_modelled_pnl), fees: Number(c.est_fees) + Number(c.est_slippage), classification: String(c.classification),
      ref: String(c.trade_id), account_id: String(c.account_id),
      url: `/mirror/trade/${encodeURIComponent(String(c.trade_id))}?account=${encodeURIComponent(String(c.account_id))}`, occurred_at: String(c.exit_time) });
  }
  if (closes.length) cursor("mirror_trades", Number(closes[closes.length - 1].id));

  // Fleet bots (migration 0007): every bot fill, labelled with its bot and the recorded figures.
  let botFills: Obj[] = [];
  if (t.has("bot_fills")) {
    botFills = (await db.prepare(
      `SELECT f.id, f.kind, f.side, f.qty, f.price, f.fee_micro, f.filled_at, f.trade_id, b.bot_id, b.name, b.symbol, b.timeframe_min,
              p.stop, p.tp, p.gross_pnl_micro, p.net_pnl_micro, p.entry_fee_micro, p.exit_fee_micro, p.swept_micro
       FROM bot_fills f JOIN bots b ON b.bot_id = f.bot_id LEFT JOIN bot_positions p ON p.trade_id = f.trade_id
       WHERE f.id > ? ORDER BY f.id LIMIT ?`).bind(cur.bot_fills ?? 0, SYNC_BATCH).all<Obj>()).results;
    for (const f of botFills) {
      const exit = f.kind === "EXIT";
      const detail = { bot_name: f.name, timeframe: `${f.timeframe_min}m`, stop: f.stop, tp: f.tp,
        gross: exit && f.gross_pnl_micro !== null ? Number(f.gross_pnl_micro) / 1e6 : null, swept: exit ? Number(f.swept_micro ?? 0) / 1e6 : null };
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO trade_events (event_key, kind, source, symbol, side, qty, price, pnl, pnl_net, fees, classification, ref, account_id, url, occurred_at, created_at, bot_id, detail_json)
         VALUES (?, ?, 'funded', ?, ?, ?, ?, ?, ?, ?, 'live', ?, NULL, ?, ?, ?, ?, ?)`).bind(
        `BOTFILL:${f.id}`, exit ? "FUNDED_CLOSE" : "FUNDED_ENTRY", String(f.symbol), String(f.side), Number(f.qty), Number(f.price),
        exit && f.net_pnl_micro !== null ? Number(f.net_pnl_micro) / 1e6 : null, exit && f.net_pnl_micro !== null ? Number(f.net_pnl_micro) / 1e6 : null,
        exit ? (Number(f.entry_fee_micro ?? 0) + Number(f.exit_fee_micro ?? 0)) / 1e6 : Number(f.fee_micro) / 1e6,
        String(f.trade_id), `/bots/trade/${encodeURIComponent(String(f.trade_id))}`, String(f.filled_at), now, String(f.bot_id), JSON.stringify(detail)));
    }
    if (botFills.length) cursor("bot_fills", Number(botFills[botFills.length - 1].id));
    // Mirror events of a fleet bot carry the bot label too (the account's bot, migration 0007).
    stmts.push(db.prepare(`UPDATE trade_events SET bot_id = (SELECT a.bot_id FROM mirror_accounts a WHERE a.account_id = trade_events.account_id),
        detail_json = (SELECT json_object('bot_name', b.name, 'timeframe', b.timeframe_min || 'm') FROM mirror_accounts a JOIN bots b ON b.bot_id = a.bot_id WHERE a.account_id = trade_events.account_id)
      WHERE source = 'mirror' AND bot_id IS NULL AND account_id IS NOT NULL AND id > (SELECT COALESCE(MAX(id), 0) - 200 FROM trade_events)`));
  }
  if (stmts.length) await db.batch(stmts); // events and cursor moves together: all or nothing
  return fills.length + closes.length + botFills.length;
}

// ------------------------------------------------------------------ delivery

export function vapidOf(env: EventsEnv): VapidConfig | null {
  return env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
    ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT } : null;
}

/** Plans new events per device, then sends up to PUSHES_PER_RUN pending notifications. Never throws. */
export async function deliver(env: EventsEnv, opts: { fetcher?: typeof fetch; now?: number; only?: number } = {}): Promise<{ planned: number; sent: number; failed: number }> {
  const out = { planned: 0, sent: 0, failed: 0 };
  const vapid = vapidOf(env);
  if (!vapid || !(await ready(env.DB))) return out;
  const db = env.DB;
  const nowMs = opts.now ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const subs = (await db.prepare(`SELECT id, endpoint, p256dh, auth, prefs_json FROM push_subscriptions WHERE disabled_at IS NULL`).all<Obj>()).results;
  if (!subs.length) return out;

  // 1. Plan: every event after the planning cursor gets one row per device (pending or skipped). Idempotent.
  await db.prepare(`INSERT OR IGNORE INTO event_cursors (name, last_id) VALUES ('push_planned', (SELECT COALESCE(MAX(id), 0) FROM trade_events WHERE kind <> 'TEST'))`).run();
  const planned = (await db.prepare(`SELECT last_id FROM event_cursors WHERE name = 'push_planned'`).first<{ last_id: number }>())?.last_id ?? 0;
  const events = (await db.prepare(`SELECT * FROM trade_events WHERE id > ? ORDER BY id LIMIT 20`).bind(planned).all<EventRow>()).results;
  if (events.length) {
    const stmts: D1PreparedStatement[] = [];
    for (const e of events) for (const s of subs) {
      const want = wants(cleanPrefs(JSON.parse(String(s.prefs_json))), e, Number(s.id));
      stmts.push(db.prepare(`INSERT OR IGNORE INTO push_deliveries (event_id, subscription_id, status, created_at) VALUES (?, ?, ?, ?)`).bind(e.id, s.id, want ? "pending" : "skipped", now));
    }
    stmts.push(db.prepare(`UPDATE event_cursors SET last_id = ? WHERE name = 'push_planned' AND last_id < ?`).bind(events[events.length - 1].id, events[events.length - 1].id));
    await db.batch(stmts);
    out.planned = events.length;
  }

  // 2. A send that was claimed but never recorded (invocation cut off mid-send): its outcome is unknown. It is NOT
  //    sent again, so a device can never get the same notification twice (at most once per event per device).
  await db.prepare(`UPDATE push_deliveries SET status = 'failed', error = 'outcome unknown (interrupted); not resent to avoid a duplicate'
    WHERE status = 'sending' AND last_attempt_at < ?`).bind(new Date(nowMs - CLAIM_TIMEOUT_MS).toISOString()).run();

  // 3. Send: oldest pending first, with backoff between attempts.
  const candidates = (await db.prepare(
    `SELECT d.id AS delivery_id, d.attempts, d.last_attempt_at, s.id AS sub_id, s.endpoint, s.p256dh, s.auth, s.prefs_json, e.*
     FROM push_deliveries d JOIN push_subscriptions s ON s.id = d.subscription_id JOIN trade_events e ON e.id = d.event_id
     WHERE d.status = 'pending' AND s.disabled_at IS NULL ${opts.only ? "AND d.subscription_id = ?" : ""} ORDER BY d.id LIMIT ?`
  ).bind(...(opts.only ? [opts.only, PUSHES_PER_RUN * 4] : [PUSHES_PER_RUN * 4])).all<Obj>()).results
    .filter((r) => !r.last_attempt_at || nowMs - Date.parse(String(r.last_attempt_at)) >= 30_000 * Number(r.attempts))
    .slice(0, PUSHES_PER_RUN);
  if (!candidates.length) return out;
  // Claim before sending: only the invocation whose conditional update changed the row sends it. Overlapping
  // invocations (two engine requests at once) therefore never send the same notification twice.
  const claims = await db.batch(candidates.map((r) => db.prepare(
    `UPDATE push_deliveries SET status = 'sending', last_attempt_at = ? WHERE id = ? AND status = 'pending'`).bind(now, r.delivery_id)));
  const pending = candidates.filter((_, i) => (claims[i]?.meta?.changes ?? 0) === 1);
  const updates: D1PreparedStatement[] = [];
  for (const r of pending) {
    const prefs = cleanPrefs(JSON.parse(String(r.prefs_json)));
    const msg = message(r as unknown as EventRow, prefs);
    const res = await sendPush({ endpoint: String(r.endpoint), p256dh: String(r.p256dh), auth: String(r.auth) }, { ...msg, ts: r.occurred_at }, vapid, { fetcher: opts.fetcher });
    const attempts = Number(r.attempts) + 1;
    if (res.ok) {
      out.sent += 1;
      updates.push(db.prepare(`UPDATE push_deliveries SET status = 'sent', attempts = ?, last_attempt_at = ?, sent_at = ?, error = NULL WHERE id = ?`).bind(attempts, now, now, r.delivery_id));
      updates.push(db.prepare(`UPDATE push_subscriptions SET last_success_at = ?, failures = 0, last_error = NULL WHERE id = ?`).bind(now, r.sub_id));
    } else {
      out.failed += 1;
      const final = res.gone ? "expired" : !res.retry || attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      updates.push(db.prepare(`UPDATE push_deliveries SET status = ?, attempts = ?, last_attempt_at = ?, error = ? WHERE id = ?`).bind(final, attempts, now, res.error, r.delivery_id));
      updates.push(res.gone
        ? db.prepare(`UPDATE push_subscriptions SET disabled_at = ?, disabled_reason = ?, last_error = ? WHERE id = ?`).bind(now, "push service reports the subscription expired", res.error, r.sub_id)
        : db.prepare(`UPDATE push_subscriptions SET failures = failures + 1, last_error = ? WHERE id = ?`).bind(res.error, r.sub_id));
    }
  }
  if (updates.length) await db.batch(updates);
  return out;
}

/** Called after event-producing requests (ctx.waitUntil). Swallows every error: ingestion is never affected. */
export async function processEvents(env: EventsEnv): Promise<void> {
  try {
    await syncTradeEvents(env.DB);
    await deliver(env);
  } catch (e) {
    console.log(`[events] ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

// ------------------------------------------------------------------ activity feed (read-only, session)

/** The one status mapping for a funded signal: the same words as the Trades page (frontend classify.ts alertLabel) (no view may say "accepted" for a
 *  signal that is still processing or that failed). */
export function signalState(status: string, code: string | null): { label: string; tone: FeedItem["tone"] } {
  if (status === "dry_run" || code === "DRY_RUN_ACCEPTED") return { label: "DRY-RUN ACCEPTED", tone: "ok" };
  if (status === "rejected") return { label: "REJECTED", tone: "bad" };
  if (status === "processing") return { label: "PROCESSING", tone: "muted" };
  if (status === "error") return { label: "ERROR", tone: "bad" };
  return { label: status.toUpperCase(), tone: "muted" };
}

export interface FeedItem { id: string; at: string; source: "funded" | "mirror" | "system"; symbol: string | null; title: string; outcome: string; tone: "ok" | "bad" | "warn" | "info" | "muted"; url: string | null; classification?: string;
  /** The canonical source records this item presents (the accepted signal or bot order behind a fill event). */
  refs?: string[] }

/** Recent genuine activity: trade events, funded signals and their outcomes, the engine heartbeat, observation gaps. */
export async function activityFeed(db: D1Database, limit = 30): Promise<{ items: FeedItem[]; generated_at: string }> {
  const n = Math.min(Math.max(limit, 1), 50);
  const items: FeedItem[] = [];
  const t = await tables(db);
  // ONE item per execution. A fill event (trade_events FILL:<paper_fills.id> / BOTFILL:<bot_fills.id>) and the accepted
  // signal or bot order that produced it are the same execution; both records are kept unchanged in the database, but the
  // feed presents the fill event (it carries the figures) and lists the source record in `refs`. The source record is
  // hidden ONLY when its own fill event is in this same response, so an execution never disappears from the feed.
  // Refusals, processing and errors have no fill and are always shown.
  const presented = new Set<string>();
  if (t.has("trade_events")) {
    const srcLegacy = `CASE WHEN e.event_key LIKE 'FILL:%' THEN (SELECT pf.alert_id FROM paper_fills pf WHERE pf.id = CAST(substr(e.event_key, 6) AS INTEGER)) END`;
    const srcBot = t.has("bot_fills") ? `CASE WHEN e.event_key LIKE 'BOTFILL:%' THEN (SELECT bf.fill_id FROM bot_fills bf WHERE bf.id = CAST(substr(e.event_key, 9) AS INTEGER)) END` : "NULL";
    for (const e of (await db.prepare(`SELECT e.*, ${srcLegacy} AS src_alert, ${srcBot} AS src_order FROM trade_events e WHERE e.kind <> 'TEST' ORDER BY e.id DESC LIMIT ?`)
      .bind(n).all<EventRow & { src_alert: string | null; src_order: string | null }>()).results) {
      const m = message(e, DEFAULT_PREFS);
      const tone = e.pnl === null ? "info" : e.pnl > 0 ? "ok" : e.pnl < 0 ? "bad" : "muted";
      const refs = [e.src_alert, e.src_order].filter((x): x is string => typeof x === "string" && x !== "");
      refs.forEach((r) => presented.add(r));
      items.push({ id: `E${e.id}`, at: e.occurred_at, source: e.source as FeedItem["source"], symbol: e.symbol, title: m.title, outcome: m.body, tone, url: e.url, classification: e.classification,
        ...(refs.length ? { refs } : {}) });
    }
  }
  for (const a of (await db.prepare(`SELECT id, alert_id, received_at, symbol, action, status, response_code, rejection_reason FROM alerts ORDER BY id DESC LIMIT ?`).bind(n).all<Obj>()).results) {
    // ONE status mapping, shared with the Trades page (signalState): processing and error are never shown as accepted.
    const st = signalState(String(a.status), a.response_code === null ? null : String(a.response_code));
    if (st.tone === "ok" && presented.has(String(a.alert_id))) continue; // shown once, as its fill event
    items.push({ id: `A${a.id}`, at: String(a.received_at), source: "funded", symbol: String(a.symbol), title: `${String(a.symbol)} ${String(a.action).toUpperCase()} signal ${st.label}`,
      outcome: `${String(a.alert_id)} · ${a.response_code ?? a.status}${a.rejection_reason ? `: ${String(a.rejection_reason).slice(0, 120)}` : ""}`, tone: st.tone,
      url: `/trades?signal=${encodeURIComponent(String(a.alert_id))}` });
  }
  // Fleet bot orders (migration 0007), under the SAME order id the engine, the ledger and the trade proof use.
  if ((await tables(db)).has("bot_orders")) {
    for (const o of (await db.prepare(`SELECT o.order_id, o.bot_id, o.action, o.symbol, o.status, o.code, o.message, o.received_at, b.name, b.timeframe_min FROM bot_orders o JOIN bots b ON b.bot_id = o.bot_id ORDER BY o.received_at DESC LIMIT ?`).bind(n).all<Obj>()).results) {
      const ok = o.status === "ACCEPTED";
      if (ok && presented.has(String(o.order_id))) continue; // shown once, as its fill event
      items.push({ id: `O${String(o.order_id)}`, at: String(o.received_at), source: "funded", symbol: String(o.symbol),
        title: `${String(o.name)} | ${String(o.symbol)} ${String(o.timeframe_min)}m · ${String(o.action).replace("_", " ")} ${ok ? "filled (PAPER)" : "refused"}`,
        outcome: `${String(o.order_id)} · ${String(o.code)}${o.message ? `: ${String(o.message).slice(0, 120)}` : ""}`, tone: ok ? "ok" : "warn",
        url: `/bots?bot=${encodeURIComponent(String(o.bot_id))}` });
    }
  }
  const hb = await db.prepare(`SELECT value FROM app_meta WHERE key = 'engine_status'`).first<{ value: string }>();
  if (hb) {
    try {
      const s = JSON.parse(hb.value) as Obj;
      if (s.last_candle_time) items.push({ id: `C${s.symbol}${s.last_candle_time}`, at: String(s.received_at ?? s.last_candle_time), source: "system", symbol: String(s.symbol),
        title: `${s.symbol} candle ${String(s.last_candle_time).slice(11, 16)} processed`, outcome: String(s.status_text ?? ""), tone: "muted", url: "/engine" });
    } catch { /* malformed heartbeat: nothing shown */ }
  }
  if (t.has("mirror_accounts")) {
    for (const a of (await db.prepare(`SELECT account_id, symbol, engine_health_json FROM mirror_accounts`).all<Obj>()).results) {
      let gaps: Obj[] = [];
      try { gaps = (JSON.parse(String(a.engine_health_json ?? "{}")).observation_gaps ?? []) as Obj[]; } catch { gaps = []; }
      for (const g of gaps.slice(-3)) items.push({ id: `G${a.account_id}${g.from}`, at: String(g.processed_at ?? g.to), source: "system", symbol: String(a.symbol),
        title: `${a.symbol} observation gap`, outcome: `${g.candles} candles ${String(g.from).slice(5, 16)} → ${String(g.to).slice(5, 16)} processed late (catch-up)`, tone: "warn",
        url: `/mirror?account=${encodeURIComponent(String(a.account_id))}` });
    }
  }
  items.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.id < y.id ? 1 : -1));
  return { items: items.slice(0, n), generated_at: new Date().toISOString() };
}

// ------------------------------------------------------------------ notification API (/api/notifications/*)

async function readJson(request: Request): Promise<Obj | Response> {
  const text = await request.text();
  if (text.length > 8192) return json({ ok: false, code: "TOO_LARGE" }, 413);
  try {
    const b = JSON.parse(text);
    return b && typeof b === "object" ? (b as Obj) : json({ ok: false, code: "INVALID_JSON" }, 400);
  } catch {
    return json({ ok: false, code: "INVALID_JSON" }, 400);
  }
}

export async function handleNotificationsApi(request: Request, env: EventsEnv, pathname: string): Promise<Response> {
  if (!(await hasValidSession(request, env as never))) return json({ ok: false, code: "UNAUTHORIZED", message: "Sign in first" }, 401);
  const db = env.DB;
  const vapid = vapidOf(env);
  if (pathname === "/api/notifications/config" && request.method === "GET") {
    const has = await ready(db);
    const active = has ? (await db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE disabled_at IS NULL`).first<{ n: number }>())?.n ?? 0 : 0;
    return json({ ok: true, data: { available: !!vapid && has, public_key: vapid?.publicKey ?? null, devices: active, max_devices: MAX_SUBSCRIPTIONS,
      reason: !vapid ? "Push keys are not configured on the Worker yet" : !has ? "The notifications database migration has not been applied yet" : null, defaults: DEFAULT_PREFS } });
  }
  if (request.method !== "POST") return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  if (!sameOriginOk(request, env as never)) return json({ ok: false, code: "ORIGIN_NOT_ALLOWED" }, 403);
  if (!vapid || !(await ready(db))) return json({ ok: false, code: "NOT_AVAILABLE", message: "Notifications are not set up on this Worker" }, 503);
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const now = new Date().toISOString();
  const sub = body.subscription && typeof body.subscription === "object" ? (body.subscription as Obj) : null;
  const endpoint = sub ? sub.endpoint : body.endpoint;
  if (!allowedEndpoint(endpoint)) return json({ ok: false, code: "INVALID_ENDPOINT", message: "Not a push service endpoint" }, 400);

  if (pathname === "/api/notifications/subscribe") {
    // Enabling a device needs the passphrase typed again: a stolen session alone cannot route trade alerts elsewhere.
    const denied = await authorizePaperAction(request, env as never, body.passphrase);
    if (denied) return denied;
    const keys = sub && sub.keys && typeof sub.keys === "object" ? (sub.keys as Obj) : {};
    if (!validKeys(keys.p256dh, keys.auth)) return json({ ok: false, code: "INVALID_KEYS" }, 400);
    const exists = await db.prepare(`SELECT id FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).first<{ id: number }>();
    if (!exists) {
      const n = (await db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE disabled_at IS NULL`).first<{ n: number }>())?.n ?? 0;
      if (n >= MAX_SUBSCRIPTIONS) return json({ ok: false, code: "TOO_MANY_DEVICES", message: `At most ${MAX_SUBSCRIPTIONS} devices` }, 409);
    }
    const prefs = cleanPrefs(body.prefs);
    const label = typeof body.label === "string" ? body.label.slice(0, 60) : null;
    await db.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, prefs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, prefs_json = excluded.prefs_json,
         updated_at = excluded.updated_at, disabled_at = NULL, disabled_reason = NULL, failures = 0`
    ).bind(endpoint, keys.p256dh, keys.auth, label, JSON.stringify(prefs), now, now).run();
    // Start this device after everything already planned: no backlog of older events.
    await db.prepare(`INSERT OR IGNORE INTO event_cursors (name, last_id) VALUES ('push_planned', (SELECT COALESCE(MAX(id), 0) FROM trade_events))`).run();
    return json({ ok: true, prefs });
  }

  const row = await db.prepare(`SELECT id, prefs_json, disabled_at, last_success_at, last_error FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).first<Obj>();
  if (!row) return json({ ok: false, code: "NOT_SUBSCRIBED", message: "This device has not enabled notifications" }, 404);
  if (pathname === "/api/notifications/status") {
    return json({ ok: true, prefs: cleanPrefs(JSON.parse(String(row.prefs_json))), active: row.disabled_at === null, last_success_at: row.last_success_at, last_error: row.last_error });
  }
  if (pathname === "/api/notifications/preferences") {
    const prefs = cleanPrefs(body.prefs, cleanPrefs(JSON.parse(String(row.prefs_json))));
    await db.prepare(`UPDATE push_subscriptions SET prefs_json = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(prefs), now, row.id).run();
    return json({ ok: true, prefs });
  }
  if (pathname === "/api/notifications/unsubscribe") {
    await db.prepare(`UPDATE push_subscriptions SET disabled_at = ?, disabled_reason = 'disabled on the device' WHERE id = ?`).bind(now, row.id).run();
    return json({ ok: true });
  }
  if (pathname === "/api/notifications/test") {
    if (row.disabled_at !== null) return json({ ok: false, code: "DISABLED" }, 409);
    const recent = await db.prepare(`SELECT created_at FROM trade_events WHERE kind = 'TEST' AND ref = ? ORDER BY id DESC LIMIT 1`).bind(String(row.id)).first<{ created_at: string }>();
    if (recent && Date.now() - Date.parse(recent.created_at) < 30_000) return json({ ok: false, code: "TOO_SOON", message: "Wait 30 seconds between test notifications" }, 429);
    await db.prepare(`INSERT INTO trade_events (event_key, kind, source, classification, ref, url, occurred_at, created_at) VALUES (?, 'TEST', 'system', 'live', ?, '/settings', ?, ?)`)
      .bind(`TEST:${row.id}:${Date.now()}`, String(row.id), now, now).run();
    const r = await deliver(env, { only: Number(row.id) });
    return json({ ok: true, sent: r.sent, failed: r.failed });
  }
  return json({ ok: false, code: "NOT_FOUND" }, 404);
}

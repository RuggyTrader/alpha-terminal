// Strategy Mirror V1: the original strategy's HYPOTHETICAL TradingView-style trades (engine/src/mirror.mjs), kept
// completely apart from the funded ALPHA PAPER ledger.
//
//   POST /webhook/engine-mirror   {secret, account, items[]}  engine → Worker, authenticated with WEBHOOK_SECRET
//   GET  /api/dashboard/mirror[...]                           read-only, dashboard session (dashboard_api.ts)
//
// * Writes ONLY mirror_accounts, mirror_trades and mirror_entries (migration 0005). It never reads or writes the
//   funded tables (portfolio_*, paper_*, trades, alerts, orders, risk_decisions) and never contacts a broker.
// * Idempotent: a record is identified by its trade id (or event id) and its sequence number. A retry with the same
//   content is a `duplicate`; different content under an existing id or sequence is a `conflict`, stored nowhere and
//   counted, never overwritten. Each trade and its journal entry are written in one D1 batch (all or nothing), so an
//   interrupted request leaves either both or neither.
// * Gaps in the sequence (a record the engine numbered but the Worker never stored) are detected and reported.
// * Margin 0, as in the TradingView properties: unlimited buying power. Results are hypothetical, not executable.
// * Costs are a labelled COMPARISON (worker/src/costs.ts profiles, maker/taker inferred from order types); they are
//   never charged to any balance and never change the gross (TradingView, 0% commission) baseline.

import { COST_PROFILES, execute, type CostProfile } from "./costs";
import { getInstrument, referencePrice } from "./instruments";
import { secureEqual } from "./trade_core";

interface MirrorEnv {
  DB: D1Database;
  WEBHOOK_SECRET: string;
  KRAKEN_API_BASE?: string;
}

export const MIRROR_LABEL = "Hypothetical — unlimited buying power, not executable performance";
export const MIRROR_DISCLOSURE =
  "Strategy Mirror trades are the original strategy's own simulated fills on completed Kraken candles (limit orders at their limit price, stops at their stop, TradingView's documented intrabar path), with TradingView's margin-0 property: no buying-power limit and no liquidation. They are not orders, not exchange executions and not funded PAPER results. Cost figures are a comparison model; maker/taker is inferred from order types, not verified against an order book.";

const MAX_BYTES = 1_000_000;
const MAX_ITEMS = 200;
const CATEGORIES = ["historical", "catch_up", "live"] as const;
type Category = (typeof CATEGORIES)[number];
const RESULTS = ["TP2", "SL", "BREAK_EVEN", "TRAILING_SL", "TIME_EXIT", "SAME_BAR", "UNLABELLED"];
const EXIT_KINDS = ["TP", "SL", "CLOSE_ALL"];

const json = (data: unknown, status = 200) => Response.json(data, { status });
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pos = (v: unknown): v is number => fin(v) && v > 0;
const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.length <= max ? v : null);
const isoMs = (v: unknown): number | null => {
  if (typeof v !== "string" || v.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const isoOrNull = (v: unknown): string | null => (isoMs(v) === null ? null : (v as string));
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Stable JSON (sorted keys), so a retried record hashes identically. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ validation

interface Account {
  account_id: string; symbol: string; timeframe: string; tfMs: number; profile: string | null; strategy: string | null;
  inputs_hash: string; engine_version: string | null; engine_release: string | null; engine_commit: string | null;
  created_at: string | null; activated_at: string | null; last_candle_time: string | null; last_candle_close: number | null;
  candles_processed: number | null; risk_usd: number | null; last_seq: number | null; open_position: Obj | null; health: Obj;
}

function validateAccount(a: unknown): Account | string {
  if (!isObj(a)) return "account must be an object";
  const symbol = str(a.symbol, 16);
  if (!symbol || !getInstrument(symbol)) return "account.symbol must be a supported instrument";
  const timeframe = str(a.timeframe, 8);
  const m = timeframe ? /^(\d{1,3})m$/.exec(timeframe) : null;
  if (!m || !(Number(m[1]) > 0)) return "account.timeframe must look like '5m'";
  const inputs = str(a.inputs_hash, 64);
  if (!inputs || !/^[0-9a-f]{8,64}$/.test(inputs)) return "account.inputs_hash must be hex";
  const id = str(a.account_id, 120);
  if (id !== `MIRROR-${symbol}-${timeframe}-${inputs}`) return "account.account_id does not match symbol, timeframe and inputs_hash";
  const op = isObj(a.open_position) ? a.open_position : null;
  const health: Obj = {};
  for (const k of ["pending", "refused", "resets", "interruptions", "skipped_candles"]) if (fin(a[k])) health[k] = a[k];
  if (isObj(a.last_error)) health.last_error = { at: isoOrNull(a.last_error.at), where: str(a.last_error.where, 40), message: str(String(a.last_error.message ?? ""), 240) };
  return {
    account_id: id, symbol, timeframe, tfMs: Number(m[1]) * 60_000, profile: str(a.profile, 40), strategy: str(a.strategy, 64),
    inputs_hash: inputs, engine_version: str(a.engine_version, 20), engine_release: str(a.engine_release, 40), engine_commit: str(a.engine_commit, 40),
    created_at: isoOrNull(a.created_at), activated_at: isoOrNull(a.activated_at), last_candle_time: isoOrNull(a.last_candle_time),
    last_candle_close: fin(a.last_candle_close) ? a.last_candle_close : null, candles_processed: fin(a.candles_processed) ? a.candles_processed : null,
    risk_usd: fin(a.risk_usd) ? a.risk_usd : null, last_seq: Number.isInteger(a.last_seq) ? (a.last_seq as number) : null,
    open_position: op ? {
      trade_id: str(op.trade_id, 80), side: op.side === "LONG" || op.side === "SHORT" ? op.side : null, qty: fin(op.qty) ? op.qty : null,
      entry_time: isoOrNull(op.entry_time), entry_price: fin(op.entry_price) ? op.entry_price : null,
      initial_stop: fin(op.initial_stop) ? op.initial_stop : null, current_stop: fin(op.current_stop) ? op.current_stop : null,
      tp2: fin(op.tp2) ? op.tp2 : null, notional_usd: fin(op.notional_usd) ? op.notional_usd : null,
      unrealized_at_last_close: fin(op.unrealized_at_last_close) ? op.unrealized_at_last_close : null,
      classification: CATEGORIES.includes(op.classification as Category) ? op.classification : null,
    } : null,
    health,
  };
}

interface Candle { t: string; o: number; h: number; l: number; c: number }
function candle(v: unknown, tfMs: number): Candle | null {
  if (!isObj(v)) return null;
  const t = isoMs(v.t);
  const { o, h, l, c } = v;
  if (t === null || t % tfMs !== 0 || !pos(o) || !pos(h) || !pos(l) || !pos(c)) return null;
  if (!(l <= Math.min(o, c) && h >= Math.max(o, c))) return null;
  return { t: v.t as string, o, h, l, c };
}
const inRange = (p: number, k: Candle) => p >= k.l - 1e-9 && p <= k.h + 1e-9;

interface TradeRec {
  seq: number; trade_id: string; side: "LONG" | "SHORT"; qty: number; entry_time: string; entry_price: number;
  exit_time: string; exit_price: number; stop_price: number | null; tp2_price: number | null; exit_kind: string; result: string;
  exit_r: number | null; gross_pnl: number; risk_usd: number | null; notional_usd: number; entry_order_type: string | null;
  entry_liquidity: "maker" | "taker"; exit_liquidity: "maker" | "taker"; classification: Category;
  entry_candle: Candle | null; exit_candle: Candle; entry_processed_at: string | null; processed_at: string;
  exit_late: boolean; provenance_complete: boolean;
}

function validateTrade(it: Obj, acc: Account): TradeRec | string {
  const id = str(it.trade_id, 80);
  const m = id ? /^MIR-([A-Z0-9]+)-(\d{1,3})-(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)-(LONG|SHORT)$/.exec(id) : null;
  if (!m || m[1] !== acc.symbol || `${m[2]}m` !== acc.timeframe) return "trade_id must be MIR-<symbol>-<tf>-<entry time>-<side> for this account";
  const side = it.side;
  if (side !== "LONG" && side !== "SHORT") return "side must be LONG or SHORT";
  if (m[3] !== it.entry_time || m[4] !== side) return "trade_id does not match entry_time and side";
  const qty = it.qty, ep = it.entry_price, xp = it.exit_price;
  if (!pos(qty) || !pos(ep) || !pos(xp)) return "qty, entry_price and exit_price must be positive numbers";
  const et = isoMs(it.entry_time), xt = isoMs(it.exit_time);
  if (et === null || xt === null || et % acc.tfMs !== 0 || xt % acc.tfMs !== 0) return "entry_time and exit_time must be candle times on the timeframe grid";
  if (xt < et) return "exit_time is before entry_time";
  const stop = it.stop_price === null ? null : it.stop_price, tp2 = it.tp2_price === null ? null : it.tp2_price;
  if ((stop !== null && !pos(stop)) || (tp2 !== null && !pos(tp2))) return "stop_price and tp2_price must be positive or null";
  if (stop !== null && tp2 !== null && (side === "LONG" ? !(stop < tp2) : !(stop > tp2))) return "stop and TP2 are on the wrong sides for this direction";
  if (!EXIT_KINDS.includes(it.exit_kind as string)) return "exit_kind must be TP, SL or CLOSE_ALL";
  if (!RESULTS.includes(it.result as string)) return "result is not a known exit reason";
  if (it.exit_r !== null && it.exit_r !== undefined && !fin(it.exit_r)) return "exit_r must be a number or null";
  if (!fin(it.gross_pnl)) return "gross_pnl must be a number";
  const sign = side === "LONG" ? 1 : -1;
  const expect = (xp - ep) * qty * sign;
  if (Math.abs(expect - it.gross_pnl) > 1e-6 * Math.max(1, Math.abs(expect))) return `gross_pnl ${it.gross_pnl} does not equal (exit - entry) x qty (${expect})`;
  if (!pos(it.notional_usd) || Math.abs(it.notional_usd - qty * ep) > 1e-6 * qty * ep) return "notional_usd must equal qty x entry_price";
  if (it.risk_usd !== null && it.risk_usd !== undefined && !pos(it.risk_usd)) return "risk_usd must be positive or null";
  if (it.entry_liquidity !== "maker" && it.entry_liquidity !== "taker") return "entry_liquidity must be maker or taker";
  if (it.exit_liquidity !== "maker" && it.exit_liquidity !== "taker") return "exit_liquidity must be maker or taker";
  if (!CATEGORIES.includes(it.classification as Category)) return "classification must be historical, catch_up or live";
  const xk = candle(it.exit_candle, acc.tfMs);
  if (!xk || xk.t !== it.exit_time) return "exit_candle must be the valid candle at exit_time";
  if (!inRange(xp, xk)) return "exit_price lies outside its candle's range";
  const provenance = it.provenance_complete === true;
  const ek = it.entry_candle === null || it.entry_candle === undefined ? null : candle(it.entry_candle, acc.tfMs);
  if (it.entry_candle !== null && it.entry_candle !== undefined && (!ek || ek.t !== it.entry_time)) return "entry_candle must be the valid candle at entry_time";
  if (provenance && !ek) return "entry_candle is required when provenance_complete is true";
  if (ek && !inRange(ep, ek)) return "entry_price lies outside its candle's range";
  const processed = isoMs(it.processed_at);
  if (processed === null) return "processed_at must be an ISO time";
  if (processed < xt + acc.tfMs) return "processed_at is before the exit candle closed (lookahead)";
  return {
    seq: it.seq as number, trade_id: id as string, side, qty, entry_time: it.entry_time as string, entry_price: ep,
    exit_time: it.exit_time as string, exit_price: xp, stop_price: stop as number | null, tp2_price: tp2 as number | null,
    exit_kind: it.exit_kind as string, result: it.result as string, exit_r: fin(it.exit_r) ? it.exit_r : null, gross_pnl: it.gross_pnl,
    risk_usd: fin(it.risk_usd) ? it.risk_usd : null, notional_usd: it.notional_usd, entry_order_type: str(it.entry_order_type, 16),
    entry_liquidity: it.entry_liquidity, exit_liquidity: it.exit_liquidity, classification: it.classification as Category,
    entry_candle: ek, exit_candle: xk, entry_processed_at: isoOrNull(it.entry_processed_at), processed_at: it.processed_at as string,
    exit_late: it.exit_late === true, provenance_complete: provenance,
  };
}

/** Comparison costs of one hypothetical round trip under a profile (never charged anywhere). */
export function mirrorCosts(p: CostProfile, t: { side: "LONG" | "SHORT"; qty: number; entry_price: number; exit_price: number; entry_liquidity: string; exit_liquidity: string; gross_pnl: number }) {
  const inSide = t.side === "LONG" ? "buy" : "sell";
  const outSide = t.side === "LONG" ? "sell" : "buy";
  const e = execute(p, inSide, t.entry_liquidity === "maker" ? "MAKER" : "TAKER", t.entry_price, t.qty, 1);
  const x = execute(p, outSide, t.exit_liquidity === "maker" ? "MAKER" : "TAKER", t.exit_price, t.qty, 1);
  const fees = (e.feeMicro + x.feeMicro) / 1e6;
  const slippage = (e.slippageMicro + x.slippageMicro) / 1e6;
  return { fees, slippage, net: r6(t.gross_pnl - fees - slippage) };
}

// ------------------------------------------------------------------ ingestion

type ItemResult = { seq: number | null; id: string | null; status: "stored" | "duplicate" | "conflict" | "invalid"; code?: string; message?: string };

async function existingSeqOwner(db: D1Database, account: string, seq: number): Promise<string | null> {
  const t = await db.prepare(`SELECT trade_id FROM mirror_trades WHERE account_id = ? AND seq = ?`).bind(account, seq).first<{ trade_id: string }>();
  if (t) return t.trade_id;
  const e = await db.prepare(`SELECT entry_key FROM mirror_entries WHERE account_id = ? AND seq = ? AND kind = 'POSITION_INTERRUPTED'`).bind(account, seq).first<{ entry_key: string }>();
  return e ? e.entry_key : null;
}

async function conflict(db: D1Database, account: string, r: ItemResult, now: string): Promise<ItemResult> {
  await db.prepare(`UPDATE mirror_accounts SET conflicts = conflicts + 1, last_conflict_json = ?, updated_at = ? WHERE account_id = ?`)
    .bind(JSON.stringify({ ...r, at: now }), now, account).run();
  return r;
}

export async function handleEngineMirror(request: Request, env: MirrorEnv): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ ok: false, code: "TOO_LARGE" }, 413);
  let body: Obj;
  try {
    const b = JSON.parse(text);
    if (!isObj(b)) throw new Error("not an object");
    body = b;
  } catch {
    return json({ ok: false, code: "INVALID_JSON" }, 400);
  }
  if (typeof body.secret !== "string" || !(await secureEqual(body.secret, env.WEBHOOK_SECRET))) {
    return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  }
  const acc = validateAccount(body.account);
  if (typeof acc === "string") return json({ ok: false, code: "INVALID_ACCOUNT", message: acc }, 400);
  const items = body.items ?? [];
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return json({ ok: false, code: "INVALID_ITEMS", message: `items must be an array of at most ${MAX_ITEMS}` }, 400);

  const db = env.DB;
  const now = new Date().toISOString();
  const prior = await db.prepare(`SELECT inputs_hash, activated_at, cost_profile FROM mirror_accounts WHERE account_id = ?`).bind(acc.account_id).first<{ inputs_hash: string; activated_at: string | null; cost_profile: string }>();
  if (prior && prior.activated_at && acc.activated_at && prior.activated_at !== acc.activated_at) {
    // Activation is set once. A different one means a second mirror is reporting into this account: refuse it.
    return json({ ok: false, code: "ACTIVATION_CONFLICT", message: `account activated at ${prior.activated_at}, engine reports ${acc.activated_at}` }, 409);
  }
  await db.prepare(
    `INSERT INTO mirror_accounts (account_id, symbol, timeframe, profile, strategy, inputs_hash, engine_version, engine_release, engine_commit,
       created_at, engine_created_at, activated_at, updated_at, last_seen_at, last_candle_time, last_candle_close, candles_processed, risk_usd,
       engine_last_seq, open_position_json, engine_health_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET profile = excluded.profile, strategy = excluded.strategy, engine_version = excluded.engine_version,
       engine_release = excluded.engine_release, engine_commit = excluded.engine_commit,
       activated_at = COALESCE(mirror_accounts.activated_at, excluded.activated_at), updated_at = excluded.updated_at,
       last_seen_at = excluded.last_seen_at, last_candle_time = excluded.last_candle_time, last_candle_close = excluded.last_candle_close,
       candles_processed = excluded.candles_processed, risk_usd = excluded.risk_usd, engine_last_seq = excluded.engine_last_seq,
       open_position_json = excluded.open_position_json, engine_health_json = excluded.engine_health_json`
  ).bind(acc.account_id, acc.symbol, acc.timeframe, acc.profile, acc.strategy, acc.inputs_hash, acc.engine_version, acc.engine_release, acc.engine_commit,
    now, acc.created_at, acc.activated_at, now, now, acc.last_candle_time, acc.last_candle_close, acc.candles_processed, acc.risk_usd,
    acc.last_seq, acc.open_position ? JSON.stringify(acc.open_position) : null, JSON.stringify(acc.health)).run();
  const profile = COST_PROFILES[prior?.cost_profile ?? "ndax"] ?? COST_PROFILES.ndax;

  let refPrice: { price: number | null; at: string | null } | null = null;
  const reference = async () => {
    if (refPrice) return refPrice;
    const inst = getInstrument(acc.symbol);
    const r = inst ? await referencePrice(inst, env).catch(() => null) : null;
    refPrice = r && r.ok && typeof r.price === "number" ? { price: r.price, at: (r as { at: string }).at } : { price: null, at: null };
    return refPrice;
  };

  const results: ItemResult[] = [];
  const sorted = [...items].sort((a, b) => (isObj(a) && isObj(b) ? Number(a.seq) - Number(b.seq) : 0));
  for (const raw of sorted) {
    if (!isObj(raw) || !Number.isInteger(raw.seq) || (raw.seq as number) < 1) {
      results.push({ seq: null, id: null, status: "invalid", code: "INVALID_SEQ", message: "every item needs a positive integer seq" });
      continue;
    }
    const seq = raw.seq as number;
    const hash = await sha256(canonical(raw));
    try {
      if (raw.type === "TRADE") {
        const t = validateTrade(raw, acc);
        if (typeof t === "string") { results.push({ seq, id: str(raw.trade_id, 80), status: "invalid", code: "INVALID_TRADE", message: t }); continue; }
        const have = await db.prepare(`SELECT payload_hash, seq FROM mirror_trades WHERE account_id = ? AND trade_id = ?`).bind(acc.account_id, t.trade_id).first<{ payload_hash: string; seq: number }>();
        if (have) {
          results.push(have.payload_hash === hash && have.seq === seq ? { seq, id: t.trade_id, status: "duplicate" }
            : await conflict(db, acc.account_id, { seq, id: t.trade_id, status: "conflict", code: "TRADE_CONFLICT", message: `${t.trade_id} is already stored with different content (seq ${have.seq}); not overwritten` }, now));
          continue;
        }
        const owner = await existingSeqOwner(db, acc.account_id, seq);
        if (owner) { results.push(await conflict(db, acc.account_id, { seq, id: t.trade_id, status: "conflict", code: "SEQ_CONFLICT", message: `seq ${seq} already belongs to ${owner}` }, now)); continue; }
        const c = mirrorCosts(profile, t);
        const ref = t.classification === "live" ? await reference() : { price: null, at: null };
        await db.batch([
          db.prepare(
            `INSERT INTO mirror_trades (account_id, trade_id, seq, side, qty, entry_time, entry_price, exit_time, exit_price, stop_price, tp2_price,
               exit_kind, result, exit_r, gross_pnl, risk_usd, notional_usd, entry_order_type, entry_liquidity, exit_liquidity, cost_profile,
               est_fees, est_slippage, net_modelled_pnl, classification, entry_candle_json, exit_candle_json, entry_processed_at, processed_at,
               exit_late, provenance_complete, received_at, reference_price, reference_price_at, engine_release, inputs_hash, profile, payload_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(acc.account_id, t.trade_id, seq, t.side, t.qty, t.entry_time, t.entry_price, t.exit_time, t.exit_price, t.stop_price, t.tp2_price,
            t.exit_kind, t.result, t.exit_r, t.gross_pnl, t.risk_usd, t.notional_usd, t.entry_order_type, t.entry_liquidity, t.exit_liquidity, profile.id,
            c.fees, c.slippage, c.net, t.classification, t.entry_candle ? JSON.stringify(t.entry_candle) : null, JSON.stringify(t.exit_candle),
            t.entry_processed_at, t.processed_at, t.exit_late ? 1 : 0, t.provenance_complete ? 1 : 0, now, ref.price, ref.at, acc.engine_release,
            acc.inputs_hash, acc.profile, hash),
          db.prepare(`INSERT INTO mirror_entries (account_id, entry_key, seq, kind, amount_usd, trade_id, classification, created_at, payload_hash)
                      VALUES (?, ?, NULL, 'REALIZED_GROSS_PNL', ?, ?, ?, ?, ?)`).bind(acc.account_id, `PNL:${acc.account_id}:${t.trade_id}`, t.gross_pnl, t.trade_id, t.classification, now, hash),
        ]);
        results.push({ seq, id: t.trade_id, status: "stored" });
      } else if (raw.type === "POSITION_INTERRUPTED") {
        const eid = str(raw.event_id, 160);
        const cls = raw.classification;
        if (!eid || !eid.startsWith(`${acc.account_id}:INTERRUPTED:`) || !CATEGORIES.includes(cls as Category) || isoMs(raw.entry_time) === null
          || (raw.side !== "LONG" && raw.side !== "SHORT") || !pos(raw.qty) || !pos(raw.entry_price) || typeof raw.reason !== "string") {
          results.push({ seq, id: eid, status: "invalid", code: "INVALID_EVENT", message: "POSITION_INTERRUPTED needs event_id, side, qty, entry_time, entry_price, reason and classification" });
          continue;
        }
        const key = `EVENT:${eid}`;
        const have = await db.prepare(`SELECT payload_hash, seq FROM mirror_entries WHERE entry_key = ?`).bind(key).first<{ payload_hash: string; seq: number }>();
        if (have) {
          results.push(have.payload_hash === hash && have.seq === seq ? { seq, id: eid, status: "duplicate" }
            : await conflict(db, acc.account_id, { seq, id: eid, status: "conflict", code: "EVENT_CONFLICT", message: `${eid} is already stored with different content` }, now));
          continue;
        }
        const owner = await existingSeqOwner(db, acc.account_id, seq);
        if (owner) { results.push(await conflict(db, acc.account_id, { seq, id: eid, status: "conflict", code: "SEQ_CONFLICT", message: `seq ${seq} already belongs to ${owner}` }, now)); continue; }
        const detail = { trade_id: str(raw.trade_id, 80), side: raw.side, qty: raw.qty, entry_time: raw.entry_time, entry_price: raw.entry_price,
          stop_price: fin(raw.stop_price) ? raw.stop_price : null, tp2_price: fin(raw.tp2_price) ? raw.tp2_price : null,
          last_candle: isoOrNull(raw.last_candle), last_close: fin(raw.last_close) ? raw.last_close : null, reason: String(raw.reason).slice(0, 240), processed_at: isoOrNull(raw.processed_at) };
        await db.prepare(`INSERT INTO mirror_entries (account_id, entry_key, seq, kind, amount_usd, trade_id, classification, created_at, detail_json, payload_hash)
                          VALUES (?, ?, ?, 'POSITION_INTERRUPTED', 0, ?, ?, ?, ?, ?)`)
          .bind(acc.account_id, key, seq, detail.trade_id, cls, now, JSON.stringify(detail), hash).run();
        results.push({ seq, id: eid, status: "stored" });
      } else {
        results.push({ seq, id: null, status: "invalid", code: "UNKNOWN_TYPE", message: "type must be TRADE or POSITION_INTERRUPTED" });
      }
    } catch (e) {
      // A concurrent identical delivery can win the UNIQUE race: report what is stored now; anything else is
      // left unacknowledged (no result), so the engine retries it.
      const m = String((e as Error)?.message ?? e);
      if (!/UNIQUE/i.test(m)) break;
      const t = await db.prepare(`SELECT payload_hash FROM mirror_trades WHERE account_id = ? AND trade_id = ?`).bind(acc.account_id, str(raw.trade_id, 80)).first<{ payload_hash: string }>();
      results.push(t && t.payload_hash === hash ? { seq, id: str(raw.trade_id, 80), status: "duplicate" }
        : { seq, id: str(raw.trade_id, 80), status: "conflict", code: "UNIQUE_CONFLICT", message: m.slice(0, 200) });
    }
  }

  const seqs = await advanceSequence(db, acc.account_id, now);
  return json({ ok: true, mode: "PAPER", hypothetical: true, broker_request_sent: false, results, account: seqs });
}

/** Moves the contiguous-sequence mark forward and reports gaps (numbered by the engine, never stored). */
async function advanceSequence(db: D1Database, account: string, now: string) {
  const a = await db.prepare(`SELECT last_contiguous_seq, engine_last_seq, conflicts FROM mirror_accounts WHERE account_id = ?`).bind(account).first<{ last_contiguous_seq: number; engine_last_seq: number | null; conflicts: number }>();
  let last = a?.last_contiguous_seq ?? 0;
  const rows = await db.prepare(
    `SELECT seq FROM mirror_trades WHERE account_id = ?1 AND seq > ?2
     UNION SELECT seq FROM mirror_entries WHERE account_id = ?1 AND seq IS NOT NULL AND seq > ?2 ORDER BY seq`
  ).bind(account, last).all<{ seq: number }>();
  const above = rows.results.map((r) => r.seq);
  for (const s of above) { if (s === last + 1) last = s; else break; }
  const maxSeen = Math.max(last, ...above);
  await db.prepare(`UPDATE mirror_accounts SET last_contiguous_seq = ?, max_seq_seen = ?, updated_at = ? WHERE account_id = ?`).bind(last, maxSeen, now, account).run();
  const storedAbove = above.filter((s) => s > last).length;
  return { last_contiguous_seq: last, max_seq_seen: maxSeen, missing: maxSeen - last - storedAbove, engine_last_seq: a?.engine_last_seq ?? null, conflicts: a?.conflicts ?? 0 };
}

// ------------------------------------------------------------------ dashboard (read-only)

interface TradeRow {
  trade_id: string; seq: number; side: "LONG" | "SHORT"; qty: number; entry_time: string; entry_price: number; exit_time: string; exit_price: number;
  stop_price: number | null; tp2_price: number | null; exit_kind: string; result: string; exit_r: number | null; gross_pnl: number; risk_usd: number | null;
  notional_usd: number; est_fees: number; est_slippage: number; net_modelled_pnl: number; classification: Category; exit_late: number;
  provenance_complete: number; reference_price: number | null; processed_at: string;
}

const LEVERAGES = [1, 5, 10];

function metricsFor(rows: TradeRow[], baseline: number) {
  const sum = (f: (t: TradeRow) => number, list = rows) => r6(list.reduce((s, t) => s + f(t), 0));
  const part = (list: TradeRow[]) => ({
    trades: list.length, wins: list.filter((t) => t.gross_pnl > 0).length, gross: sum((t) => t.gross_pnl, list),
    est_costs: sum((t) => t.est_fees + t.est_slippage, list), net_modelled: sum((t) => t.net_modelled_pnl, list),
  });
  const wins = rows.filter((t) => t.gross_pnl > 0), losses = rows.filter((t) => t.gross_pnl < 0);
  const gp = sum((t) => t.gross_pnl, wins), gl = -sum((t) => t.gross_pnl, losses);
  // Equity path on the reporting baseline, gross (TradingView-style), one point per close, in exit order.
  const byExit = [...rows].sort((a, b) => (a.exit_time === b.exit_time ? a.seq - b.seq : a.exit_time < b.exit_time ? -1 : 1));
  let eq = baseline, peak = baseline, maxDd = 0, minEq = baseline, firstNegative: string | null = null, maxLev = 0;
  const curve: { t: string; equity: number; net_equity: number }[] = [];
  let netEq = baseline;
  const liq: Record<string, number> = Object.fromEntries(LEVERAGES.filter((l) => l > 1).map((l) => [`${l}x`, 0]));
  for (const t of byExit) {
    // Implied leverage = position notional / hypothetical equity when the position was open (before its own P&L).
    if (eq > 0) maxLev = Math.max(maxLev, t.notional_usd / eq);
    for (const l of LEVERAGES.filter((x) => x > 1)) if (-Math.min(t.gross_pnl, 0) >= t.notional_usd / l) liq[`${l}x`] += 1;
    eq += t.gross_pnl;
    netEq += t.net_modelled_pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
    if (eq < minEq) minEq = eq;
    if (eq < 0 && firstNegative === null) firstNegative = t.exit_time;
    curve.push({ t: t.exit_time, equity: r2(eq), net_equity: r2(netEq) });
  }
  // At most 400 points for the chart; the first, last and every extreme point are kept.
  const step = Math.ceil(curve.length / 400);
  const thin = step <= 1 ? curve : curve.filter((p, i) => i % step === 0 || i === curve.length - 1 || p.equity === r2(minEq));
  const notionals = rows.map((t) => t.notional_usd).sort((a, b) => a - b);
  const maxNotional = notionals.length ? notionals[notionals.length - 1] : 0;
  const by = (r: string) => rows.filter((t) => t.result === r).length;
  return {
    trades: rows.length, longs: rows.filter((t) => t.side === "LONG").length, shorts: rows.filter((t) => t.side === "SHORT").length,
    wins: wins.length, losses: losses.length, flat: rows.length - wins.length - losses.length,
    win_rate_pct: rows.length ? r2((wins.length / rows.length) * 100) : null,
    gross_pnl: sum((t) => t.gross_pnl), gross_profit: r6(gp), gross_loss: r6(gl),
    profit_factor: gl > 0 ? Math.round((gp / gl) * 1000) / 1000 : null,
    max_drawdown: r2(maxDd), est_fees: sum((t) => t.est_fees), est_slippage: sum((t) => t.est_slippage), net_modelled_pnl: sum((t) => t.net_modelled_pnl),
    long: part(rows.filter((t) => t.side === "LONG")), short: part(rows.filter((t) => t.side === "SHORT")),
    exits: { tp2: by("TP2"), stop_loss: by("SL"), trailing: by("TRAILING_SL"), break_even: by("BREAK_EVEN"), time_exit: by("TIME_EXIT"), same_bar: by("SAME_BAR"), unlabelled: by("UNLABELLED") },
    first_trade_at: rows.length ? byExit[0].entry_time : null, last_exit_at: rows.length ? byExit[byExit.length - 1].exit_time : null,
    risk: {
      reporting_equity_usd: baseline, end_equity: r2(eq), min_equity: r2(minEq), negative_equity: minEq < 0, first_negative_at: firstNegative,
      max_notional_usd: r2(maxNotional), median_notional_usd: notionals.length ? r2(notionals[Math.floor(notionals.length / 2)]) : null,
      fixed_risk_usd: rows.length ? rows[rows.length - 1].risk_usd : null,
      max_implied_leverage: rows.length ? Math.round(maxLev * 100) / 100 : null,
      margin_required_usd: Object.fromEntries(LEVERAGES.map((l) => [`${l}x`, r2(maxNotional / l)])),
      liquidation_risk_trades: liq,
      liquidation_model: "Isolated margin, no maintenance buffer: a trade is flagged at a leverage when its realized loss is at least its initial margin (notional ÷ leverage). Intrabar adverse excursion is not modelled. Nothing is liquidated in the mirror (margin 0, as on TradingView).",
    },
    curve: thin,
  };
}

function health(acc: Obj | null, recon: { ok: boolean; issues: string[] }, interruptions: number, now: number) {
  if (!acc) return { state: "NOT_ACTIVE", issues: ["no mirror account has reported yet"] };
  const issues = [...recon.issues];
  const last = Number(acc.last_contiguous_seq), max = Number(acc.max_seq_seen), engine = acc.engine_last_seq === null ? null : Number(acc.engine_last_seq);
  if (max > last) issues.push(`sequence gap: records ${last + 1}..${max} are not all stored`);
  const eh = acc.engine_health_json ? JSON.parse(String(acc.engine_health_json)) : {};
  if (engine !== null && engine > max && !(eh.pending > 0)) issues.push(`the engine numbered ${engine} records, ${max} reached the Worker and none is pending`);
  if (Number(acc.conflicts) > 0) issues.push(`${acc.conflicts} conflicting record(s) refused`);
  if (eh.refused > 0) issues.push(`${eh.refused} record(s) refused and kept by the engine`);
  if (interruptions > 0) issues.push(`${interruptions} hypothetical position(s) interrupted by a data gap (no exit, no P&L)`);
  if (eh.last_error?.message) issues.push(`engine: ${eh.last_error.message}`);
  const age = acc.last_seen_at ? Math.round((now - Date.parse(String(acc.last_seen_at))) / 1000) : null;
  const stale = age === null || age > 30 * 60;
  const diverged = !recon.ok || Number(acc.conflicts) > 0 || max > last || eh.refused > 0;
  return {
    state: diverged ? "DIVERGED" : stale ? "STALE" : issues.length ? "DEGRADED" : "OK", issues, last_seen_age_seconds: age,
    pending: eh.pending ?? null, resets: eh.resets ?? 0, interruptions, last_contiguous_seq: last, max_seq_seen: max, engine_last_seq: engine,
  };
}

const TRADE_COLS = `trade_id, seq, side, qty, entry_time, entry_price, exit_time, exit_price, stop_price, tp2_price, exit_kind, result, exit_r, gross_pnl,
  risk_usd, notional_usd, est_fees, est_slippage, net_modelled_pnl, classification, exit_late, provenance_complete, reference_price, processed_at`;

async function pickAccount(db: D1Database, requested: string | null) {
  return requested
    ? db.prepare(`SELECT * FROM mirror_accounts WHERE account_id = ?`).bind(requested).first<Obj>()
    : db.prepare(`SELECT * FROM mirror_accounts ORDER BY last_seen_at DESC LIMIT 1`).first<Obj>();
}

export async function mirrorDashboard(db: D1Database, params: URLSearchParams) {
  const accounts = (await db.prepare(`SELECT account_id, symbol, timeframe, activated_at, last_seen_at FROM mirror_accounts ORDER BY last_seen_at DESC`).all<Obj>()).results;
  const acc = await pickAccount(db, params.get("account"));
  const base = { label: MIRROR_LABEL, disclosure: MIRROR_DISCLOSURE, accounts };
  if (!acc) return { ...base, account: null, health: health(null, { ok: true, issues: [] }, 0, Date.now()), categories: null, open_position: null, activity: [], interruptions: [] };
  const id = String(acc.account_id);
  const rows = (await db.prepare(`SELECT ${TRADE_COLS} FROM mirror_trades WHERE account_id = ? ORDER BY seq`).bind(id).all<TradeRow>()).results;
  const ints = (await db.prepare(`SELECT seq, classification, created_at, detail_json FROM mirror_entries WHERE account_id = ? AND kind = 'POSITION_INTERRUPTED' ORDER BY seq`).bind(id).all<Obj>()).results
    .map((r) => ({ seq: r.seq, classification: r.classification, recorded_at: r.created_at, ...JSON.parse(String(r.detail_json ?? "{}")) }));
  // Reconciliation: one journal entry per trade, equal to its gross P&L; the equity journal equals the trade list.
  const j = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(e.amount_usd), 0) AS total,
       SUM(CASE WHEN t.trade_id IS NULL OR ABS(t.gross_pnl - e.amount_usd) > 1e-9 OR t.classification <> e.classification THEN 1 ELSE 0 END) AS bad
     FROM mirror_entries e LEFT JOIN mirror_trades t ON t.account_id = e.account_id AND t.trade_id = e.trade_id
     WHERE e.account_id = ? AND e.kind = 'REALIZED_GROSS_PNL'`
  ).bind(id).first<{ n: number; total: number; bad: number }>();
  const tradeTotal = rows.reduce((s, t) => s + t.gross_pnl, 0);
  const recon = { ok: true, issues: [] as string[] };
  if (!j || j.n !== rows.length) { recon.ok = false; recon.issues.push(`${j?.n ?? 0} journal entries for ${rows.length} trades`); }
  if (j && Math.abs(j.total - tradeTotal) > 1e-6) { recon.ok = false; recon.issues.push(`journal total ${r6(j.total)} differs from the trades' gross ${r6(tradeTotal)}`); }
  if (j && j.bad > 0) { recon.ok = false; recon.issues.push(`${j.bad} journal entries do not match their trade`); }
  const baseline = Number(acc.reporting_equity_usd);
  const profile = COST_PROFILES[String(acc.cost_profile)] ?? null;
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, metricsFor(rows.filter((t) => t.classification === c), baseline)]));
  const latest = [...rows].sort((a, b) => b.seq - a.seq).slice(0, 10);
  return {
    ...base,
    account: {
      account_id: id, symbol: acc.symbol, timeframe: acc.timeframe, profile: acc.profile, strategy: acc.strategy, inputs_hash: acc.inputs_hash,
      engine_version: acc.engine_version, engine_release: acc.engine_release, engine_commit: acc.engine_commit,
      activated_at: acc.activated_at, first_seen_at: acc.created_at, last_seen_at: acc.last_seen_at, last_candle_time: acc.last_candle_time,
      last_candle_close: acc.last_candle_close, candles_processed: acc.candles_processed, risk_usd: acc.risk_usd, reporting_equity_usd: baseline,
      margin: "0 (TradingView property): unlimited buying power, no margin call, no liquidation",
    },
    cost_model: profile ? { id: profile.id, name: profile.name, maker_pct: profile.makerPct, taker_pct: profile.takerPct, taker_slippage_pct: profile.takerSlipPct,
      fee_source: profile.feeSource, slippage_source: profile.slippageSource, caveat: profile.caveat,
      note: "Comparison only: the TradingView baseline is gross (0% commission). Maker/taker is inferred from order types (limit entry and TP2 = maker; stops and time exits = taker). Never charged to any balance." } : null,
    health: health(acc, recon, ints.length, Date.now()),
    reconciliation: { ok: recon.ok, journal_entries: j?.n ?? 0, journal_total: r6(j?.total ?? 0), trades: rows.length, trades_gross: r6(tradeTotal), issues: recon.issues },
    categories,
    open_position: acc.open_position_json ? JSON.parse(String(acc.open_position_json)) : null,
    activity: latest.map((t) => ({ trade_id: t.trade_id, seq: t.seq, side: t.side, classification: t.classification, result: t.result, exit_time: t.exit_time, gross_pnl: t.gross_pnl })),
    interruptions: ints,
  };
}

export async function mirrorTrades(db: D1Database, params: URLSearchParams) {
  const acc = await pickAccount(db, params.get("account"));
  if (!acc) return { trades: [], total: 0 };
  const cat = params.get("category");
  if (cat !== null && !CATEGORIES.includes(cat as Category)) throw Object.assign(new Error("category must be historical, catch_up or live"), { code: "INVALID_CATEGORY" });
  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 500);
  const offset = Math.max(Number(params.get("offset")) || 0, 0);
  const where = `account_id = ?${cat ? " AND classification = ?" : ""}`;
  const args: unknown[] = cat ? [acc.account_id, cat] : [acc.account_id];
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM mirror_trades WHERE ${where}`).bind(...args).first<{ n: number }>())?.n ?? 0;
  const trades = (await db.prepare(`SELECT ${TRADE_COLS} FROM mirror_trades WHERE ${where} ORDER BY exit_time DESC, seq DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset).all<TradeRow>()).results;
  return { trades, total, limit, offset, label: MIRROR_LABEL };
}

export async function mirrorTradeProof(db: D1Database, tradeId: string, account: string | null = null) {
  // Trade ids are unique per account; without an account, the most recently stored one is shown.
  const t = account
    ? await db.prepare(`SELECT * FROM mirror_trades WHERE account_id = ? AND trade_id = ?`).bind(account, tradeId).first<Obj>()
    : await db.prepare(`SELECT * FROM mirror_trades WHERE trade_id = ? ORDER BY id DESC LIMIT 1`).bind(tradeId).first<Obj>();
  if (!t) return null;
  const acc = await db.prepare(`SELECT account_id, symbol, timeframe, profile, strategy, inputs_hash, activated_at, reporting_equity_usd FROM mirror_accounts WHERE account_id = ?`).bind(t.account_id).first<Obj>();
  const entry = await db.prepare(`SELECT entry_key, amount_usd, classification, created_at FROM mirror_entries WHERE entry_key = ?`).bind(`PNL:${t.account_id}:${tradeId}`).first<Obj>();
  const { entry_candle_json, exit_candle_json, ...rest } = t;
  return {
    label: MIRROR_LABEL, disclosure: MIRROR_DISCLOSURE, trade: rest,
    candles: { entry: entry_candle_json ? JSON.parse(String(entry_candle_json)) : null, exit: JSON.parse(String(exit_candle_json)) },
    journal_entry: entry, account: acc,
    checks: {
      gross_equals_price_move: Math.abs(((Number(t.exit_price) - Number(t.entry_price)) * Number(t.qty) * (t.side === "LONG" ? 1 : -1)) - Number(t.gross_pnl)) < 1e-6,
      journal_matches: !!entry && Math.abs(Number(entry.amount_usd) - Number(t.gross_pnl)) < 1e-9,
      net_equals_gross_minus_costs: Math.abs(Number(t.gross_pnl) - Number(t.est_fees) - Number(t.est_slippage) - Number(t.net_modelled_pnl)) < 1e-5,
    },
  };
}

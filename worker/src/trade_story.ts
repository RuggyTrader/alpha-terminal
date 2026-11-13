// A trade's recorded story: the strategy plan the engine sent WITH its entry signal and the exit reason it sent WITH its
// close (engine/src/tradeplan.mjs), read back from the stored payloads (alerts.payload_json on the legacy path,
// bot_orders.payload_json on the bot path). Only whitelisted, typed fields are returned; anything absent stays null and
// is listed in `missing`, so no page can show an explanation that was never recorded. Works on schema 6 (no new table).

type Obj = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, n = 40) => (typeof v === "string" && v.length <= n ? v : null);
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const TAGS = new Set(["FVG", "OB", "RB"]);

export interface TradePlan {
  side: "LONG" | "SHORT" | null; setup_at: string | null; swing_origin: number | null; swing_end: number | null; ote_705: number | null;
  order_type: string | null; order_placed_at: string | null; planned_entry: number | null; strategy_entry: number | null; filled_at: string | null;
  initial_stop: number | null; tp2: number | null; score: number | null; confluence: string[]; profile: string | null; inputs_hash: string | null;
  rules: { entry_mode: string | null; sl_mode: string | null; sl_buf_atr: number | null; tp2_ext: number | null; min_score: number | null } | null;
}
export interface TradeExit { kind: string | null; result: string | null; exit_r: number | null; strategy_exit: number | null; initial_stop: number | null;
  stop_at_exit: number | null; tp2: number | null; stop_history: { at: string | null; stop: number | null; reason: string | null }[] }
export interface TradeStory { plan: TradePlan | null; exit: TradeExit | null; missing: string[] }

function parsePayload(text: unknown): Obj | null {
  if (typeof text !== "string" || !text) return null;
  try { return obj(JSON.parse(text)); } catch { return null; }
}

export function planFrom(payload: Obj | null): TradePlan | null {
  const p = obj(payload?.plan);
  if (!p) return null;
  const swing = obj(p.swing), order = obj(p.order), rules = obj(p.rules);
  return {
    side: p.side === "LONG" || p.side === "SHORT" ? p.side : null, setup_at: str(p.setup_at), swing_origin: num(swing?.origin), swing_end: num(swing?.end), ote_705: num(p.ote_705),
    order_type: str(order?.type), order_placed_at: str(order?.placed_at), planned_entry: num(order?.limit), strategy_entry: num(p.strategy_entry), filled_at: str(p.filled_at),
    initial_stop: num(p.initial_stop), tp2: num(p.tp2), score: num(p.score), confluence: Array.isArray(p.confluence) ? p.confluence.filter((t): t is string => typeof t === "string" && TAGS.has(t)) : [],
    profile: str(p.profile), inputs_hash: str(p.inputs_hash, 64),
    rules: rules ? { entry_mode: str(rules.entry_mode), sl_mode: str(rules.sl_mode), sl_buf_atr: num(rules.sl_buf_atr), tp2_ext: num(rules.tp2_ext), min_score: num(rules.min_score) } : null,
  };
}

export function exitFrom(payload: Obj | null): TradeExit | null {
  const e = obj(payload?.exit);
  if (!e) return null;
  return { kind: str(e.kind), result: str(e.result), exit_r: num(e.exit_r), strategy_exit: num(e.strategy_exit), initial_stop: num(e.initial_stop), stop_at_exit: num(e.stop_at_exit), tp2: num(e.tp2),
    stop_history: Array.isArray(e.stop_history) ? e.stop_history.slice(0, 200).map((h) => { const x = obj(h); return { at: str(x?.at), stop: num(x?.stop), reason: str(x?.reason) }; }) : [] };
}

export function storyOf(openPayloadJson: unknown, closePayloadJson: unknown, closed: boolean): TradeStory {
  const plan = planFrom(parsePayload(openPayloadJson));
  const exit = closed ? exitFrom(parsePayload(closePayloadJson)) : null;
  const missing: string[] = [];
  if (!plan) missing.push("entry plan (swing leg, OTE level, stop, target, confluence) was not sent by the engine for this trade (engine releases before 2026-11-13 did not record it)");
  if (closed && !exit) missing.push("exit reason was not sent by the engine for this trade");
  return { plan, exit, missing };
}

/** One query: payloads for many legacy alert ids. */
export async function alertPayloads(db: D1Database, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((v): v is string => typeof v === "string" && v !== ""))].slice(0, 200);
  if (!list.length) return new Map();
  const rows = (await db.prepare(`SELECT alert_id, payload_json FROM alerts WHERE alert_id IN (${list.map(() => "?").join(",")})`).bind(...list).all<{ alert_id: string; payload_json: string | null }>()).results;
  return new Map(rows.map((r) => [r.alert_id, r.payload_json ?? ""]));
}

/** One query: payloads for many bot order ids. */
export async function botOrderPayloads(db: D1Database, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((v): v is string => typeof v === "string" && v !== ""))].slice(0, 200);
  if (!list.length) return new Map();
  const rows = (await db.prepare(`SELECT order_id, payload_json FROM bot_orders WHERE order_id IN (${list.map(() => "?").join(",")})`).bind(...list).all<{ order_id: string; payload_json: string | null }>()).results;
  return new Map(rows.map((r) => [r.order_id, r.payload_json ?? ""]));
}

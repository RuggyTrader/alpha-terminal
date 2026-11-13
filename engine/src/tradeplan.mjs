// The trade's recorded reasoning, built ONLY from the strategy's own events (src/ote.mjs): the setup (swing leg), the
// order it placed (OTE limit, stop, TP2, confluence score), the confirmed entry (with the PD-array tags that qualified),
// every stop change, and how the trade ended. It travels with the order to the ledger (alerts.payload_json on the
// legacy path, bot_orders.payload_json on the bot path), so the dashboard and the assistant can explain a trade without
// reading engine files. Nothing here is inferred: a field the strategy did not emit stays null.

export const PLAN_VERSION = 1;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r = (v, d = 8) => (num(v) === null ? null : Number(v.toFixed(d)));

export function newPlanState() { return { pending: null, active: null, finished: null }; }

/** Folds one candle's strategy events into the plan state. ctx: { at (candle close ISO), profile, inputsHash, inputs }. */
export function updatePlan(P, events, ctx) {
  P.finished = null;
  for (const e of events) {
    if (e.type === "SETUP") {
      const legStart = num(e.legStart), legEnd = num(e.legEnd);
      P.pending = {
        v: PLAN_VERSION, side: e.side === 1 ? "LONG" : "SHORT", setup_at: ctx.at,
        swing: { origin: legStart, end: legEnd },
        // The OTE level the Pine script uses for its limit: 70.5% retracement of the leg (lvl(0.705)).
        ote_705: legStart !== null && legEnd !== null ? r(legEnd + (legStart - legEnd) * 0.705) : null,
        profile: ctx.profile ?? null, inputs_hash: ctx.inputsHash ?? null,
        rules: ctx.inputs ? { entry_mode: ctx.inputs.entryMode, sl_mode: ctx.inputs.slMode, sl_buf_atr: ctx.inputs.slBuf, tp2_ext: ctx.inputs.tp2Ext, min_score: ctx.inputs.minScore } : null,
        order: null,
      };
    } else if (e.type === "ORDER_PLACED" && P.pending) {
      P.pending.order = { placed_at: ctx.at, type: e.limit !== null && e.limit !== undefined ? "LIMIT" : "MARKET_NEXT_BAR", limit: num(e.limit),
        stop: num(e.stop), tp2: num(e.tp2), qty: num(e.qty), score: num(e.score) };
    } else if (e.type === "SETUP_CANCELLED") {
      if (P.pending) P.pending = { ...P.pending, cancelled_at: ctx.at, cancel_reason: e.reason === "broken" ? "SETUP_BROKEN" : "SETUP_EXPIRED" };
      P.pending = null;
    } else if (e.type === "IN_TRADE") {
      P.active = { ...(P.pending ?? { v: PLAN_VERSION, side: e.side === 1 ? "LONG" : "SHORT", swing: null, ote_705: null, order: null, profile: ctx.profile ?? null, inputs_hash: ctx.inputsHash ?? null }),
        filled_at: ctx.at, strategy_entry: num(e.entry), initial_stop: r(e.stop), tp2: r(e.tp2), score: num(e.score),
        confluence: typeof e.tags === "string" && e.tags.trim() ? e.tags.trim().split(/\s+/) : [], stop_history: [] };
      P.pending = null;
    } else if ((e.type === "STOP_TO_BREAK_EVEN" || e.type === "TRAILING_STOP_MOVED") && P.active) {
      P.active.stop_history.push({ at: ctx.at, stop: num(e.stop), reason: e.type === "STOP_TO_BREAK_EVEN" ? "BREAK_EVEN" : "TRAILING" });
    } else if (e.type === "TRADE_FINISHED") {
      P.finished = { result: e.result ?? null, exit_r: r(e.exitR, 4), reference_pnl: r(e.pnl, 6) };
    }
  }
  return P;
}

/** What an EXIT carries: why the strategy closed (from its own exit kind and result), with the stop path. */
export function exitRecord(P, fill) {
  const a = P.active;
  const hist = a?.stop_history ?? [];
  return { v: PLAN_VERSION, kind: fill.kind ?? null, result: P.finished?.result ?? null, exit_r: P.finished?.exit_r ?? null, strategy_exit: num(fill.price),
    initial_stop: a?.initial_stop ?? null, stop_at_exit: hist.length ? hist[hist.length - 1].stop : a?.initial_stop ?? null, tp2: a?.tp2 ?? null, stop_history: hist };
}

// Strategy Mirror (Track B): the ORIGINAL strategy's hypothetical TradingView-style executions, measured on their own.
//
// * A second, independent copy of the unchanged strategy (ote.mjs `createState`/`onBar`, the same inputs, fixed $10
//   risk sizing, TradingView's documented broker emulator, pivot ties as on TradingView). It is fed the same real,
//   completed Kraken candles as the funded track (Track A), one candle at a time, so it can never see the future.
// * It is NEVER dropped, closed or reset because the funded ALPHA PAPER ledger refused an entry. Track A and Track B
//   share no state: separate objects, separate files, separate ids (MIR-… vs ENG-…), separate accounting.
// * Margin 0 as in the TradingView properties: no buying-power check, no capital limit, no liquidation. Results are
//   HYPOTHETICAL (unlimited buying power), not executable performance. Nothing here sends an order anywhere.
// * Every completed trade becomes one record with a deterministic id and a sequence number, the strategy's own fill
//   prices (limit at limit, stop at stop, same-candle path rules), its initial stop and TP2, the exit reason, the
//   candles it filled on, and a classification:
//     historical  the entry candle closed before the mirror's activation (warm-up replay of Kraken history)
//     catch_up    after activation, but the entry candle was processed late (after an outage or a data-gap re-warm)
//     live        after activation, processed within `lateBars` candles of its close
// * A data gap that forces a fresh warm-up never silently loses an open position: it is recorded as a
//   POSITION_INTERRUPTED event (no exit, no P&L, reported on the dashboard).
// Pure state transitions; the runner (runner.mjs) owns files, the clock and delivery.

import { createState, onBar } from "./ote.mjs";

export const MIRROR_STATE_VERSION = 1;
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const sideName = (s) => (s === 1 ? "LONG" : "SHORT");
const KEEP_CLOSED = 5; // broker.closed entries kept after they were journaled (the strategy reads only the count)

/** The mirror account this engine reports into: one per symbol, timeframe and strategy-input set. */
export function mirrorAccountId(symbol, intervalMin, inputsHash) {
  return `MIRROR-${symbol}-${intervalMin}m-${inputsHash}`;
}

export function mirrorTradeId(symbol, intervalMin, entryTimeMs, side) {
  return `MIR-${symbol}-${intervalMin}-${iso(entryTimeMs)}-${sideName(side)}`;
}

function newStrategy(ctx) {
  // Fixed-risk sizing and the default emulator rule, whatever the funded track is configured with.
  return createState({ symbol: ctx.symbol, timeframeMin: ctx.intervalMin, inputs: ctx.inputs, pivotTies: ctx.pivotTies });
}

/** A fresh mirror. `activatedAt` stays null until the first (warm-up) batch has been processed. */
export function createMirror(ctx) {
  return {
    version: MIRROR_STATE_VERSION, accountId: mirrorAccountId(ctx.symbol, ctx.intervalMin, ctx.inputsHash),
    symbol: ctx.symbol, intervalMin: ctx.intervalMin, inputsHash: ctx.inputsHash,
    createdAt: iso(ctx.nowMs), activatedAt: null, warmedUpAt: null,
    strategy: newStrategy(ctx), closedSeen: 0, openTrade: null,
    seq: 0, outbox: [], delivered: 0, lastDeliveredSeq: 0,
    candlesProcessed: 0, lastCandle: null, skippedCandles: 0,
    resets: [], interruptions: 0, recordedTrades: 0, lastError: null, health: null,
    // Spans of candles after activation that were processed late (engine down, catch-up): disclosed on the dashboard
    // even when no trade happened in them. noTradeIntervals: intervals Kraken served without trades (no bar).
    observationGaps: [], noTradeIntervals: 0, lastSent: null,
  };
}

const candleOf = (k) => ({ t: iso(k.t), o: k.o, h: k.h, l: k.l, c: k.c, ...(k.n !== undefined ? { n: k.n } : {}) });

/**
 * Classifies by the ENTRY candle: before activation = historical replay; after it, live unless it was processed late.
 */
function classify(M, entryCloseMs, processedLate) {
  const act = M.activatedAt === null ? null : Date.parse(M.activatedAt);
  if (act === null || entryCloseMs <= act) return "historical";
  return processedLate ? "catch_up" : "live";
}

function push(M, item) {
  M.seq += 1;
  M.outbox.push({ ...item, seq: M.seq, status: "pending", attempts: 0 });
}

/**
 * Feeds one completed candle. Repeated or out-of-order candles (t <= last processed) are ignored and counted,
 * never re-run. Returns the strategy events of this candle.
 * ctx: { nowMs, lateMs, intervalMin, symbol, riskUSD?, release, profile }
 */
export function mirrorStep(M, k, ctx) {
  const S = M.strategy;
  if (S.lastTime !== null && k.t <= S.lastTime) {
    M.skippedCandles += 1;
    return [];
  }
  const step = M.intervalMin * 60_000;
  const closeMs = k.t + step;
  const late = ctx.nowMs - closeMs > ctx.lateMs;
  const br = S.broker;
  // The bracket attached to the pending entry before this candle: it is what the entry fills with (stop, TP2).
  const pre = { entry: br.entry ? { ...br.entry } : null, exit: br.exit ? { ...br.exit } : null };
  const events = onBar(S, k);
  M.candlesProcessed += 1;
  M.lastCandle = { t: iso(k.t), close: k.c, processedAt: iso(ctx.nowMs), late };
  if (late && M.activatedAt !== null) {
    // One outage is caught up in one poll: candles processed late in the same poll form one observation gap.
    M.observationGaps ??= [];
    const g = M.observationGaps[M.observationGaps.length - 1];
    if (g && g.processed_at === iso(ctx.nowMs)) { g.to = iso(k.t); g.candles += 1; }
    else M.observationGaps.push({ from: iso(k.t), to: iso(k.t), candles: 1, processed_at: iso(ctx.nowMs) });
    M.observationGaps = M.observationGaps.slice(-20);
  }

  for (const e of events) {
    if (e.type === "ENTRY_FILL") {
      M.openTrade = {
        entryTimeMs: k.t, side: e.side, qty: e.qty, entryPrice: e.price,
        stop: pre.exit && pre.exit.from === pre.entry?.id ? pre.exit.stop : null,
        tp2: pre.exit && pre.exit.from === pre.entry?.id ? pre.exit.limit : null,
        orderType: pre.entry && pre.entry.limit !== null ? "limit" : "market",
        limit: pre.entry?.limit ?? null,
        riskUSD: S.inputs.riskUSD, entryCandle: candleOf(k), entryLate: late, entryProcessedAt: iso(ctx.nowMs),
        classification: classify(M, closeMs, late),
      };
    }
  }

  // Journal every trade the emulator closed on this candle, in order, with the strategy's own label.
  while (M.closedSeen < br.closed.length) {
    const t = br.closed[M.closedSeen++];
    const o = M.openTrade && M.openTrade.entryTimeMs === t.entryTime ? M.openTrade : null;
    const result = t.result ?? (t.exitKind === "CLOSE_ALL" ? "TIME_EXIT" : null);
    const rec = {
      type: "TRADE",
      trade_id: mirrorTradeId(M.symbol, M.intervalMin, t.entryTime, t.side),
      side: sideName(t.side), qty: t.qty,
      entry_time: iso(t.entryTime), entry_price: t.entryPrice,
      exit_time: iso(t.exitTime), exit_price: t.exitPrice,
      stop_price: o?.stop ?? null, tp2_price: o?.tp2 ?? null,
      exit_kind: t.exitKind, result: result ?? "UNLABELLED", exit_r: Number.isFinite(t.exitR) ? t.exitR : null,
      gross_pnl: t.pnl, risk_usd: o?.riskUSD ?? S.inputs.riskUSD, notional_usd: t.qty * t.entryPrice,
      // Inferred from the strategy's order types, not from an order book.
      entry_order_type: o?.orderType ?? null, entry_liquidity: (o?.orderType ?? "limit") === "limit" ? "maker" : "taker",
      exit_liquidity: t.exitKind === "TP" ? "maker" : "taker",
      classification: o ? o.classification : classify(M, t.entryTime + step, late),
      entry_candle: o?.entryCandle ?? null, exit_candle: candleOf(k),
      entry_processed_at: o?.entryProcessedAt ?? null, processed_at: iso(ctx.nowMs), exit_late: late,
      provenance_complete: !!o,
    };
    push(M, rec);
    M.recordedTrades += 1;
    if (o) M.openTrade = null;
  }
  // The strategy only compares the length of `closed` with `lastClosed`; shorten both together.
  if (br.closed.length > KEEP_CLOSED * 2) {
    const drop = br.closed.length - KEEP_CLOSED;
    br.closed.splice(0, drop);
    S.lastClosed -= drop;
    M.closedSeen -= drop;
  }
  return events;
}

/** Marks the end of the first (warm-up) batch: from now on, candles are live observations. */
export function activate(M, nowMs) {
  if (M.activatedAt !== null) return false;
  M.activatedAt = iso(nowMs);
  M.warmedUpAt = iso(nowMs);
  return true;
}

/**
 * The candle history has a hole the mirror cannot fill truthfully: start a fresh strategy (same account, same
 * sequence) and record an open position as interrupted instead of dropping it silently.
 */
export function resetForGap(M, ctx, reason) {
  const S = M.strategy;
  const pos = S.broker.pos;
  if (pos) {
    const o = M.openTrade;
    push(M, {
      type: "POSITION_INTERRUPTED", event_id: `${M.accountId}:INTERRUPTED:${iso(pos.entryTime)}`,
      trade_id: mirrorTradeId(M.symbol, M.intervalMin, pos.entryTime, pos.side),
      side: sideName(pos.side), qty: pos.qty, entry_time: iso(pos.entryTime), entry_price: pos.avg,
      stop_price: o?.stop ?? null, tp2_price: o?.tp2 ?? null, last_candle: M.lastCandle?.t ?? null,
      last_close: M.lastCandle?.close ?? null, reason, processed_at: iso(ctx.nowMs),
      classification: o?.classification ?? "historical",
    });
    M.interruptions += 1;
  }
  M.resets.push({ at: iso(ctx.nowMs), reason, open_position_interrupted: !!pos });
  M.resets = M.resets.slice(-20);
  M.strategy = newStrategy(ctx);
  M.closedSeen = 0;
  M.openTrade = null;
}

/** The open hypothetical position, for the dashboard (unrealized at the last processed close). */
export function mirrorPosition(M) {
  const S = M.strategy;
  const p = S.broker.pos;
  if (!p) return null;
  const o = M.openTrade;
  const last = M.lastCandle?.close ?? null;
  return {
    trade_id: mirrorTradeId(M.symbol, M.intervalMin, p.entryTime, p.side), side: sideName(p.side), qty: p.qty,
    entry_time: iso(p.entryTime), entry_price: p.avg, initial_stop: o?.stop ?? null, current_stop: S.curStop ?? null,
    tp2: o?.tp2 ?? S.tp2P ?? null, notional_usd: p.qty * p.avg,
    unrealized_at_last_close: last === null ? null : (last - p.avg) * p.qty * p.side,
    classification: o?.classification ?? null,
  };
}

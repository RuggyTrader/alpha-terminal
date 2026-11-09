// PAPER fill emulator that follows TradingView's documented strategy broker emulator (bar magnifier off):
//  * Orders placed when a bar closes are worked from the NEXT bar.
//  * Intrabar path: open → high → low → close when the open is closer to the high than to the low,
//    otherwise open → low → high → close.
//  * Limit orders fill at their price, or at the open if the bar gaps through them (better price).
//    Stop orders fill at their price, or at the open on a gap (worse price).
//  * A strategy.exit bracket attached to an entry becomes active when the entry fills and can fill later on
//    the same bar's path. strategy.close_all(immediately=true) fills at the current bar's close.
// No commission or slippage (the Pine strategy uses the defaults: none). Nothing here talks to a broker.

export const newBroker = () => ({ pos: null, entry: null, exit: null, closed: [], netProfit: 0 });

function path(bar) {
  const { o, h, l, c } = bar;
  return Math.abs(h - o) < Math.abs(o - l) ? [o, h, l, c] : [o, l, h, c];
}

/** Price at which an order triggers while price moves from a to b (inclusive of a), or null. */
function triggerPrice(a, b, level, wantsUp) {
  if (level === null || level === undefined) return null;
  if (wantsUp) { // fills when price >= level
    if (a >= level) return a;
    return b >= level ? level : null;
  }
  if (a <= level) return a; // fills when price <= level
  return b <= level ? level : null;
}

/**
 * Conservative limit fills (research option limitThroughTicks > 0): a resting limit order fills only when price trades
 * THROUGH it by that many ticks (a touch may leave it unfilled in the queue), at the limit price, or at the open when
 * the bar gaps through it. Returns undefined when the option is off (the default emulator rule applies).
 */
function throughLimit(a, b, level, wantsUp, opt) {
  if (!(opt.limitThroughTicks > 0) || level === null || level === undefined) return undefined;
  const d = opt.limitThroughTicks * (opt.tick ?? 0.01);
  const hit = triggerPrice(a, b, wantsUp ? level + d : level - d, wantsUp);
  if (hit === null) return null;
  return (wantsUp ? a >= level : a <= level) ? a : level;
}

function fillEntry(br, price, bar, events) {
  const e = br.entry;
  br.pos = { side: e.side, qty: e.qty, avg: price, entryId: e.id, entryTime: bar.t, entryBar: bar.i };
  br.entry = null;
  events.push({ type: "ENTRY_FILL", side: e.side, qty: e.qty, price, time: bar.t, id: e.id });
}

function closePos(br, price, bar, kind, events) {
  const p = br.pos;
  const pnl = (price - p.avg) * p.qty * p.side * (br.pointValue ?? 1);
  const trade = { side: p.side, qty: p.qty, entryPrice: p.avg, exitPrice: price, entryTime: p.entryTime,
    exitTime: bar.t, entryBar: p.entryBar, exitBar: bar.i, exitKind: kind, pnl };
  br.closed.push(trade);
  br.netProfit += pnl;
  br.pos = null;
  br.exit = null;
  events.push({ type: "EXIT_FILL", kind, side: p.side, qty: p.qty, price, time: bar.t, pnl });
}

/** Works pending orders through one new bar, before the strategy script runs on that bar. */
export function processBar(br, bar) {
  const events = [];
  // Options (research variants; defaults = TradingView's documented emulator, the behaviour above):
  //   limitPrice "requested": a limit order that the open gaps through fills at its own price, not the open.
  //   exitDelayTicks 1: an exit bracket can fill only from the next tick (path point) after its entry filled.
  const opt = br.opts ?? {};
  let entrySeg = -1;
  if (br.entry && br.entry.limit === null && !br.pos) { fillEntry(br, bar.o, bar, events); entrySeg = 0; } // market entry: next open
  const pts = path(bar);
  const segments = [[pts[0], pts[0]], [pts[0], pts[1]], [pts[1], pts[2]], [pts[2], pts[3]]];
  for (let si = 0; si < segments.length; si++) {
    let [a, b] = segments[si];
    for (let guard = 0; guard < 4; guard++) {
      const cands = [];
      if (!br.pos && br.entry && br.entry.limit !== null) {
        let p = throughLimit(a, b, br.entry.limit, br.entry.side === -1, opt);
        if (p === undefined) p = triggerPrice(a, b, br.entry.limit, br.entry.side === -1); // buy limit fills on the way down
        if (p !== null && opt.limitPrice === "requested") p = br.entry.limit;
        if (p !== null) cands.push({ p, kind: "ENTRY" });
      }
      const exitsLive = !(opt.exitDelayTicks >= 1 && entrySeg === si);
      if (exitsLive && br.pos && br.exit && br.exit.from === br.pos.entryId) {
        const long = br.pos.side === 1;
        let tp = throughLimit(a, b, br.exit.limit, long, opt);
        if (tp === undefined) tp = triggerPrice(a, b, br.exit.limit, long);
        if (tp !== null && opt.limitPrice === "requested") tp = br.exit.limit;
        const sl = triggerPrice(a, b, br.exit.stop, !long);
        if (tp !== null) cands.push({ p: tp, kind: "TP" });
        if (sl !== null) cands.push({ p: sl, kind: "SL" });
      }
      if (cands.length === 0) break;
      cands.sort((x, y) => Math.abs(x.p - a) - Math.abs(y.p - a));
      const first = cands[0];
      if (first.kind === "ENTRY") { fillEntry(br, first.p, bar, events); entrySeg = si; }
      else closePos(br, first.p, bar, first.kind, events);
      a = first.p;
    }
  }
  return events;
}

/** strategy.entry: places or replaces the pending entry. Ignored while a position is open (pyramiding = 0). */
export function placeEntry(br, order) {
  if (br.pos) return false;
  br.entry = { id: order.id, side: order.side, qty: order.qty, limit: order.limit ?? null };
  return true;
}

/** strategy.exit: places or replaces the TP/SL bracket for an entry. */
export function placeExit(br, order) {
  br.exit = { from: order.from, limit: order.limit, stop: order.stop };
}

export function cancelAll(br) {
  br.entry = null;
  br.exit = null;
}

/** strategy.close_all(immediately = true): exits at the current bar's close. */
export function closeAll(br, bar, events) {
  if (br.pos) closePos(br, bar.c, bar, "CLOSE_ALL", events);
}

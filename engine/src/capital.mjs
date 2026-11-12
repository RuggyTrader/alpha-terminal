// Funded PAPER accounting for the bot fleet, simulated with EXACTLY the rules of the Worker's bot ledger
// (worker/src/bot_ledger.ts; docs/MULTI-BOT-ARCHITECTURE.md §6–§8). Used by backtests and tests; integer micro-USD.
//
//   * Every bot owns its wallet. No bot can spend another bot's money; MAIN never covers a bot's loss.
//   * Allocation: money moved from MAIN to a group is split EQUALLY between the group's bots (remainder micro-USD in
//     priority order), so the parts always sum exactly to the amount.
//   * LONG: the bot pays qty × price (reserved as the position's cost). SHORT (simulated): the bot posts cash equal to
//     qty × entry price as collateral; the proceeds are never spendable; no financing cost is modelled.
//   * Fees: FEE_PCT of every fill's notional (Ndax-equivalent 0.20%), entry and exit, charged to the bot.
//   * Close: gross = (exit − entry) × qty (LONG) or (entry − exit) × qty (SHORT); net = gross − entry fee − exit fee.
//     A positive net is swept to MAIN immediately (the bot's wallet returns to its pre-trade balance); a loss stays
//     with the bot. A loss beyond the bot's collateral and cash is a recorded shortfall and pauses its entries.

export const FEE_PCT = 0.2;
const M = 1_000_000;
export const toMicro = (usd) => Math.round(usd * M);
export const fromMicro = (m) => m / M;

export function splitEqual(amountMicro, botIds) {
  const n = botIds.length;
  if (!n) return [];
  const base = Math.floor(amountMicro / n);
  const rem = amountMicro - base * n;
  return botIds.map((id, i) => ({ botId: id, amountMicro: base + (i < rem ? 1 : 0) }));
}

export class FleetLedgerSim {
  /** bots: [{ id, group, priority }]; main: starting MAIN balance (USD). */
  constructor({ bots, main = 0, feePct = FEE_PCT, slippagePct = 0, maxOrderNotional = null, maxTotalExposure = null, maxOpenPositions = null }) {
    this.bots = [...bots].sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));
    this.wallet = { MAIN: { available: toMicro(main), reserved: 0, funding: toMicro(main), realized: 0, fees: 0, shortfall: 0 } };
    for (const b of this.bots) this.wallet[b.id] = { available: 0, reserved: 0, funding: 0, realized: 0, fees: 0, shortfall: 0 };
    this.feePct = feePct;
    this.slippagePct = slippagePct;
    this.limits = { maxOrderNotional, maxTotalExposure, maxOpenPositions };
    this.positions = new Map(); // botId -> position
    this.trades = [];           // closed trades (authoritative results)
    this.fills = [];            // every fill with its fee record
    this.sweeps = [];           // profit transfers to MAIN
    this.reductions = [];       // entries whose quantity was reduced to fit the wallet at the fill price
    this.allocations = [];
    this.paused = new Set();
    this.settled = new Set();   // settlement keys (idempotency)
    this.peakConcurrent = 0;
  }

  /** MAIN → group, equal split (owner action). Refused if MAIN lacks the unreserved money. */
  allocate(group, amountUsd, key = `ALLOC-${this.allocations.length + 1}`) {
    if (this.settled.has(key)) return { ok: true, duplicate: true };
    const amount = toMicro(amountUsd);
    const ids = this.bots.filter((b) => b.group === group).map((b) => b.id);
    if (!ids.length) return { ok: false, code: "NO_ACTIVE_BOTS" };
    if (amount > this.wallet.MAIN.available) return { ok: false, code: "INSUFFICIENT_MAIN" };
    const split = splitEqual(amount, ids);
    this.wallet.MAIN.available -= amount; this.wallet.MAIN.funding -= amount;
    for (const s of split) { this.wallet[s.botId].available += s.amountMicro; this.wallet[s.botId].funding += s.amountMicro; }
    this.settled.add(key);
    this.allocations.push({ key, group, amountMicro: amount, split });
    return { ok: true, split };
  }

  available(botId) { return fromMicro(this.wallet[botId].available); }
  totalReservedMicro() { let s = 0; for (const p of this.positions.values()) s += p.collateral; return s; }

  /** Opens a bot's position at the reference price. Returns null or a refusal code (nothing changes on refusal). */
  open(botId, side, qty, refPrice, meta = {}) {
    const w = this.wallet[botId];
    if (this.paused.has(botId)) return "BOT_ENTRIES_PAUSED";
    if (this.positions.has(botId)) return "POSITION_ALREADY_OPEN";
    const px = refPrice * (1 + (side === "LONG" ? 1 : -1) * this.slippagePct / 100);
    const requestedQty = qty;
    let notional = toMicro(qty * px);
    let fee = Math.round(notional * this.feePct / 100);
    // Same rule as the Worker (bot_ledger.ts): the fill price can exceed the sizing headroom, so the quantity is
    // REDUCED (never raised) to what this bot's own wallet can pay, floored to the venue step; refused only below the minimum.
    const spec = meta.instrument ?? null;
    if (spec && notional + fee > w.available) {
      const d = spec.qtyDecimals ?? 8;
      const fit = Math.floor((w.available / 1e6 / (px * (1 + this.feePct / 100))) * 10 ** d) / 10 ** d;
      const fitN = toMicro(fit * px), fitFee = Math.round(fitN * this.feePct / 100);
      if (fit >= (spec.minQty ?? 0) && fitN >= toMicro(spec.minNotional ?? 0) && fitN + fitFee <= w.available) { qty = fit; notional = fitN; fee = fitFee; }
    }
    const L = this.limits;
    if (L.maxOrderNotional && notional > toMicro(L.maxOrderNotional)) return "MAX_ORDER_NOTIONAL";
    if (L.maxOpenPositions && this.positions.size >= L.maxOpenPositions) return "MAX_OPEN_POSITIONS";
    if (L.maxTotalExposure && this.totalReservedMicro() + notional > toMicro(L.maxTotalExposure)) return "MAX_TOTAL_EXPOSURE";
    if (notional + fee > w.available) return "INSUFFICIENT_BOT_CAPITAL";
    w.available -= notional + fee; w.reserved += notional; w.fees += fee;
    const { instrument: _spec, ...rest } = meta;
    this.positions.set(botId, { botId, side, qty, requestedQty, reduced: qty !== requestedQty, entry: px, collateral: notional, entryFee: fee, ...rest });
    if (qty !== requestedQty) this.reductions.push({ botId, side, requestedQty, qty, price: px, openTime: meta.openTime ?? null });
    this.fills.push({ botId, kind: "ENTRY", side, qty, price: px, notional, fee });
    this.peakConcurrent = Math.max(this.peakConcurrent, this.positions.size);
    return null;
  }

  /** Closes the bot's OWN position (never another bot's). Idempotent by trade key. */
  close(botId, refPrice, meta = {}) {
    const p = this.positions.get(botId);
    if (!p) return { code: "NO_POSITION" };
    const key = `SWEEP:${botId}:${p.openTime ?? this.trades.length}`;
    if (this.settled.has(key)) return { code: "ALREADY_SETTLED" };
    const w = this.wallet[botId];
    const px = refPrice * (1 + (p.side === "LONG" ? -1 : 1) * this.slippagePct / 100);
    const exitNotional = toMicro(p.qty * px);
    const gross = p.side === "LONG" ? exitNotional - p.collateral : p.collateral - exitNotional;
    const exitFee = Math.round(exitNotional * this.feePct / 100);
    const net = gross - p.entryFee - exitFee;
    const paid = p.collateral + gross - exitFee;
    const shortfall = Math.max(0, -(w.available + paid));
    w.reserved -= p.collateral; w.fees += exitFee; w.realized += gross + shortfall; w.shortfall += shortfall;
    w.available = Math.max(0, w.available + paid);
    const sweep = net > 0 ? net : 0;
    if (sweep) { w.available -= sweep; w.funding -= sweep; this.wallet.MAIN.available += sweep; this.wallet.MAIN.funding += sweep; this.sweeps.push({ botId, amountMicro: sweep, key }); }
    if (shortfall) this.paused.add(botId);
    this.settled.add(key);
    this.positions.delete(botId);
    this.fills.push({ botId, kind: "EXIT", side: p.side, qty: p.qty, price: px, notional: exitNotional, fee: exitFee });
    const t = { ...p, ...meta, exit: px, gross, entryFee: p.entryFee, exitFee, net, sweep, shortfall };
    this.trades.push(t);
    return { trade: t };
  }

  /** Per wallet: available + reserved = funding + realized − fees (realized = what the wallet paid; shortfall apart). */
  reconciles() {
    for (const [, w] of Object.entries(this.wallet)) {
      if (w.available < 0 || w.reserved < 0) return false;
      if (w.available + w.reserved !== w.funding + w.realized - w.fees) return false;
    }
    return true;
  }
}

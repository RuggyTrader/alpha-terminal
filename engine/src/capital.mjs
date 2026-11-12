// Central capital protection for a fleet of bots (docs/MULTI-BOT-ARCHITECTURE.md §3).
//
// The Worker's ALPHA PAPER ledger is the authority. Every accepted entry reserves its full cost in ONE D1 transaction
// guarded by CHECK constraints: the wallet can never go below $0, and a bot with an allocation cap can never hold more
// reserved than its cap. Two bots therefore can never both spend the same dollars, whatever the engine believes.
//
// The engine adds EARMARKS so that bots sharing a wallet do not plan against the same dollars in the first place: a
// resting entry order (placed, not yet filled) reserves nothing in the ledger yet, so without an earmark a second bot
// would size its own order from the full balance and one of the two would be refused at fill time. With earmarks:
//   capital a bot may size from = ledger available for that bot − cost of OTHER bots' resting entries on the wallet.
// Bots are processed in a deterministic order (src/fleet.mjs), so the first bot to place an order keeps its earmark and
// the next one sizes from what is left (allocateCapital's ordering: candle close, priority, id).

/** Estimated cash a resting entry order will need when it fills: qty × limit with the price buffer and fee headroom. */
export function pendingEntryCost(S) {
  const e = S?.broker?.entry;
  if (!e || !(e.qty > 0) || e.side !== 1) return 0; // long-only funded ledger: a short reserves nothing (never sent)
  const px = e.limit ?? S.lastClose ?? null;
  if (!(px > 0)) return 0;
  const z = S.sizing ?? {};
  return e.qty * px * (1 + (z.priceBufferPct ?? 0) / 100) * (1 + (z.feePct ?? 0) / 100);
}

export class CapitalBook {
  constructor() {
    this.members = new Map(); // botId -> { wallet, priority, pendingCost(): number }
  }

  register(botId, { wallet, priority = 99, pendingCost }) {
    if (this.members.has(botId)) throw new Error(`${botId} is already registered in the capital book`);
    if (typeof pendingCost !== "function") throw new Error("pendingCost must be a function");
    this.members.set(botId, { wallet, priority, pendingCost });
  }

  /** Earmarks of resting entries on a wallet: [{ botId, cost }] (cost > 0 only). */
  earmarks(wallet, exceptBotId = null) {
    const out = [];
    for (const [id, m] of this.members) {
      if (m.wallet !== wallet || id === exceptBotId) continue;
      const cost = Number(m.pendingCost()) || 0;
      if (cost > 0) out.push({ botId: id, cost });
    }
    return out;
  }

  /**
   * What `botId` may size from, given what the ledger reports as available to it (already net of every filled
   * position's reservation, and of its own allocation cap). Unknown stays unknown (null), never guessed.
   */
  capitalFor(botId, ledgerAvailable) {
    if (ledgerAvailable === null || ledgerAvailable === undefined || !Number.isFinite(ledgerAvailable)) return null;
    const m = this.members.get(botId);
    if (!m) throw new Error(`${botId} is not in the capital book`);
    const others = this.earmarks(m.wallet, botId).reduce((s, x) => s + x.cost, 0);
    return Math.max(0, ledgerAvailable - others);
  }

  snapshot() {
    const wallets = {};
    for (const [id, m] of this.members) (wallets[m.wallet] ??= []).push({ botId: id, priority: m.priority, earmarked: Number((m.pendingCost() || 0).toFixed(6)) });
    return wallets;
  }
}

/**
 * Simulated ALPHA PAPER ledger for backtests: the same rules the Worker enforces (long-only, full cost reserved from
 * the wallet at fill, optional per-bot cap, account-wide limits, fees on both sides), applied in one place for every
 * bot so shared capital is modelled exactly once. Returns a refusal code or null.
 */
export class SimLedger {
  constructor({ wallets, caps = {}, feePct = 0, slippagePct = 0, maxOrderNotional = null, maxTotalExposure = null, maxOpenPositions = null }) {
    this.available = { ...wallets };
    this.start = { ...wallets };
    this.caps = { ...caps };
    this.feePct = feePct;
    this.slippagePct = slippagePct;
    this.maxOrderNotional = maxOrderNotional;
    this.maxTotalExposure = maxTotalExposure;
    this.maxOpenPositions = maxOpenPositions;
    this.positions = new Map(); // `${botId}` -> { wallet, qty, entry, cost }
    this.reservedByBot = {};
    this.realized = {}; // botId -> net P&L
    this.walletRealized = {}; // wallet -> net P&L (reconciliation)
    this.fees = {};
    this.peakReserved = 0;
    this.peakConcurrent = 0;
    this.minAvailable = Math.min(...Object.values(wallets)); // must never go below 0 (the Worker's CHECK)
  }

  totalReserved() { let s = 0; for (const p of this.positions.values()) s += p.cost; return s; }
  availableFor(botId, wallet) {
    const w = this.available[wallet] ?? 0;
    const cap = this.caps[botId];
    return cap === undefined || cap === null ? w : Math.min(w, cap - (this.reservedByBot[botId] ?? 0));
  }

  buy(botId, wallet, qty, refPrice) {
    if (this.positions.has(botId)) return "POSITION_ALREADY_OPEN"; // one position per bot (never merged across bots)
    const px = refPrice * (1 + this.slippagePct / 100);
    const cost = qty * px;
    const fee = cost * this.feePct / 100;
    if (this.maxOrderNotional && cost > this.maxOrderNotional) return "MAX_ORDER_NOTIONAL";
    if (this.maxOpenPositions && this.positions.size >= this.maxOpenPositions) return "MAX_OPEN_POSITIONS";
    if (this.maxTotalExposure && this.totalReserved() + cost > this.maxTotalExposure) return "MAX_TOTAL_EXPOSURE";
    const cap = this.caps[botId];
    if (cap !== undefined && cap !== null && (this.reservedByBot[botId] ?? 0) + cost > cap + 1e-9) return "BOT_ALLOCATION_EXCEEDED";
    if (cost + fee > (this.available[wallet] ?? 0) + 1e-9) return "INSUFFICIENT_PAPER_CAPITAL";
    this.available[wallet] -= cost + fee;
    this.minAvailable = Math.min(this.minAvailable, this.available[wallet]);
    this.reservedByBot[botId] = (this.reservedByBot[botId] ?? 0) + cost;
    this.positions.set(botId, { wallet, qty, entry: px, cost });
    this.fees[botId] = (this.fees[botId] ?? 0) + fee;
    this.realized[botId] = (this.realized[botId] ?? 0) - fee;
    this.walletRealized[wallet] = (this.walletRealized[wallet] ?? 0) - fee;
    this.peakReserved = Math.max(this.peakReserved, this.totalReserved());
    this.peakConcurrent = Math.max(this.peakConcurrent, this.positions.size);
    return null;
  }

  sell(botId, refPrice) {
    const p = this.positions.get(botId);
    if (!p) return "NO_POSITION";
    const px = refPrice * (1 - this.slippagePct / 100);
    const value = p.qty * px;
    const fee = value * this.feePct / 100;
    this.available[p.wallet] += value - fee;
    this.reservedByBot[botId] -= p.cost;
    this.positions.delete(botId);
    this.fees[botId] = (this.fees[botId] ?? 0) + fee;
    this.realized[botId] = (this.realized[botId] ?? 0) + (value - p.cost) - fee;
    this.walletRealized[p.wallet] = (this.walletRealized[p.wallet] ?? 0) + (value - p.cost) - fee;
    return null;
  }

  /** wallet balance = start + Σ realized (after every position is closed), the reconciliation invariant. */
  reconciles() {
    for (const w of Object.keys(this.start)) {
      const open = [...this.positions.values()].filter((p) => p.wallet === w).reduce((s, p) => s + p.cost, 0);
      if (Math.abs(this.available[w] + open - (this.start[w] + (this.walletRealized[w] ?? 0))) > 1e-6) return false;
    }
    return true;
  }
}

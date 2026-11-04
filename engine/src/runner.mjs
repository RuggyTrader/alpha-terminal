// Live PAPER runner: completed Kraken candles → OTE engine → ALPHA TERMINAL (existing /webhook/dry-run path).
//
// * Only completed candles are processed, in order, exactly once (state.lastTime). State is saved after every
//   step with an atomic write, so a restart resumes exactly where it stopped.
// * Fills become outbox items with deterministic ids (ENG-<symbol>-<tf>-<bar time>-<action>). The Worker's
//   duplicate protection and the outbox status make re-sends harmless; nothing is ever sent twice as new.
// * Fills from candles that closed more than `lateBars` intervals ago (catch-up after downtime) and from the
//   warm-up history are recorded but NOT sent: the Worker fills at the current price, so a stale signal would
//   be misleading.
// * No broker is contacted anywhere in this engine. ALPHA TERMINAL stays PAPER / DRY RUN.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCompletedCandles } from "./kraken.mjs";
import { createState, onBar, summarize } from "./ote.mjs";

export const ENGINE_VERSION = "0.1.0";
export const STRATEGY_NAME = "OTE Pro Strat (engine)";

const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const fmtQty = (q) => q.toFixed(8).replace(/\.?0+$/, "");

export function inputsHash(cfg) {
  return createHash("sha256").update(JSON.stringify({ v: 1, symbol: cfg.symbol, tf: cfg.intervalMin, inputs: cfg.inputs ?? {} })).digest("hex").slice(0, 16);
}

export class EngineRunner {
  constructor(cfg, { fetchCandles = fetchCompletedCandles, http = fetch, now = () => Date.now(), log = console.log } = {}) {
    this.cfg = cfg;
    this.fetchCandles = fetchCandles;
    this.http = http;
    this.now = now;
    this.log = log;
    this.step = cfg.intervalMin * 60_000;
    this.file = join(cfg.dataDir, `state-${cfg.symbol}-${cfg.intervalMin}m.json`);
    mkdirSync(cfg.dataDir, { recursive: true });
    this.state = this.load();
  }

  load() {
    if (!existsSync(this.file)) return null;
    const s = JSON.parse(readFileSync(this.file, "utf8"));
    if (s.inputsHash !== inputsHash(this.cfg)) {
      this.log(`[engine] saved state was made with different settings; starting a fresh warm-up`);
      return null;
    }
    return s;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  fresh(reason) {
    this.state = {
      version: ENGINE_VERSION, inputsHash: inputsHash(this.cfg), startedAt: iso(this.now()), warmedUpAt: null, resets: [],
      strategy: createState({ symbol: this.cfg.symbol, timeframeMin: this.cfg.intervalMin, inputs: this.cfg.inputs }),
      outbox: [], lastPollAt: null, lastError: null, candlesProcessed: 0, lastCandle: null,
    };
    if (reason) this.state.resets.push({ at: iso(this.now()), reason });
  }

  /** One poll: process every new completed candle, then sync. Safe to call at any time. */
  async tick() {
    const nowMs = this.now();
    if (!this.state) this.fresh();
    const S = this.state;
    // The first batch after a (re)start from scratch is warm-up history: processed, never sent.
    const warmup = S.warmedUpAt === null;
    let candles;
    try {
      candles = await this.fetchCandles({ symbol: this.cfg.symbol, intervalMin: this.cfg.intervalMin, sinceMs: S.strategy.lastTime, base: this.cfg.krakenBase, nowMs });
    } catch (e) {
      S.lastError = { at: iso(nowMs), where: "market-data", message: String(e.message ?? e) };
      this.log(`[engine] candle fetch failed: ${S.lastError.message}`);
      this.save();
      await this.heartbeat();
      return { processed: 0, error: S.lastError };
    }
    S.lastPollAt = iso(nowMs);

    // A hole in the candle history cannot be filled truthfully: start a fresh warm-up from what Kraken has.
    if (S.strategy.lastTime !== null && candles.length && candles[0].t > S.strategy.lastTime + this.step) {
      const missing = Math.round((candles[0].t - S.strategy.lastTime) / this.step) - 1;
      this.log(`[engine] ${missing} candle(s) missing since ${iso(S.strategy.lastTime)}; re-warming from available history`);
      const outbox = S.outbox;
      const resets = S.resets;
      this.fresh(`gap of ${missing} candles after ${iso(S.strategy.lastTime)}`);
      this.state.outbox = outbox;
      this.state.resets = [...resets, ...this.state.resets].slice(-20);
      return this.tick();
    }

    let processed = 0;
    for (const k of candles) {
      const events = onBar(S.strategy, k);
      processed += 1;
      S.candlesProcessed += 1;
      S.lastCandle = { t: iso(k.t), close: k.c };
      const closeMs = k.t + this.step;
      const late = nowMs - closeMs > this.cfg.lateBars * this.step;
      for (const e of events) {
        if (e.type !== "ENTRY_FILL" && e.type !== "EXIT_FILL") continue;
        const action = e.type === "EXIT_FILL" ? "CLOSE" : e.side === 1 ? "BUY" : "SELL";
        const id = `ENG-${this.cfg.symbol}-${this.cfg.intervalMin}-${iso(k.t)}-${action}`;
        if (S.outbox.some((x) => x.id === id)) continue;
        S.outbox.push({
          id, action, qty: action === "CLOSE" ? null : fmtQty(e.qty), enginePrice: e.price, exitKind: e.kind ?? null,
          barTime: iso(k.t), barClose: iso(closeMs), createdAt: iso(nowMs),
          status: warmup ? "historical" : late ? "late" : "pending", code: null, attempts: 0,
        });
      }
    }
    if (warmup) S.warmedUpAt = iso(nowMs);
    S.outbox = S.outbox.slice(-200);
    S.lastError = null;
    this.save();
    if (processed) this.log(`[engine] processed ${processed} candle(s) up to ${S.lastCandle.t}; status: ${S.strategy.status}`);
    await this.flush();
    await this.heartbeat();
    return { processed };
  }

  /** Sends pending outbox items in order. Stops at the first retryable failure to keep BUY/CLOSE ordering. */
  async flush() {
    if (!this.cfg.sync) return;
    for (const item of this.state.outbox) {
      if (item.status !== "pending") continue;
      item.attempts += 1;
      let status = 0, body = {};
      try {
        const r = await this.http(`${this.cfg.apiBase}/webhook/dry-run`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({
            secret: this.cfg.webhookSecret, id: item.id, symbol: this.cfg.symbol, timeframe: String(this.cfg.intervalMin),
            action: item.action, strategy: STRATEGY_NAME, ...(item.qty === null ? {} : { qty: Number(item.qty) }), timestamp: item.barClose,
          }),
        });
        status = r.status;
        body = await r.json().catch(() => ({}));
      } catch (e) {
        this.state.lastError = { at: iso(this.now()), where: "sync", message: String(e.message ?? e) };
        this.save();
        return;
      }
      item.code = body.code ?? `HTTP_${status}`;
      if (status === 200) item.status = "sent"; // DRY_RUN_ACCEPTED or DUPLICATE (already recorded)
      else if (status === 400 || status === 422) item.status = "rejected"; // final, with ALPHA TERMINAL's reason
      else {
        // 401 (secret), 5xx (nothing committed; retryable): keep it pending and stop here.
        this.state.lastError = { at: iso(this.now()), where: "sync", message: `${item.id}: ${item.code} ${body.message ?? ""}`.trim() };
        this.save();
        return;
      }
      this.save();
    }
  }

  /** Status shown on the dashboard. Engine-side numbers only; ALPHA PAPER ledger figures stay separate. */
  statusPayload() {
    const S = this.state;
    const st = S.strategy;
    const pos = st.broker.pos;
    const lastClose = S.lastCandle?.close ?? null;
    const sum = summarize(st);
    return {
      engine: "alpha-engine", version: ENGINE_VERSION, mode: "PAPER", symbol: this.cfg.symbol, timeframe: `${this.cfg.intervalMin}m`,
      strategy: STRATEGY_NAME, started_at: S.startedAt, warmed_up_at: S.warmedUpAt, last_poll_at: S.lastPollAt,
      last_candle_time: S.lastCandle?.t ?? null, last_candle_close: lastClose, candles_processed: S.candlesProcessed,
      status_text: st.status, sync: this.cfg.sync,
      position: pos ? {
        side: pos.side === 1 ? "LONG" : "SHORT", qty: Number(pos.qty.toFixed(8)), entry: pos.avg,
        stop: st.curStop, tp2: st.tp2P,
        unrealized_at_last_close: lastClose === null ? null : Number(((lastClose - pos.avg) * pos.qty * pos.side).toFixed(2)),
      } : null,
      trades: { closed: sum.trades, wins: sum.wins, losses: sum.losses, net_pnl: sum.netProfit },
      outbox: {
        pending: S.outbox.filter((x) => x.status === "pending").length,
        rejected: S.outbox.filter((x) => x.status === "rejected").length,
        late: S.outbox.filter((x) => x.status === "late").length,
      },
      last_error: S.lastError,
    };
  }

  async heartbeat() {
    if (!this.cfg.sync || !this.state) return;
    try {
      const r = await this.http(`${this.cfg.apiBase}/webhook/engine-status`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ secret: this.cfg.webhookSecret, status: this.statusPayload() }),
      });
      if (!r.ok) this.log(`[engine] status update rejected: HTTP ${r.status}`);
    } catch (e) {
      this.log(`[engine] status update failed: ${e.message ?? e}`);
    }
  }
}

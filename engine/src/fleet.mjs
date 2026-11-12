// A fleet of independent bots in one process (docs/MULTI-BOT-ARCHITECTURE.md §11).
//
// * One EngineRunner per bot (src/bots.mjs), each with its own config, candle stream, strategy state, pending orders,
//   positions, exits, mirror account, audit file, signal ids and ledger ownership. Nothing a bot decides is visible to
//   another bot's strategy: they share only the process, a per-round market-data cache and the capital book.
// * Bots are polled one after another in a deterministic order (priority, then id). Every bot sizes from its OWN
//   wallet (the Worker's bot ledger), so no bot's order can depend on, or consume, another bot's capital.
// * Failure isolation: an exception or a hung poll in one bot is recorded for that bot only; the others continue. A bot
//   whose poll is still running is never polled a second time (no two writers on one state).
// * Market data: one Kraken OHLC request per (symbol, timeframe) per round, served to every bot that needs it.

import { fetchCompletedCandles } from "./kraken.mjs";
import { EngineRunner } from "./runner.mjs";

/** Per-round candle cache: a later request for the same market/timeframe with an equal or later `since` is served
 *  from the first response (filtered), so N bots on one market cost one request. */
export class CandleCache {
  constructor(fetchCandles = fetchCompletedCandles) {
    this.fetchCandles = fetchCandles;
    this.entries = new Map();
    this.requests = 0;
  }
  newRound() { this.entries.clear(); }
  fetch(args) {
    const key = `${args.symbol}|${args.intervalMin}`;
    const since = args.sinceMs ?? null;
    const hit = this.entries.get(key);
    if (hit && (hit.since === null || (since !== null && since >= hit.since))) {
      return hit.promise.then((list) => list.filter((k) => since === null || k.t > since));
    }
    this.requests += 1;
    const promise = this.fetchCandles(args);
    this.entries.set(key, { since, promise });
    promise.catch(() => this.entries.delete(key)); // a failed fetch is not cached
    return promise;
  }
}

export class FleetRunner {
  /**
   * bots: [{ bot, cfg }] (cfg from loadBotConfigs). makeRunner(cfg, deps) builds the runner (tests inject candles/http).
   */
  constructor(bots, { makeRunner = (cfg, deps) => new EngineRunner(cfg, deps), fetchCandles = fetchCompletedCandles,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 1_100, timeoutMs = 90_000, log = console.log } = {}) {
    if (!bots.length) throw new Error("no bots configured");
    const ids = bots.map((b) => b.bot.id);
    if (new Set(ids).size !== ids.length) throw new Error("a bot is configured twice");
    const tags = bots.map((b) => b.cfg.fileTag);
    if (new Set(tags).size !== tags.length) throw new Error("two bots would share state files");
    this.sleep = sleep;
    this.pauseMs = pauseMs;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.cache = new CandleCache(fetchCandles);
    const ordered = [...bots].sort((a, b) => (a.bot.priority - b.bot.priority) || a.bot.id.localeCompare(b.bot.id));
    this.bots = ordered.map(({ bot, cfg }) => {
      const runner = makeRunner(cfg, { fetchCandles: (args) => this.cache.fetch(args) });
      return { id: bot.id, bot, runner, last: null, inflight: null };
    });
  }

  /** Polls every bot once, in allocation order. Returns one result per bot; never throws because of one bot. */
  async round() {
    this.cache.newRound();
    const results = [];
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (i > 0 && this.pauseMs) await this.sleep(this.pauseMs);
      if (b.inflight) {
        b.last = { at: new Date().toISOString(), ok: false, error: { where: "poll", message: "previous poll still running; skipped" } };
        results.push({ bot: b.id, ...b.last });
        continue;
      }
      let timer;
      const tick = b.runner.tick().finally(() => { b.inflight = null; });
      b.inflight = tick;
      tick.catch(() => {});
      try {
        const r = await Promise.race([
          tick,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`poll timed out after ${this.timeoutMs} ms`)), this.timeoutMs); }),
        ]);
        b.last = { at: new Date().toISOString(), ok: !r?.error, ...(r ?? {}) };
      } catch (e) {
        const message = String(e?.message ?? e).slice(0, 240);
        b.last = { at: new Date().toISOString(), ok: false, error: { where: "poll", message } };
        try { b.runner.audit({ type: "error", where: "poll", message }); } catch { /* best effort */ }
        this.log(`[fleet] ${b.id}: ${message} (other bots continue)`);
      } finally {
        clearTimeout(timer);
      }
      results.push({ bot: b.id, ...b.last });
    }
    return results;
  }

  /** Per-bot health for logs and the status heartbeat. */
  health() {
    return this.bots.map((b) => {
      const S = b.runner.state;
      return {
        bot_id: b.id, symbol: b.bot.symbol, timeframe: `${b.bot.intervalMin}m`, last_candle: S?.lastCandle?.t ?? null,
        status: S?.strategy?.status ?? null, pending_entry: !!S?.strategy?.broker?.entry, position: !!S?.strategy?.broker?.pos,
        last_error: S?.lastError ?? null, last_poll_ok: b.last?.ok ?? null,
      };
    });
  }
}

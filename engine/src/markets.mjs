// Multi-market Strategy Mirror (mirror-only markets, ENGINE_FUNDED=off), one process.
//
// * One EngineRunner per market, each with its own config, candles, strategy state, mirror state file, audit file,
//   account, trade ids and sequence. Nothing is shared between markets except the process.
// * Markets are polled one after another. Each poll is isolated: an exception or a hung request (timeout) in one
//   market is recorded for that market only; the others are polled as usual. A market that failed is retried on the
//   next poll and resumes from its own saved state (catch-up, observation gap), like after an engine restart.
// * A short pause between markets keeps public Kraken calls spaced (Kraken's public endpoints allow about one call
//   per second).
// * Mirror-only: no funded signal, ledger query, engine status or website setting is ever sent for these markets.

import { EngineRunner } from "./runner.mjs";

export class MarketsRunner {
  constructor(configs, { makeRunner = (cfg) => new EngineRunner(cfg), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 1_100, timeoutMs = 90_000, log = console.log } = {}) {
    if (!configs.length) throw new Error("no markets configured");
    for (const c of configs) {
      if (c.funded !== false || c.mirror !== true) throw new Error(`${c.symbol}: the multi-market process runs mirror-only markets (ENGINE_FUNDED=off, ENGINE_MIRROR=on)`);
    }
    if (new Set(configs.map((c) => c.symbol)).size !== configs.length) throw new Error("a market is configured twice");
    this.sleep = sleep;
    this.pauseMs = pauseMs;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.markets = configs.map((cfg) => ({ symbol: cfg.symbol, runner: makeRunner(cfg), last: null, inflight: null }));
  }

  /** Polls every market once, in order. Returns one result per market; never throws because of one market. */
  async round() {
    const results = [];
    for (let i = 0; i < this.markets.length; i++) {
      const m = this.markets[i];
      if (i > 0) await this.sleep(this.pauseMs);
      // A poll that timed out may still be running: never start a second one on the same market state.
      if (m.inflight) {
        m.last = { at: new Date().toISOString(), ok: false, error: { where: "poll", message: "previous poll still running; skipped" } };
        results.push({ symbol: m.symbol, ...m.last });
        continue;
      }
      let timer;
      const tick = m.runner.tick().finally(() => { m.inflight = null; });
      m.inflight = tick;
      tick.catch(() => {}); // its outcome is handled below, or it finished after a timeout
      try {
        const r = await Promise.race([
          tick,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`poll timed out after ${this.timeoutMs} ms`)), this.timeoutMs); }),
        ]);
        m.last = { at: new Date().toISOString(), ok: !r?.error, ...(r ?? {}) };
      } catch (e) {
        const message = String(e?.message ?? e).slice(0, 240);
        m.last = { at: new Date().toISOString(), ok: false, error: { where: "poll", message } };
        try { m.runner.audit({ type: "error", where: "poll", message }); } catch { /* audit is best effort */ }
        this.log(`[markets] ${m.symbol}: ${message} (other markets continue)`);
      } finally {
        clearTimeout(timer);
      }
      results.push({ symbol: m.symbol, ...m.last });
    }
    return results;
  }
}

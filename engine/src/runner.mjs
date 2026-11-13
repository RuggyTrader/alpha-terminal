// Live PAPER runner: completed Kraken candles → OTE engine → ALPHA TERMINAL (existing /webhook/dry-run path).
//
// * Only completed candles are processed, in order, exactly once (state.lastTime). State is saved after every
//   step with an atomic write, so a restart resumes exactly where it stopped.
// * Fills become outbox items with deterministic ids (ENG-<symbol>-<tf>-<bar time>-<action>). The Worker's
//   duplicate protection and the outbox status make re-sends harmless; nothing is ever sent twice as new.
// * Fills from candles that closed more than `lateBars` intervals ago (catch-up after downtime) and from the
//   warm-up history are recorded but NOT sent: the Worker fills at the current price, so a stale signal would
//   be misleading.
// * Every exit is linked to its entry. A CLOSE is sent only if that entry was ACCEPTED into the ALPHA PAPER
//   ledger; otherwise it is recorded as `skipped` with the reason (entry rejected / historical / late). So a
//   rejected or warm-up entry can never produce a CLOSE against the ledger.
// * Item statuses: pending → accepted | rejected | skipped; historical items are never sent. Every final status
//   keeps ALPHA TERMINAL's code and message (or the engine's reason).
// * Freshness is enforced at DELIVERY: an entry not delivered within `lateBars` candles of its candle close is
//   never sent (skipped, SIGNAL_EXPIRED), so it cannot fill at a later price after an outage. If an earlier attempt
//   may have reached ALPHA TERMINAL, its real outcome is read from the ledger first.
// * Exits of accepted entries are still delivered when late (otherwise the ledger would keep a position the engine
//   closed), but only after checking that the ledger still holds exactly that entry's position, never twice, and
//   recorded as delayed.
// * A live entry that ALPHA TERMINAL finally refuses (e.g. INSUFFICIENT_PAPER_CAPITAL), or that expires unsent, is
//   dropped from the engine's simulated position at once: no exit, no closed trade, no P&L, back to waiting for a
//   new setup. The engine therefore never holds a position the PAPER portfolio does not hold, never counts a refused
//   trade in its own results, and can take the next setup. Warm-up history keeps its simulated position as before.
// * After every poll the engine reads the ledger (read-only) and compares it with its own position; a mismatch is
//   reported as DIVERGED instead of being called mirrored. Nothing is auto-corrected.
// * No broker is contacted anywhere in this engine. ALPHA TERMINAL stays PAPER / DRY RUN.

import { exitRecord, newPlanState, updatePlan } from "./tradeplan.mjs";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCompletedCandles } from "./kraken.mjs";
import { abandonPosition, createState, onBar, summarize } from "./ote.mjs";
import { DEFAULT_SIZING } from "./sizing.mjs";
import { activate, createMirror, MIRROR_STATE_VERSION, mirrorPosition, mirrorStep, resetForGap } from "./mirror.mjs";

/** The pinned release this engine runs from (RELEASE.json next to src/), or null in a development checkout. */
const RELEASE = (() => {
  try {
    const m = JSON.parse(readFileSync(new URL("../RELEASE.json", import.meta.url), "utf8"));
    return { release: String(m.release ?? "").slice(0, 40) || null, commit: String(m.commit ?? "").slice(0, 40) || null };
  } catch {
    return { release: null, commit: null };
  }
})();

export const ENGINE_VERSION = "0.1.0";
export const STRATEGY_NAME = "OTE Pro Strat (engine)";

const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const fmtQty = (q) => q.toFixed(8).replace(/\.?0+$/, "");

// v2: outbox items link exits to entries. v3: TradingView pivot tie rule (older-bar ties count); saved state from
// v2 used the old rule, so it starts a fresh warm-up.
export function inputsHash(cfg) {
  return createHash("sha256").update(JSON.stringify({ v: 3, symbol: cfg.symbol, tf: cfg.intervalMin, inputs: cfg.inputs ?? {} })).digest("hex").slice(0, 16);
}

const FINAL = new Set(["accepted", "rejected", "skipped", "historical", "late"]);

// Strategy Mirror delivery. Each request carries at most MIRROR_BATCH records (the Worker accepts 25 and uses at most
// 9 D1 queries per request, inside Workers Free limits). Without new records or a new candle, the mirror reports at
// most every MIRROR_HEARTBEAT_MS, so it adds about one request per candle, not one per poll.
export const MIRROR_BATCH = 25;
export const MIRROR_HEARTBEAT_MS = 15 * 60_000;
// Kraken's OHLC endpoint serves the latest 720 candles. A hole after the mirror's last candle is a real data gap only
// when that candle is older than this window; inside it, Kraken served the missing intervals as "no trades" (dropped,
// because TradingView has no bar for them).
const KRAKEN_OHLC_WINDOW = 720;

export class EngineRunner {
  constructor(cfg, { fetchCandles = fetchCompletedCandles, http = fetch, now = () => Date.now(), log = console.log, capitalBook = null } = {}) {
    this.cfg = cfg;
    // Fleet bots (src/bots.mjs): cfg.botId identifies the bot in every signal, ledger query and status report; new bots
    // carry it in file names and signal ids too (cfg.fileTag / cfg.idPrefix). Without a bot id: the single engine as before.
    this.tag = cfg.fileTag ?? `${cfg.symbol}-${cfg.intervalMin}m`;
    this.idPrefix = cfg.idPrefix ?? `ENG-${cfg.symbol}-${cfg.intervalMin}`;
    // Shared capital protection between bots on the same wallet (src/capital.mjs); null for a single engine.
    this.capitalBook = capitalBook;
    this.fetchCandles = fetchCandles;
    this.http = http;
    this.now = now;
    this.log = log;
    this.step = cfg.intervalMin * 60_000;
    this.file = join(cfg.dataDir, `state-${this.tag}.json`);
    // Append-only audit trail (one JSON object per line): every processed candle with the strategy's decisions,
    // every signal result, ledger-check changes, errors and resets. Never rewritten; safe to read while running.
    this.auditFile = cfg.audit === false ? null : join(cfg.dataDir, `audit-${this.tag}.jsonl`);
    mkdirSync(cfg.dataDir, { recursive: true });
    this.state = this.load();
    // State saved by an older engine may still hold the position of an entry the ledger already refused or that
    // expired unsent: drop it now (once), so the engine starts consistent with the ledger.
    const open = this.state?.openEntryId ? this.state.outbox.find((x) => x.id === this.state.openEntryId) : null;
    if (open && open.kind === "ENTRY" && (open.status === "rejected" || open.status === "skipped") && this.dropRefusedEntry(open)) this.save();
    // Track B, the Strategy Mirror: its own file, its own state. Nothing the funded track does can change it.
    this.mirrorFile = join(cfg.dataDir, `mirror-${this.tag}.json`);
    this.mirror = cfg.mirror ? this.loadMirror() : null;
  }

  loadMirror() {
    if (!existsSync(this.mirrorFile)) return null;
    const m = JSON.parse(readFileSync(this.mirrorFile, "utf8"));
    if (m.version === MIRROR_STATE_VERSION && m.inputsHash === inputsHash(this.cfg)) return m;
    // Different strategy inputs are a different mirror account: keep the old file, start a new one.
    const keep = `${this.mirrorFile}.superseded-${iso(this.now()).replace(/:/g, "-")}`;
    renameSync(this.mirrorFile, keep);
    this.log(`[engine] mirror state was made with different settings; kept as ${keep}, starting a new mirror account`);
    return null;
  }

  saveMirror() {
    if (!this.mirror) return;
    const tmp = `${this.mirrorFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.mirror));
    renameSync(tmp, this.mirrorFile);
  }

  mirrorCtx(nowMs) {
    const risk = this.state?.settings?.riskUSD;
    return {
      nowMs, lateMs: this.cfg.lateBars * this.step, symbol: this.cfg.symbol, intervalMin: this.cfg.intervalMin,
      inputs: { ...this.cfg.inputs, ...(typeof risk === "number" ? { riskUSD: risk } : {}) }, pivotTies: this.cfg.pivotTies,
      inputsHash: inputsHash(this.cfg),
      entryEvents: this.cfg.mirrorEvents === true,
    };
  }

  /**
   * Feeds the mirror every candle of this poll it has not seen yet. A failure here is recorded and reported; it never
   * stops or changes the funded track.
   */
  stepMirror(candles, nowMs) {
    const ctx = this.mirrorCtx(nowMs);
    if (!this.mirror) {
      this.mirror = createMirror(ctx);
      this.audit({ type: "mirror_created", account_id: this.mirror.accountId });
    }
    const M = this.mirror;
    try {
      const last = M.strategy.lastTime;
      const mine = candles.filter((k) => last === null || k.t > last);
      if (last !== null && mine.length && mine[0].t > last + this.step && nowMs - last <= (KRAKEN_OHLC_WINDOW - 2) * this.step) {
        // Inside Kraken's window: the skipped intervals had no trades. No bar, as on TradingView; nothing to reset.
        M.noTradeIntervals = (M.noTradeIntervals ?? 0) + Math.round((mine[0].t - last) / this.step) - 1;
      } else if (last !== null && mine.length && mine[0].t > last + this.step) {
        const missing = Math.round((mine[0].t - last) / this.step) - 1;
        const reason = `gap of ${missing} candles after ${iso(last)}`;
        const open = !!M.strategy.broker.pos;
        resetForGap(M, ctx, reason);
        this.audit({ type: "mirror_reset", reason, open_position_interrupted: open });
        this.log(`[engine] mirror: ${reason}; fresh warm-up${open ? ", open hypothetical position recorded as interrupted" : ""}`);
      }
      for (const k of mine) mirrorStep(M, k, ctx);
      if (M.activatedAt === null && M.candlesProcessed > 0 && activate(M, nowMs)) {
        this.audit({ type: "mirror_activated", account_id: M.accountId, activated_at: M.activatedAt, warmup_candles: M.candlesProcessed, warmup_trades: M.recordedTrades });
        this.log(`[engine] mirror activated at ${M.activatedAt} after ${M.candlesProcessed} warm-up candle(s); later candles are live observations`);
      }
      M.lastError = null;
    } catch (e) {
      M.lastError = { at: iso(nowMs), where: "mirror", message: String(e.message ?? e).slice(0, 240) };
      this.audit({ type: "mirror_error", where: "mirror", message: M.lastError.message });
      this.log(`[engine] mirror error: ${M.lastError.message}`);
    }
    this.saveMirror();
  }

  /** What the Worker stores about this mirror account (no secret, no funded-ledger data). */
  mirrorAccount() {
    const M = this.mirror;
    return {
      account_id: M.accountId, symbol: M.symbol, timeframe: `${M.intervalMin}m`, profile: this.cfg.profile ?? "default", ...this.botFields(),
      strategy: STRATEGY_NAME, inputs_hash: M.inputsHash, engine_version: ENGINE_VERSION,
      engine_release: RELEASE.release, engine_commit: RELEASE.commit,
      created_at: M.createdAt, activated_at: M.activatedAt, last_candle_time: M.lastCandle?.t ?? null,
      last_candle_close: M.lastCandle?.close ?? null, candles_processed: M.candlesProcessed, risk_usd: M.strategy.inputs.riskUSD,
      last_seq: M.seq, pending: M.outbox.filter((x) => x.status === "pending").length,
      refused: M.outbox.filter((x) => x.status === "refused").length,
      open_position: mirrorPosition(M), resets: M.resets.length, interruptions: M.interruptions,
      skipped_candles: M.skippedCandles, last_error: M.lastError,
      observation_gaps: M.observationGaps ?? [], no_trade_intervals: M.noTradeIntervals ?? 0,
    };
  }

  /**
   * Delivers mirror records in sequence order (idempotent on the Worker by trade id and sequence). A network failure,
   * timeout or 5xx leaves them pending for the next poll; a record the Worker refuses (conflict, invalid) is kept and
   * reported as a divergence, never dropped silently. Independent of the funded outbox.
   */
  async flushMirror() {
    const M = this.mirror;
    if (!M || !this.cfg.sync) return;
    const due = M.outbox.some((x) => x.status === "pending") || !M.lastSent || M.lastSent.candle !== (M.lastCandle?.t ?? null)
      || this.now() - Date.parse(M.lastSent.at) >= MIRROR_HEARTBEAT_MS;
    if (!due) return;
    for (let round = 0; round < 40; round++) {
      const batch = M.outbox.filter((x) => x.status === "pending").slice(0, MIRROR_BATCH);
      let status = 0, body = {};
      try {
        const r = await this.http(`${this.cfg.apiBase}/webhook/engine-mirror`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({ secret: this.cfg.webhookSecret, account: this.mirrorAccount(), items: batch.map(({ status: _s, attempts: _a, refused_code: _c, refused_reason: _r, ...x }) => x) }),
        });
        status = r.status;
        body = await r.json().catch(() => ({}));
      } catch (e) {
        for (const it of batch) it.attempts += 1;
        M.lastError = { at: iso(this.now()), where: "mirror-sync", message: String(e.message ?? e).slice(0, 240) };
        break;
      }
      if (status !== 200 || body.ok !== true) {
        for (const it of batch) it.attempts += 1;
        M.lastError = { at: iso(this.now()), where: "mirror-sync", message: `${body.code ?? `HTTP_${status}`} ${body.message ?? ""}`.trim().slice(0, 240) };
        break;
      }
      const results = new Map((Array.isArray(body.results) ? body.results : []).map((x) => [x.seq, x]));
      let done = 0;
      for (const it of batch) {
        const res = results.get(it.seq);
        if (!res) continue; // not acknowledged: stays pending
        if (res.status === "stored" || res.status === "duplicate") {
          it.status = "delivered";
          M.delivered += 1;
          M.lastDeliveredSeq = Math.max(M.lastDeliveredSeq, it.seq);
          done += 1;
        } else {
          // Kept with the Worker's answer under separate names (the record's own fields stay untouched).
          Object.assign(it, { status: "refused", refused_code: String(res.code ?? "REFUSED"), refused_reason: String(res.message ?? "").slice(0, 240) });
          this.audit({ type: "mirror_divergence", seq: it.seq, id: it.trade_id ?? it.event_id, code: it.refused_code, reason: it.refused_reason });
          this.log(`[engine] mirror record ${it.seq} refused by ALPHA TERMINAL (${it.refused_code}): ${it.refused_reason}`);
        }
      }
      M.health = body.account && typeof body.account === "object" ? { ...body.account, at: iso(this.now()) } : null;
      M.lastError = null;
      M.lastSent = { at: iso(this.now()), candle: M.lastCandle?.t ?? null };
      M.outbox = M.outbox.filter((x) => x.status !== "delivered");
      const refused = M.outbox.filter((x) => x.status === "refused");
      if (refused.length > 50) M.outbox = M.outbox.filter((x) => x.status !== "refused" || refused.slice(-50).includes(x));
      if (done < batch.length || !M.outbox.some((x) => x.status === "pending")) break;
    }
    this.saveMirror();
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

  audit(record) {
    if (!this.auditFile) return;
    try {
      appendFileSync(this.auditFile, `${JSON.stringify({ at: iso(this.now()), ...record })}\n`);
    } catch (e) {
      this.log(`[engine] audit write failed: ${e.message ?? e}`);
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  fresh(reason) {
    // A website risk setting the engine already confirmed survives a re-warm (it applies to new entries only).
    const keepSettings = this.state?.settings ?? null;
    this.state = {
      version: ENGINE_VERSION, inputsHash: inputsHash(this.cfg), startedAt: iso(this.now()), warmedUpAt: null, resets: [],
      // cfg.pivotTies: test-only override (not read from the environment); default = TradingView's rule.
      strategy: createState({ symbol: this.cfg.symbol, timeframeMin: this.cfg.intervalMin, inputs: this.cfg.inputs, pivotTies: this.cfg.pivotTies, sizing: this.cfg.sizing }),
      outbox: [], openEntryId: null, ledgerCheck: null, lastPollAt: null, lastError: null, candlesProcessed: 0, lastCandle: null,
    };
    if (reason) this.state.resets.push({ at: iso(this.now()), reason });
    if (keepSettings) {
      this.state.settings = keepSettings;
      this.state.strategy.inputs.riskUSD = keepSettings.riskUSD;
    }
  }

  /**
   * Website risk setting (ENGINE_REMOTE_SETTINGS=on only). A new version from ALPHA TERMINAL replaces the risk per
   * trade for orders placed from now on; an open position keeps its size and plan. Saved before it is confirmed,
   * and confirmed in the next status update, so the dashboard shows Applied only after the engine really uses it.
   */
  applySettings(next) {
    const S = this.state;
    if (this.cfg.ledgerApi === "bot") return this.applyBotRisk(next);
    if (!this.cfg.remoteSettings || !S || !next || typeof next !== "object") return false;
    const { version, risk_usd: risk } = next;
    if (!Number.isInteger(version) || typeof risk !== "number" || !Number.isFinite(risk) || risk < 1 || risk > 1_000_000) return false;
    if (S.settings && S.settings.version === version && S.settings.riskUSD === risk) return false;
    const previous = S.strategy.inputs.riskUSD;
    S.settings = { version, riskUSD: risk, appliedAt: iso(this.now()) };
    S.strategy.inputs.riskUSD = risk;
    // The mirror follows the strategy's risk input too (new entries only); each mirror trade records its own risk.
    if (this.mirror) { this.mirror.strategy.inputs.riskUSD = risk; this.saveMirror(); }
    this.save();
    this.audit({ type: "settings_applied", version, risk_usd: risk, previous_risk_usd: previous, open_position: !!S.strategy.broker.pos });
    this.log(`[engine] risk per trade ${previous} -> ${risk} (website version ${version}); new entries only`);
    return true;
  }

  /**
   * A fleet bot's dollar risk per trade, set on the website for THIS bot only (versioned, confirmed back). It changes the
   * funded sizing for new orders only; the Strategy Mirror keeps its $10 reference risk; open positions are untouched.
   */
  applyBotRisk(next) {
    const S = this.state;
    if (!S || !next || typeof next !== "object" || next.bot_id !== this.cfg.botId) return false;
    const { version, risk_usd: risk } = next;
    if (!Number.isInteger(version) || typeof risk !== "number" || !Number.isFinite(risk) || risk < 0.01 || risk > 1_000_000) return false;
    if (S.botRisk && S.botRisk.version === version && S.botRisk.riskUSD === risk) return false;
    const previous = S.botRisk?.riskUSD ?? this.cfg.sizing?.riskUSD ?? null;
    S.botRisk = { version, riskUSD: risk, appliedAt: iso(this.now()) };
    this.save();
    this.audit({ type: "bot_risk_applied", bot_id: this.cfg.botId, version, risk_usd: risk, previous_risk_usd: previous, open_position: !!S.strategy.broker.pos });
    this.log(`[engine] ${this.cfg.botId} dollar risk per trade ${previous} -> ${risk} (website version ${version}); new orders only`);
    return true;
  }

  /**
   * Sizing settings come from the engine config (a saved state from an older engine gets them here too). In percent
   * mode the strategy sizes from the strategy's AVAILABLE ALPHA PAPER balance, read from the Worker's read-only ledger
   * view (the latest reading, refreshed after every poll); without sync, from ENGINE_PAPER_CAPITAL plus the engine's
   * own simulated results. Unknown stays unknown: orders are then skipped (BALANCE_UNKNOWN), never guessed.
   */
  async prepareSizing() {
    const st = this.state.strategy;
    const { maxRisk, fixedReason: _f, ...cfgSizing } = this.cfg.sizing ?? {};
    st.sizing = { ...DEFAULT_SIZING, ...st.sizing, ...cfgSizing };
    // Maximum risk per trade: the strategy's risk setting (the website's, confirmed back) unless configured otherwise.
    st.sizing.maxRiskUSD = maxRisk === "off" ? null : typeof maxRisk === "number" ? maxRisk : st.inputs.riskUSD;
    // dollar mode: the bot's own dollar risk, the website's confirmed per-bot setting when there is one.
    if (st.sizing.mode === "dollar") st.sizing.riskUSD = this.state.botRisk?.riskUSD ?? cfgSizing.riskUSD;
    // Execution rule for resting limit orders (config; 0 = the default emulator rule, unchanged).
    if (this.cfg.limitThroughTicks > 0) st.broker.opts = { ...(st.broker.opts ?? {}), limitThroughTicks: this.cfg.limitThroughTicks, tick: st.sym.mintick };
    else if (st.broker.opts?.limitThroughTicks) { const { limitThroughTicks: _l, tick: _t, ...rest } = st.broker.opts; st.broker.opts = rest; }
    if (st.sizing.mode !== "percent" && st.sizing.mode !== "dollar") return;
    if (!this.cfg.sync) {
      st.capital = this.cfg.localCapital === null ? null : this.cfg.localCapital + st.broker.netProfit;
      return;
    }
    if (this.balance === undefined) {
      try { this.balance = (await this.ledger([])).balance; } catch { this.balance = null; }
    }
    // A fleet bot sizes from what the ledger leaves for IT (its allocation cap, Workers with migration 0007), minus the
    // other bots' resting entries on the same wallet (capital book). A single engine: the wallet's available balance.
    const raw = this.balance && Number.isFinite(this.balance.bot_available_usd) ? this.balance.bot_available_usd
      : this.balance && Number.isFinite(this.balance.available_usd) ? this.balance.available_usd : null;
    st.capital = this.capitalBook && this.cfg.botId ? this.capitalBook.capitalFor(this.cfg.botId, raw) : raw;
    st.maxNotional = this.balance?.max_order_notional_usd ?? null;
    // The Worker's other risk limits and the account's current exposure (Workers from the universal-sizing release on).
    const b = this.balance ?? {};
    st.sizing.limits = { maxOrderNotional: st.maxNotional, maxPositionExposure: b.max_position_exposure_usd ?? null, maxTotalExposure: b.max_total_exposure_usd ?? null, maxOpenPositions: b.max_open_positions ?? null };
    st.sizing.exposure = { position: b.position_exposure_usd ?? 0, total: b.total_exposure_usd ?? 0, openPositions: b.open_positions ?? 0 };
  }

  /**
   * Mirror-only market (ENGINE_FUNDED=off): fetch this market's completed candles, feed the Strategy Mirror, deliver.
   * No funded state, no signal to the PAPER ledger, no ledger check, no engine status, no website settings. A market
   * data failure is recorded and reported; it never throws, so other markets in the same process carry on.
   */
  async tickMirrorOnly() {
    const nowMs = this.now();
    let candles;
    try {
      candles = await this.fetchCandles({ symbol: this.cfg.symbol, intervalMin: this.cfg.intervalMin, sinceMs: this.mirror ? this.mirror.strategy.lastTime : null, base: this.cfg.krakenBase, nowMs });
    } catch (e) {
      const message = String(e.message ?? e).slice(0, 240);
      this.log(`[engine] ${this.cfg.symbol} candle fetch failed: ${message}`);
      this.audit({ type: "error", where: "market-data", message });
      if (this.mirror) {
        this.mirror.lastError = { at: iso(nowMs), where: "market-data", message };
        this.saveMirror();
        await this.flushMirror();
      }
      return { processed: 0, error: { where: "market-data", message } };
    }
    const before = this.mirror ? this.mirror.candlesProcessed : 0;
    this.stepMirror(candles, nowMs);
    const processed = this.mirror.candlesProcessed - before;
    if (processed) this.log(`[engine] ${this.cfg.symbol} mirror processed ${processed} candle(s) up to ${this.mirror.lastCandle?.t}; status: ${this.mirror.strategy.status}`);
    await this.flushMirror();
    return { processed };
  }

  /** One poll: process every new completed candle, then sync. Safe to call at any time. */
  async tick() {
    if (this.cfg.funded === false) return this.tickMirrorOnly();
    const nowMs = this.now();
    if (!this.state) this.fresh();
    const S = this.state;
    await this.prepareSizing();
    // The first batch after a (re)start from scratch is warm-up history: processed, never sent.
    const warmup = S.warmedUpAt === null;
    let candles, all;
    // With the mirror on, fetch from whichever track is further behind (a new mirror warms up on Kraken's history);
    // the funded track still processes only the candles after its own last one, exactly as without the mirror.
    const mirrorLast = this.cfg.mirror ? (this.mirror ? this.mirror.strategy.lastTime : null) : undefined;
    const sinceMs = mirrorLast === undefined ? S.strategy.lastTime
      : mirrorLast === null || S.strategy.lastTime === null ? null : Math.min(mirrorLast, S.strategy.lastTime);
    try {
      all = await this.fetchCandles({ symbol: this.cfg.symbol, intervalMin: this.cfg.intervalMin, sinceMs, base: this.cfg.krakenBase, nowMs });
      candles = all.filter((k) => S.strategy.lastTime === null || k.t > S.strategy.lastTime);
    } catch (e) {
      S.lastError = { at: iso(nowMs), where: "market-data", message: String(e.message ?? e) };
      this.log(`[engine] candle fetch failed: ${S.lastError.message}`);
      this.audit({ type: "error", where: "market-data", message: S.lastError.message });
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
      // If the ledger holds a position the engine is about to forget, close it (at the live price) so the two
      // cannot drift apart. Recorded as a reconciliation, not as a strategy exit.
      const open = S.openEntryId ? outbox.find((x) => x.id === S.openEntryId) : null;
      if (open && (open.status === "accepted" || open.status === "pending")) {
        outbox.push({
          id: `${this.idPrefix}-${iso(nowMs - (nowMs % this.step))}-RESYNC-CLOSE`, action: "CLOSE", kind: "EXIT",
          entryId: open.id, qty: null, enginePrice: null, exitKind: "RECONCILE_AFTER_DATA_GAP",
          barTime: iso(nowMs - (nowMs % this.step)), barClose: iso(nowMs), createdAt: iso(nowMs), status: "pending", code: null, reason: null, attempts: 0,
        });
      }
      this.audit({ type: "reset", reason: `gap of ${missing} candles after ${iso(S.strategy.lastTime)}`, reconcile_close: outbox.at(-1)?.exitKind === "RECONCILE_AFTER_DATA_GAP" ? outbox.at(-1).id : null });
      this.fresh(`gap of ${missing} candles after ${iso(S.strategy.lastTime)}`);
      this.state.outbox = outbox;
      this.state.resets = [...resets, ...this.state.resets].slice(-20);
      await this.flush();
      return this.tick();
    }

    let processed = 0;
    for (const k of candles) {
      const events = onBar(S.strategy, k);
      this.audit({
        type: "candle", t: iso(k.t), o: k.o, h: k.h, l: k.l, c: k.c, n: k.n ?? null, warmup,
        status: S.strategy.status, events: events.map(({ bar: _b, ...e }) => e),
      });
      processed += 1;
      S.candlesProcessed += 1;
      S.lastCandle = { t: iso(k.t), close: k.c };
      const closeMs = k.t + this.step;
      // The trade's recorded reasoning (src/tradeplan.mjs): updated from this candle's strategy events before any order.
      S.plan ??= newPlanState();
      updatePlan(S.plan, events, { at: iso(closeMs), profile: this.cfg.profile ?? "default", inputsHash: inputsHash(this.cfg), inputs: S.strategy.inputs });
      const late = nowMs - closeMs > this.cfg.lateBars * this.step;
      for (const e of events) {
        if (e.type !== "ENTRY_FILL" && e.type !== "EXIT_FILL") continue;
        const isExit = e.type === "EXIT_FILL";
        // Fleet bots (ledger path "bot"): explicit OPEN_LONG / OPEN_SHORT / CLOSE (the bot's own position only).
        const botPath = this.cfg.ledgerApi === "bot";
        const action = isExit ? "CLOSE" : botPath ? (e.side === 1 ? "OPEN_LONG" : "OPEN_SHORT") : e.side === 1 ? "BUY" : "SELL";
        const id = `${this.idPrefix}-${iso(k.t)}-${action}`;
        const entryId = isExit ? S.openEntryId : null;
        if (isExit) S.openEntryId = null; else S.openEntryId = id;
        if (S.outbox.some((x) => x.id === id)) continue;
        S.outbox.push({
          id, action, kind: isExit ? "EXIT" : "ENTRY", entryId, qty: isExit ? null : fmtQty(e.qty), enginePrice: e.price,
          exitKind: e.kind ?? null, barTime: iso(k.t), barClose: iso(closeMs), createdAt: iso(nowMs),
          ...(botPath && !isExit ? { stop: S.strategy.curStop ?? S.strategy.planSL ?? null, tp: S.strategy.planTP2 ?? null, riskUSD: S.strategy.sizing?.riskUSD ?? null } : {}),
          // Why: the entry carries its recorded plan; the exit carries the strategy's own exit reason and stop path.
          ...(isExit ? { exit: exitRecord(S.plan, e) } : { plan: S.plan.active ? JSON.parse(JSON.stringify(S.plan.active)) : null }),
          // Exits are never dropped for lateness here: whether they go out depends on their entry (see flush).
          status: warmup ? "historical" : late && !isExit ? "skipped" : "pending",
          code: !warmup && late && !isExit ? "SIGNAL_EXPIRED" : null,
          reason: warmup ? "warm-up history" : late && !isExit ? `candle closed ${Math.round((nowMs - closeMs) / 60_000)} min ago; not sent so it cannot fill at a later price` : null,
          attempts: 0,
        });
        // A live entry too old to send never reaches the PAPER portfolio: drop it like a refused one.
        const added = S.outbox[S.outbox.length - 1];
        if (added.kind === "ENTRY" && added.status === "skipped") {
          this.audit({ type: "signal", id: added.id, action: added.action, status: added.status, code: added.code, reason: added.reason, attempts: 0, delayed_min: null });
          this.dropRefusedEntry(added);
        }
      }
    }
    if (this.cfg.mirror) this.stepMirror(all, nowMs);
    if (warmup) S.warmedUpAt = iso(nowMs);
    this.trimOutbox();
    S.lastError = null;
    this.save();
    if (processed) this.log(`[engine] processed ${processed} candle(s) up to ${S.lastCandle.t}; status: ${S.strategy.status}`);
    await this.flush();
    if (this.cfg.mirror) await this.flushMirror();
    if (S.lastError) this.audit({ type: "error", ...S.lastError, at: undefined, error_at: S.lastError.at });
    await this.verifyLedger();
    await this.heartbeat();
    return { processed };
  }

  /** Keeps the outbox bounded without dropping an entry that an unfinished exit still refers to. */
  trimOutbox(max = 300) {
    const box = this.state.outbox;
    if (box.length <= max) return;
    const needed = new Set(box.filter((x) => !FINAL.has(x.status) && x.entryId).map((x) => x.entryId));
    if (this.state.openEntryId) needed.add(this.state.openEntryId);
    const drop = box.length - max;
    let dropped = 0;
    this.state.outbox = box.filter((x) => {
      if (dropped < drop && FINAL.has(x.status) && !needed.has(x.id)) { dropped += 1; return false; }
      return true;
    });
  }

  /** The bot identity sent with every request of a fleet bot ({} for the single engine: payloads unchanged). */
  botFields() {
    return this.cfg.botId ? { bot_id: this.cfg.botId, ...(this.cfg.botName ? { bot_name: this.cfg.botName } : {}) } : {};
  }

  /** Read-only view of the ALPHA PAPER ledger: the open position for this symbol and the outcome of given signals. */
  async ledger(alertIds = []) {
    const r = await this.http(`${this.cfg.apiBase}${this.cfg.ledgerApi === "bot" ? "/webhook/bot-ledger" : "/webhook/engine-ledger"}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ secret: this.cfg.webhookSecret, symbol: this.cfg.symbol, alert_ids: alertIds, ...this.botFields() }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status !== 200 || body.ok !== true) throw new Error(`ledger query ${body.code ?? `HTTP ${r.status}`}`);
    // balance: the strategy's ALPHA PAPER balance (Workers from the small-account release on; older ones omit it).
    const b = body.balance && typeof body.balance === "object" ? body.balance : null;
    return {
      position: body.position ?? null, alerts: body.alerts ?? {},
      balance: b && typeof b.available_usd === "number" ? {
        available_usd: b.available_usd, reserved_usd: Number(b.reserved_usd ?? 0), active: b.active === true,
        max_order_notional_usd: typeof b.max_order_notional_usd === "number" ? b.max_order_notional_usd : null,
        ...Object.fromEntries(["max_position_exposure_usd", "max_total_exposure_usd", "max_open_positions", "position_exposure_usd", "total_exposure_usd", "open_positions",
          "bot_available_usd", "bot_reserved_usd", "bot_allocation_cap_usd"]
          .map((k) => [k, typeof b[k] === "number" && Number.isFinite(b[k]) ? b[k] : null])),
      } : null,
    };
  }

  final(item, status, code, reason) {
    Object.assign(item, { status, code, reason: reason ? String(reason).slice(0, 240) : null });
    this.audit({ type: "signal", id: item.id, action: item.action, status, code, reason: item.reason, attempts: item.attempts, delayed_min: item.delayedMin ?? null });
    if (item.kind === "ENTRY" && (status === "rejected" || status === "skipped")) this.dropRefusedEntry(item);
    this.save();
  }

  /**
   * The PAPER portfolio did not take this entry (refused, or expired unsent): drop the engine's simulated position
   * so both sides stay flat. Only the position opened by this very entry is dropped, at most once.
   */
  dropRefusedEntry(item) {
    const S = this.state;
    if (S.openEntryId !== item.id) return false;
    S.openEntryId = null;
    const pos = abandonPosition(S.strategy);
    if (!pos) return false;
    item.positionDropped = true;
    S.refusedEntries = (S.refusedEntries ?? 0) + 1;
    this.audit({ type: "entry_dropped", id: item.id, code: item.code, side: pos.side === 1 ? "LONG" : "SHORT", qty: pos.qty, engine_price: pos.avg,
      reason: "not in the ALPHA PAPER ledger; engine position dropped without an exit (no trade, no P&L)" });
    this.log(`[engine] ${item.action} ${item.id} ${item.status} (${item.code}); engine position dropped, waiting for the next setup`);
    return true;
  }

  /**
   * Sends pending outbox items in order and records each result. Stops at the first retryable failure so
   * BUY/CLOSE ordering is kept.
   */
  async flush() {
    if (!this.cfg.sync) return;
    const box = this.state.outbox;
    const maxAgeMs = this.cfg.lateBars * this.step;
    for (const item of box) {
      if (item.status !== "pending") continue;
      const ageMs = this.now() - Date.parse(item.barClose);

      if (item.kind === "EXIT") {
        const entry = item.entryId ? box.find((x) => x.id === item.entryId) : null;
        if (!entry || entry.status !== "accepted") {
          if (entry && entry.status === "pending") return; // still being delivered; keep order
          this.final(item, "skipped", "ENTRY_NOT_IN_LEDGER", entry
            ? `entry ${entry.action} was ${entry.status}${entry.code ? ` (${entry.code})` : ""}; nothing to close in the ALPHA PAPER ledger`
            : "no matching entry; nothing to close in the ALPHA PAPER ledger");
          continue;
        }
        if (box.some((x) => x !== item && x.kind === "EXIT" && x.entryId === entry.id && x.status === "accepted")) {
          this.final(item, "skipped", "ALREADY_CLOSED", `${entry.id} was already closed by another signal`);
          continue;
        }
        // Close only what the ledger really holds for this entry (and learn the outcome of an earlier attempt).
        let L;
        try { L = await this.ledger([entry.id, item.id]); } catch (e) {
          this.state.lastError = { at: iso(this.now()), where: "ledger", message: `${item.id}: ${e.message ?? e}` };
          this.save();
          return;
        }
        const prior = L.alerts[item.id];
        if (prior?.response_code === "DRY_RUN_ACCEPTED") { this.final(item, "accepted", "DRY_RUN_ACCEPTED", "confirmed in the ledger (earlier attempt)"); continue; }
        if (prior?.status === "processing") return;
        if (!L.position || L.position.open_alert_id !== entry.id) {
          this.final(item, "skipped", "LEDGER_NOT_HOLDING_ENTRY", L.position
            ? `the ledger's open ${this.cfg.symbol} position was opened by ${L.position.open_alert_id}, not ${entry.id}; not closed`
            : `the ledger has no open ${this.cfg.symbol} position for ${entry.id}; not closed`);
          continue;
        }
        if (ageMs > maxAgeMs) item.delayedMin = Math.round(ageMs / 60_000);
      } else if (ageMs > maxAgeMs) {
        // Too old to enter at today's price. If an earlier attempt may have arrived, adopt its real outcome.
        if (item.attempts > 0) {
          let L;
          try { L = await this.ledger([item.id]); } catch (e) {
            this.state.lastError = { at: iso(this.now()), where: "ledger", message: `${item.id}: ${e.message ?? e}` };
            this.save();
            return;
          }
          const prior = L.alerts[item.id];
          if (prior?.response_code === "DRY_RUN_ACCEPTED") { this.final(item, "accepted", "DRY_RUN_ACCEPTED", "confirmed in the ledger (earlier attempt)"); continue; }
          if (prior?.status === "rejected") { this.final(item, "rejected", prior.response_code ?? "REJECTED", prior.rejection_reason); continue; }
          if (prior?.status === "processing") return;
        }
        this.final(item, "skipped", "SIGNAL_EXPIRED", `not delivered within ${this.cfg.lateBars * this.cfg.intervalMin} min of the candle close (${Math.round(ageMs / 60_000)} min); not sent so it cannot fill at a later price`);
        continue;
      }

      item.attempts += 1;
      let status = 0, body = {};
      try {
        const r = await this.http(`${this.cfg.apiBase}${this.cfg.ledgerApi === "bot" ? "/webhook/bot-order" : "/webhook/dry-run"}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
          body: JSON.stringify(this.cfg.ledgerApi === "bot" ? {
            secret: this.cfg.webhookSecret, bot_id: this.cfg.botId, order_id: item.id, action: item.action, symbol: this.cfg.symbol,
            timeframe: String(this.cfg.intervalMin), ...(item.qty === null ? {} : { qty: Number(item.qty) }), timestamp: item.barClose,
            liquidity: this.liquidityFor(item), stop: item.stop ?? null, tp: item.tp ?? null, risk_usd: item.riskUSD ?? null,
            profile: this.cfg.profile, config_hash: inputsHash(this.cfg), entry_order_id: item.entryId ?? null,
            ...(item.plan ? { plan: item.plan } : {}), ...(item.exit ? { exit: item.exit } : {}),
          } : {
            secret: this.cfg.webhookSecret, id: item.id, symbol: this.cfg.symbol, timeframe: String(this.cfg.intervalMin),
            action: item.action, strategy: STRATEGY_NAME, ...(item.qty === null ? {} : { qty: Number(item.qty) }), timestamp: item.barClose,
            liquidity: this.liquidityFor(item), ...this.botFields(),
            ...(item.plan ? { plan: item.plan } : {}), ...(item.exit ? { exit: item.exit } : {}),
          }),
        });
        status = r.status;
        body = await r.json().catch(() => ({}));
      } catch (e) {
        this.state.lastError = { at: iso(this.now()), where: "sync", message: `${item.id}: ${e.message ?? e}` };
        this.save();
        return;
      }
      item.lastAttemptAt = iso(this.now());
      const code = body.code ?? `HTTP_${status}`;
      const delayed = item.delayedMin ? `delivered ${item.delayedMin} min after the engine's exit; the ledger closed at the live price` : null;
      if (status === 200 && code === "DRY_RUN_ACCEPTED") {
        // Bot ledger: the quantity actually filled (it may be reduced to fit the bot's wallet at the live price).
        if (this.cfg.ledgerApi === "bot" && Number.isFinite(Number(body.data?.qty)) && item.qty !== null && Number(body.data.qty) !== Number(item.qty)) {
          item.filledQty = Number(body.data.qty);
        }
        this.final(item, "accepted", code, body.data?.reduced_to_fit ? `filled ${body.data.qty} of ${item.qty} requested: reduced to fit the bot's wallet at the fill price` : delayed);
      } else if (status === 200 && code === "DUPLICATE") {
        // Already processed earlier (e.g. crash before saving): adopt that earlier result.
        const orig = body.data ?? {};
        if (orig.original_code === "DRY_RUN_ACCEPTED") this.final(item, "accepted", "DRY_RUN_ACCEPTED", "confirmed as a duplicate of the accepted signal");
        else if (orig.original_status === "rejected") this.final(item, "rejected", orig.original_code ?? "REJECTED", "rejected earlier (confirmed as a duplicate)");
        else {
          this.state.lastError = { at: iso(this.now()), where: "sync", message: `${item.id}: earlier attempt still ${orig.original_status ?? "unknown"}` };
          this.save();
          return;
        }
      } else if (status === 400 || status === 422) {
        this.final(item, "rejected", code, body.message ?? null);
      } else {
        // 401 (secret), 5xx (nothing committed; retryable): keep it pending and stop here.
        item.code = code;
        this.state.lastError = { at: iso(this.now()), where: "sync", message: `${item.id}: ${code} ${body.message ?? ""}`.trim() };
        this.save();
        return;
      }
    }
  }

  /** Compares the engine's position with what the ALPHA PAPER ledger in D1 actually holds. Reports, never fixes. */
  async verifyLedger() {
    if (!this.cfg.sync) return;
    const S = this.state;
    const pos = S.strategy.broker.pos;
    const entry = pos && S.openEntryId ? S.outbox.find((x) => x.id === S.openEntryId) : null;
    const at = iso(this.now());
    let L;
    try { L = await this.ledger(entry ? [entry.id] : []); } catch (e) {
      S.ledgerCheck = { status: "UNVERIFIED", at, issues: [`ledger query failed: ${e.message ?? e}`], ledger_position: null };
      this.save();
      return;
    }
    this.balance = L.balance; // the next poll sizes from this reading
    const lp = L.position;
    const issues = [];
    if (entry && entry.status === "accepted") {
      if (!lp) issues.push(`the ledger has no open ${this.cfg.symbol} position; the engine holds ${pos.side === 1 ? "LONG" : "SHORT"} ${fmtQty(pos.qty)} from ${entry.id}`);
      else {
        if (lp.open_alert_id !== entry.id) issues.push(`the ledger position was opened by ${lp.open_alert_id}, not ${entry.id}`);
        if (Math.abs(Number(lp.qty) - Number(entry.filledQty ?? entry.qty)) > 1e-8) issues.push(`ledger qty ${lp.qty} vs engine ${entry.filledQty ?? entry.qty}`);
        if (lp.status !== "OPEN") issues.push(`ledger position status ${lp.status}`);
        if ((pos.side === 1 ? "long" : "short") !== lp.side) issues.push(`ledger side ${lp.side} vs engine ${pos.side === 1 ? "long" : "short"}`);
      }
    } else if (lp && String(lp.open_alert_id).startsWith(`${this.idPrefix}-`)) {
      issues.push(`the ledger holds an engine-opened ${this.cfg.symbol} position (${lp.open_alert_id}, qty ${lp.qty}) that the engine does not hold`);
    }
    S.ledgerCheck = {
      status: issues.length ? "DIVERGED" : "OK", at, issues: issues.slice(0, 5),
      ledger_position: lp ? { qty: Number(lp.qty), side: lp.side, open_alert_id: lp.open_alert_id } : null,
    };
    if (issues.length) this.log(`[engine] ledger reconciliation warning: ${issues.join("; ")}`);
    const key = JSON.stringify([S.ledgerCheck.status, S.ledgerCheck.issues]);
    if (key !== this.lastLedgerKey) {
      this.lastLedgerKey = key;
      this.audit({ type: "ledger_check", status: S.ledgerCheck.status, issues: S.ledgerCheck.issues, ledger_position: S.ledgerCheck.ledger_position });
    }
    this.save();
  }

  /** Whether the engine's open position is in the ALPHA PAPER ledger, verified against D1, and if not, why. */
  ledgerLink() {
    const S = this.state;
    if (!S.strategy.broker.pos) return null;
    const entry = S.openEntryId ? S.outbox.find((x) => x.id === S.openEntryId) : null;
    if (!entry) return { status: "NOT_IN_LEDGER", reason: "no entry signal recorded" };
    if (entry.status === "pending") return { status: "PENDING", reason: entry.code ? `retrying (${entry.code})` : "waiting to sync" };
    if (entry.status !== "accepted") return { status: "NOT_IN_LEDGER", reason: `${entry.action} ${entry.status}${entry.code ? `: ${entry.code}` : ""}` };
    const chk = S.ledgerCheck;
    if (!chk || chk.status === "UNVERIFIED") return { status: "UNVERIFIED", reason: chk?.issues?.[0] ?? "not checked against the ledger yet" };
    if (chk.status === "DIVERGED") return { status: "DIVERGED", reason: chk.issues[0] };
    return { status: "MIRRORED", reason: null };
  }

  /** Status shown on the dashboard. Engine-side numbers only; ALPHA PAPER ledger figures stay separate. */
  statusPayload() {
    const S = this.state;
    const st = S.strategy;
    const pos = st.broker.pos;
    const lastClose = S.lastCandle?.close ?? null;
    const sum = summarize(st);
    return {
      engine: "alpha-engine", version: ENGINE_VERSION, mode: "PAPER", symbol: this.cfg.symbol, timeframe: `${this.cfg.intervalMin}m`, ...this.botFields(),
      strategy: STRATEGY_NAME, started_at: S.startedAt, warmed_up_at: S.warmedUpAt, last_poll_at: S.lastPollAt,
      last_candle_time: S.lastCandle?.t ?? null, last_candle_close: lastClose, candles_processed: S.candlesProcessed,
      status_text: st.status, sync: this.cfg.sync,
      // Structured strategy state (never reconstructed from status text): setup, resting order and its levels.
      strategy_state: {
        direction: st.dir === 1 ? "LONG" : st.dir === -1 ? "SHORT" : null, leg_start: st.dir ? st.legStart : null, leg_end: st.dir ? st.legEnd : null,
        setup_bars: st.dir && Number.isFinite(st.legEndBar) ? st.bar - st.legEndBar : null, max_age_bars: st.inputs.maxAge,
        pending_order: st.broker.entry ? { side: st.broker.entry.side === 1 ? "LONG" : "SHORT", qty: st.broker.entry.qty, limit: st.broker.entry.limit, stop: st.planSL ?? null, tp: st.planTP2 ?? null,
          score: st.planScore ?? null, confluence: typeof st.planTags === "string" && st.planTags.trim() ? st.planTags.trim().split(/\s+/) : [],
          placed_at: S.plan?.pending?.order?.placed_at ?? null, ote_705: S.plan?.pending?.ote_705 ?? null } : null,
        // The open trade's recorded plan (entry reason, initial stop, stop changes) for the chart and the assistant.
        active_plan: st.broker.pos && S.plan?.active ? S.plan.active : null,
        current_stop: st.broker.pos ? st.curStop : null, break_even_done: !!st.beDone, trailing: !!st.trailOn,
      },
      bot_risk: S.botRisk ? { version: S.botRisk.version, risk_usd: S.botRisk.riskUSD } : null,
      profile: this.cfg.profile ?? "default", risk_usd: st.inputs.riskUSD,
      remote_settings: !!this.cfg.remoteSettings,
      settings: S.settings ? { version: S.settings.version, risk_usd: S.settings.riskUSD } : null,
      position: pos ? {
        side: pos.side === 1 ? "LONG" : "SHORT", qty: Number(pos.qty.toFixed(8)), entry: pos.avg,
        stop: st.curStop, tp2: st.tp2P,
        unrealized_at_last_close: lastClose === null ? null : Number(((lastClose - pos.avg) * pos.qty * pos.side).toFixed(2)),
        ledger: this.ledgerLink(),
      } : null,
      trades: { closed: sum.trades, wins: sum.wins, losses: sum.losses, net_pnl: sum.netProfit },
      outbox: Object.fromEntries(["pending", "accepted", "rejected", "skipped", "late"].map((k) => [k, S.outbox.filter((x) => x.status === k).length])),
      ledger_check: S.ledgerCheck ?? null,
      // Live entries the PAPER portfolio did not take; each one's simulated position was dropped (no trade, no P&L).
      refused_entries: S.refusedEntries ?? 0,
      last_rejection: (() => {
        const r = [...S.outbox].reverse().find((x) => x.status === "rejected" || x.status === "skipped");
        return r ? { id: r.id, action: r.action, status: r.status, code: r.code, reason: r.reason } : null;
      })(),
      last_error: S.lastError,
      sizing: this.sizingPayload(),
    };
  }

  /**
   * How a signal's fill took liquidity, for the PAPER cost model: a resting limit order that filled is a MAKER fill
   * (the limit entry, the take-profit); everything else (stop-loss, break-even and trailing stops, time exits,
   * reconciliation closes, market entries) is TAKER.
   */
  liquidityFor(item) {
    if (item.kind === "ENTRY") return (this.state.strategy.inputs.entryMode ?? "").startsWith("Limit") ? "maker" : "taker";
    return item.exitKind === "TP" ? "maker" : "taker";
  }

  /** Sizing shown on the dashboard: the mode, the balance it sizes from, and the latest order decision. */
  sizingPayload() {
    const st = this.state.strategy;
    const z = { ...DEFAULT_SIZING, ...st.sizing };
    const d = st.lastSizing;
    const r2 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
    return {
      mode: z.mode, risk_pct: z.mode === "percent" ? z.riskPct : null, risk_usd_fixed: z.mode === "fixed" ? st.inputs.riskUSD : null, risk_usd: z.mode === "dollar" ? r2(z.riskUSD) : null,
      max_risk_usd: z.mode === "percent" ? r2(z.maxRiskUSD) : null, fixed_reason: z.mode === "percent" ? null : this.cfg.sizing?.fixedReason ?? null,
      symbol: this.cfg.symbol, min_qty: z.instrument?.minQty ?? z.minQty, min_cost: z.instrument?.minNotional ?? z.minCost,
      fee_pct: z.feePct, price_buffer_pct: z.priceBufferPct,
      capital_usd: z.mode === "percent" ? r2(st.capital) : null,
      last: d ? {
        status: d.ok ? "SIZED" : "SKIPPED", code: d.ok ? null : d.code, reason: d.ok ? null : d.reason,
        side: d.side === 1 ? "LONG" : d.side === -1 ? "SHORT" : null,
        entry: r2(d.entry), stop: r2(d.stop), qty: typeof d.qty === "number" ? Number(d.qty.toFixed(8)) : null,
        risk_target_usd: r2(d.riskTarget), risk_actual_usd: r2(d.riskActual), notional_usd: r2(d.notional),
        required_capital_usd: r2(d.requiredCapital), capped: d.capped === true, capped_by: d.cappedBy ?? null, fee_estimate_usd: r2(d.feeEstimate), current: d.bar === st.bar,
        risk_capped_by_max: d.riskCappedByMax === true, spend_limit_usd: r2(d.spendLimit), min_order_cost_usd: r2(d.minOrderCost),
        checks: d.checks ? { min_qty: d.checks.minQty === true, min_cost: d.checks.minCost === true, buying_power: d.checks.buyingPower === true } : null,
        outcome: d.ok ? d.outcome ?? null : null, explanation: typeof d.explanation === "string" ? d.explanation : null,
      } : null,
    };
  }

  /** Audits heartbeat delivery only when it changes (ok → failing → ok), not on every poll. */
  heartbeatState(result) {
    if (result === this.lastHeartbeat) return;
    this.lastHeartbeat = result;
    this.audit({ type: "heartbeat", result });
  }

  async heartbeat(confirming = false) {
    if (!this.cfg.sync || !this.state) return;
    try {
      const r = await this.http(`${this.cfg.apiBase}/webhook/engine-status`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ secret: this.cfg.webhookSecret, status: this.statusPayload() }),
      });
      if (!r.ok) this.log(`[engine] status update rejected: HTTP ${r.status}`);
      this.heartbeatState(r.ok ? "ok" : `HTTP ${r.status}`);
      if (r.ok && (this.cfg.remoteSettings || this.cfg.ledgerApi === "bot")) {
        const body = await r.json().catch(() => null);
        // Applied now → confirm right away (once) so the website can show Applied.
        if (this.applySettings(body?.settings) && !confirming) await this.heartbeat(true);
      }
    } catch (e) {
      this.log(`[engine] status update failed: ${e.message ?? e}`);
      this.heartbeatState(String(e.message ?? e));
    }
  }
}

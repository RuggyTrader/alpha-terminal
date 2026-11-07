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
// * After every poll the engine reads the ledger (read-only) and compares it with its own position; a mismatch is
//   reported as DIVERGED instead of being called mirrored. Nothing is auto-corrected.
// * No broker is contacted anywhere in this engine. ALPHA TERMINAL stays PAPER / DRY RUN.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCompletedCandles } from "./kraken.mjs";
import { createState, onBar, summarize } from "./ote.mjs";

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

export class EngineRunner {
  constructor(cfg, { fetchCandles = fetchCompletedCandles, http = fetch, now = () => Date.now(), log = console.log } = {}) {
    this.cfg = cfg;
    this.fetchCandles = fetchCandles;
    this.http = http;
    this.now = now;
    this.log = log;
    this.step = cfg.intervalMin * 60_000;
    this.file = join(cfg.dataDir, `state-${cfg.symbol}-${cfg.intervalMin}m.json`);
    // Append-only audit trail (one JSON object per line): every processed candle with the strategy's decisions,
    // every signal result, ledger-check changes, errors and resets. Never rewritten; safe to read while running.
    this.auditFile = cfg.audit === false ? null : join(cfg.dataDir, `audit-${cfg.symbol}-${cfg.intervalMin}m.jsonl`);
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
      strategy: createState({ symbol: this.cfg.symbol, timeframeMin: this.cfg.intervalMin, inputs: this.cfg.inputs }),
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
    if (!this.cfg.remoteSettings || !S || !next || typeof next !== "object") return false;
    const { version, risk_usd: risk } = next;
    if (!Number.isInteger(version) || typeof risk !== "number" || !Number.isFinite(risk) || risk < 1 || risk > 1_000_000) return false;
    if (S.settings && S.settings.version === version && S.settings.riskUSD === risk) return false;
    const previous = S.strategy.inputs.riskUSD;
    S.settings = { version, riskUSD: risk, appliedAt: iso(this.now()) };
    S.strategy.inputs.riskUSD = risk;
    this.save();
    this.audit({ type: "settings_applied", version, risk_usd: risk, previous_risk_usd: previous, open_position: !!S.strategy.broker.pos });
    this.log(`[engine] risk per trade ${previous} -> ${risk} (website version ${version}); new entries only`);
    return true;
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
          id: `ENG-${this.cfg.symbol}-${this.cfg.intervalMin}-${iso(nowMs - (nowMs % this.step))}-RESYNC-CLOSE`, action: "CLOSE", kind: "EXIT",
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
      const late = nowMs - closeMs > this.cfg.lateBars * this.step;
      for (const e of events) {
        if (e.type !== "ENTRY_FILL" && e.type !== "EXIT_FILL") continue;
        const isExit = e.type === "EXIT_FILL";
        const action = isExit ? "CLOSE" : e.side === 1 ? "BUY" : "SELL";
        const id = `ENG-${this.cfg.symbol}-${this.cfg.intervalMin}-${iso(k.t)}-${action}`;
        const entryId = isExit ? S.openEntryId : null;
        if (isExit) S.openEntryId = null; else S.openEntryId = id;
        if (S.outbox.some((x) => x.id === id)) continue;
        S.outbox.push({
          id, action, kind: isExit ? "EXIT" : "ENTRY", entryId, qty: isExit ? null : fmtQty(e.qty), enginePrice: e.price,
          exitKind: e.kind ?? null, barTime: iso(k.t), barClose: iso(closeMs), createdAt: iso(nowMs),
          // Exits are never dropped for lateness here: whether they go out depends on their entry (see flush).
          status: warmup ? "historical" : late && !isExit ? "skipped" : "pending",
          code: !warmup && late && !isExit ? "SIGNAL_EXPIRED" : null,
          reason: warmup ? "warm-up history" : late && !isExit ? `candle closed ${Math.round((nowMs - closeMs) / 60_000)} min ago; not sent so it cannot fill at a later price` : null,
          attempts: 0,
        });
      }
    }
    if (warmup) S.warmedUpAt = iso(nowMs);
    this.trimOutbox();
    S.lastError = null;
    this.save();
    if (processed) this.log(`[engine] processed ${processed} candle(s) up to ${S.lastCandle.t}; status: ${S.strategy.status}`);
    await this.flush();
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

  /** Read-only view of the ALPHA PAPER ledger: the open position for this symbol and the outcome of given signals. */
  async ledger(alertIds = []) {
    const r = await this.http(`${this.cfg.apiBase}/webhook/engine-ledger`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ secret: this.cfg.webhookSecret, symbol: this.cfg.symbol, alert_ids: alertIds }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status !== 200 || body.ok !== true) throw new Error(`ledger query ${body.code ?? `HTTP ${r.status}`}`);
    return { position: body.position ?? null, alerts: body.alerts ?? {} };
  }

  final(item, status, code, reason) {
    Object.assign(item, { status, code, reason: reason ? String(reason).slice(0, 240) : null });
    this.save();
    this.audit({ type: "signal", id: item.id, action: item.action, status, code, reason: item.reason, attempts: item.attempts, delayed_min: item.delayedMin ?? null });
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
        this.state.lastError = { at: iso(this.now()), where: "sync", message: `${item.id}: ${e.message ?? e}` };
        this.save();
        return;
      }
      item.lastAttemptAt = iso(this.now());
      const code = body.code ?? `HTTP_${status}`;
      const delayed = item.delayedMin ? `delivered ${item.delayedMin} min after the engine's exit; the ledger closed at the live price` : null;
      if (status === 200 && code === "DRY_RUN_ACCEPTED") {
        this.final(item, "accepted", code, delayed);
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
    const lp = L.position;
    const issues = [];
    if (entry && entry.status === "accepted") {
      if (!lp) issues.push(`the ledger has no open ${this.cfg.symbol} position; the engine holds ${pos.side === 1 ? "LONG" : "SHORT"} ${fmtQty(pos.qty)} from ${entry.id}`);
      else {
        if (lp.open_alert_id !== entry.id) issues.push(`the ledger position was opened by ${lp.open_alert_id}, not ${entry.id}`);
        if (Math.abs(Number(lp.qty) - Number(entry.qty)) > 1e-8) issues.push(`ledger qty ${lp.qty} vs engine ${entry.qty}`);
        if (lp.status !== "OPEN") issues.push(`ledger position status ${lp.status}`);
        if ((pos.side === 1 ? "long" : "short") !== lp.side) issues.push(`ledger side ${lp.side} vs engine ${pos.side === 1 ? "long" : "short"}`);
      }
    } else if (lp && String(lp.open_alert_id).startsWith(`ENG-${this.cfg.symbol}-`)) {
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
      engine: "alpha-engine", version: ENGINE_VERSION, mode: "PAPER", symbol: this.cfg.symbol, timeframe: `${this.cfg.intervalMin}m`,
      strategy: STRATEGY_NAME, started_at: S.startedAt, warmed_up_at: S.warmedUpAt, last_poll_at: S.lastPollAt,
      last_candle_time: S.lastCandle?.t ?? null, last_candle_close: lastClose, candles_processed: S.candlesProcessed,
      status_text: st.status, sync: this.cfg.sync,
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
      last_rejection: (() => {
        const r = [...S.outbox].reverse().find((x) => x.status === "rejected" || x.status === "skipped");
        return r ? { id: r.id, action: r.action, status: r.status, code: r.code, reason: r.reason } : null;
      })(),
      last_error: S.lastError,
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
      if (r.ok && this.cfg.remoteSettings) {
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

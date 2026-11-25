// Isolated Jupiter Perps PAPER engine. One tick:
//   1. market-data ingestion (read-only: Binance substitute 1h candles; Jupiter market-stats; daily on-chain parameters)
//   2. strategy signals (strategies.mjs, pure)                  3. risk and leverage approval (risk.mjs)
//   4. Jupiter-compatible request construction + validation (adapter.mjs)   5./6. entries, closes, stop-loss management
//   7. request (keeper) status monitoring   8. position reconciliation   9. borrow and liquidation monitoring
//  10. persistent records and restart recovery (store.mjs)
// Steps 3-6 and 9 run through the SAME stepHour / ledger as the backtester. PAPER ONLY: no wallet, keys or transactions.
//   node paper-engine.mjs <state dir> [--candidate "A long_flat 1.1"] [--costs conservative]   (default: observation only)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, strategyA, strategyB, sigmaAt, H, DAY } from "./strategies.mjs";
import { newRunState, stepHour } from "./backtest.mjs";
import { identities } from "./ledger.mjs";
import { guardedFetch, buildRequest, buildStopRequest, validateRequest, positionView, fetchMarketStats, fetchBars, LIVE_EXECUTION_ENABLED } from "./adapter.mjs";
import { fetchSnapshot } from "./onchain.mjs";
import { Store } from "./store.mjs";
import { buildFeed, renderHtml } from "./dashboard.mjs";

const SYM = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" };

export class JupiterPaperEngine {
  /**
   * opts: { dir, config, candidate: null | { strategy: "A"|"B", variant, L }, costsName, fetchFn (raw; wrapped by the guard),
   *         now: () => ms, startT (first hour to trade; default: the next hour), readOnlyNetwork = true }
   */
  constructor(opts) {
    if (LIVE_EXECUTION_ENABLED) throw new Error("refusing to start: live execution flag set");
    this.o = opts; this.cfg = opts.config; this.store = new Store(opts.dir); this.fetch = guardedFetch(opts.fetchFn ?? fetch);
    this.barsDir = join(opts.dir, "bars"); mkdirSync(this.barsDir, { recursive: true });
    const costs = this.cfg.costs[opts.costsName ?? "conservative"];
    this.state = this.store.state ?? { schema: 1, configId: this.cfg.id, candidate: opts.candidate ?? null, candidateQualified: opts.candidateQualified ?? false, costsName: opts.costsName ?? "conservative",
      run: newRunState(this.cfg.account.capitalUsd, 7), lastBarT: (opts.startT ?? Math.floor(opts.now() / H) * H) - H, requests: {}, health: { errors: [] }, created: new Date(opts.now()).toISOString() };
    if (this.state.configId !== this.cfg.id) throw new Error(`state belongs to config ${this.state.configId}, not ${this.cfg.id}`);
    this.costs = this.cfg.costs[this.state.costsName];
    this.recovered = this.store.recoveredOrphans;
  }
  rows(a) { const p = join(this.barsDir, `${a}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : []; }
  async ingest() {
    const now = this.o.now(), errors = [];
    for (const a of this.cfg.assets) {
      try {
        const old = this.rows(a), since = old.length ? old.at(-1)[0] + H : Date.parse("2017-08-17T00:00:00Z");
        const fresh = this.o.barsSource ? this.o.barsSource(a, since, now) : await fetchBars(this.fetch, SYM[a], since, now);
        if (fresh.length) writeFileSync(join(this.barsDir, `${a}.json`), JSON.stringify(old.concat(fresh)));
      } catch (e) { errors.push(`bars ${a}: ${e.message}`); }
    }
    let marks = null;
    if (!this.o.offline) {
      try { marks = await fetchMarketStats(this.fetch); } catch (e) { errors.push(`market-stats: ${e.message}`); }
      const day = Math.floor(now / DAY) * DAY;
      if (this.state.health.paramsDay !== day) {
        try { const s = await fetchSnapshot({ fetchFn: this.fetch }); this.state.health.params = { fetchedAt: s.fetchedAt, slot: s.slot, idlSha256: s.idlSha256, borrowHourly: Object.fromEntries(Object.entries(s.custodies).map(([k, v]) => [k, v.hourlyBorrowRate])), feesBps: Object.fromEntries(Object.entries(s.custodies).map(([k, v]) => [k, [v.increaseBps, v.decreaseBps]])), permissions: Object.fromEntries(Object.entries(s.custodies).map(([k, v]) => [k, v.permissions.allowIncreasePosition && v.permissions.allowDecreasePosition])) }; this.state.health.paramsDay = day; }
        catch (e) { errors.push(`on-chain parameters: ${e.message}`); }
      }
    }
    return { marks, errors };
  }
  context(data) {
    const cand = this.state.candidate, cfg = this.cfg;
    const sig = {}, bar = {}, sigma = {};
    for (const a of cfg.assets) {
      const rows = data[a]; bar[a] = new Map(rows.map((r) => [r[0], r]));
      const daily = aggregate(rows, DAY), sb = new Map(daily.map((d) => [d.t, sigmaAt(daily, d.t + DAY, cfg.sizing.volLookbackDays)]));
      sigma[a] = (T) => sb.get(Math.floor(T / DAY) * DAY - DAY) ?? null; // identical lookup to the backtester's sigmaByDay
      if (cand) { const s = cand.strategy === "A" ? strategyA(aggregate(rows, 4 * H), cfg.strategies.A, cand.variant) : strategyB(daily, cfg.strategies.B, cand.variant); sig[a] = new Map(s.map((x) => [x.t, x.signal])); }
    }
    return { assets: cfg.assets, L: cand?.L ?? 1.1, costs: this.costs, config: cfg, shutdownEnabled: true,
      bar: (a, t) => bar[a].get(t), signalAt: (a, T) => (cand ? sig[a].get(T) : undefined), sigmaAt: (a, T) => sigma[a](T) };
  }
  async tick() {
    const st = this.state, S = st.run, tickErrors = [];
    const { marks, errors } = await this.ingest(); tickErrors.push(...errors);
    const data = Object.fromEntries(this.cfg.assets.map((a) => [a, this.rows(a)]));
    const lastClosed = Math.min(...this.cfg.assets.filter((a) => data[a].length).map((a) => data[a].at(-1)[0]));
    const ctx = this.context(data);
    let hours = 0;
    for (let t = st.lastBarT + H; t <= lastClosed; t += H) {
      const before = Object.fromEntries(Object.entries(S.pos).map(([a, p]) => [a, p.stop]));
      const { decided, outcomes } = stepHour(S, ctx, t);
      for (const o of outcomes) { const r = st.requests[o.key]; if (r) { r.status = o.status; r.history.push([o.t, o.status, o.px ?? null]); } this.store.journal("REQUEST_STATUS", o); }
      for (const d of decided) {
        const req = buildRequest(d, { asset: d.asset, refPrice: S.last[d.asset] }), problems = validateRequest(req, { rm: this.cfg.riskManager, positions: S.pos });
        if (problems.length) { delete S.pending[d.asset]; this.store.journal("REQUEST_REJECTED_VALIDATION", { key: d.key, problems }); st.requests[d.key] = { key: d.key, status: "REJECTED_VALIDATION", problems, request: req, history: [[t + H, "REJECTED_VALIDATION"]] }; continue; }
        if (st.requests[d.key]) { this.store.journal("DUPLICATE_IGNORED", { key: d.key }); continue; } // idempotency
        st.requests[d.key] = { key: d.key, status: "PENDING", decidedT: d.decidedT, plan: { type: d.type, side: d.side, sizeUsdDelta: d.sizeUsdDelta, collateralUsdDelta: d.collateralUsdDelta, leverage: d.leverage, target: d.target }, request: req, history: [[t + H, "PENDING"]] };
        this.store.journal("REQUEST", st.requests[d.key]);
      }
      for (const [a, p] of Object.entries(S.pos)) if (p.stop !== before[a]) this.store.journal("TPSL_SET", { asset: a, request: buildStopRequest(a, p) });
      st.lastBarT = t; hours++;
    }
    // reconciliation: ledger identities; every pending ledger request has a live request record; positions vs views
    const id = identities(S, S.last, this.cfg.account.capitalUsd, this.costs);
    const views = Object.entries(S.pos).map(([a, p]) => positionView(a, p, S.last[a], this.costs));
    const pendingOk = Object.values(S.pending).every((rq) => rq.key.startsWith("shutdown|") || ["PENDING", "EXPIRED_RETRYING"].includes(st.requests[rq.key]?.status));
    const recon = { ok: Math.abs(id.ledger_residual) < 1e-6 && Math.abs(id.equity_identity_residual) < 1e-6 && pendingOk && views.length === Object.keys(S.pos).length, ledger_residual: id.ledger_residual, equity_identity_residual: id.equity_identity_residual, pendingOk };
    // health: data freshness, Jupiter mark vs substitute price, borrow-rate drift vs the frozen cost model
    const now = this.o.now(), lag = (now - (lastClosed + H)) / 60_000;
    const lastPx = (a) => S.last[a] ?? data[a].at(-1)?.[4];
    const dev = marks ? Object.fromEntries(this.cfg.assets.map((a) => [a, lastPx(a) ? Math.round((marks[a].priceUsd / lastPx(a) - 1) * 1e4) : null])) : null;
    const p = st.health.params, drift = p ? Object.fromEntries(["BTC", "ETH", "SOL", "USDC"].map((k) => [k, +(p.borrowHourly[k] / this.cfg.costs.base.borrowHourly[k]).toFixed(2)])) : null;
    if (drift && Object.values(drift).some((x) => x > 2)) tickErrors.push("ALERT: on-chain borrow rate is above the conservative assumption (2x)");
    st.health = { ...st.health, lastTickAt: new Date(now).toISOString(), lastBarAt: new Date(lastClosed).toISOString(), dataLagMinutes: lag, hoursProcessedThisTick: hours, jupiterMarkVsSubstituteBps: dev, borrowRateVsBase: drift, recoveredAfterCrash: this.recovered || 0, errors: tickErrors.slice(0, 20), liveExecution: false };
    const feed = buildFeed({ state: st, views, marks, health: st.health, recon, config: this.cfg });
    writeFileSync(join(this.o.dir, "dashboard.json"), JSON.stringify(feed, null, 1)); writeFileSync(join(this.o.dir, "dashboard.html"), renderHtml(feed));
    this.store.journal("TICK", { hours, lastBarT: st.lastBarT, equity: S.eqClose ?? S.cash, recon: recon.ok });
    this.store.commit(st);
    return { hours, feed };
  }
}

if (process.argv[1]?.endsWith("paper-engine.mjs")) {
  const here = dirname(fileURLToPath(import.meta.url)), args = process.argv.slice(2), dir = args[0];
  const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : null; };
  const cfg = JSON.parse(readFileSync(join(here, "config.frozen.json"), "utf8"));
  const cs = opt("--candidate"), candidate = cs ? (([s, v, L]) => ({ strategy: s, variant: v, L: Number(L) }))(cs.split(" ")) : null;
  const eng = new JupiterPaperEngine({ dir, config: cfg, candidate, candidateQualified: false, costsName: opt("--costs") ?? "conservative", now: () => Date.now() });
  const { hours, feed } = await eng.tick();
  console.log(`${new Date().toISOString()} PAPER tick: ${hours} hour(s), status ${feed.status}, equity $${feed.equity.now.toFixed(2)}, reconciled ${feed.pnl.verified}, errors ${feed.health.errors.length}`);
}

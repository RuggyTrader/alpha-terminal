// ALPHA TERMINAL — DEMO_UI_REPLAY server (local development only).
//
// A deterministic, in-memory replay of two simulated PAPER trades for UI testing.
// It is NOT the Worker, has no database, never contacts Alpaca or TradingView, and
// is never deployed. Every record is marked DEMO_UI_REPLAY / SIM_TEST and every
// price is a SIMULATED DEMO PRICE.
//
//   node tools/demo-replay/server.mjs            # listens on 127.0.0.1:8799 (DEMO_PORT to change)
//   (in frontend/) ALPHA_BACKEND_URL=http://127.0.0.1:8799 VITE_DEMO_UI=1 npx vite
//
// Routes (this server only): GET /auth/session, GET /api/dashboard,
// GET /api/__demo/state, POST /api/__demo/{start,reset,goto,stop}.
// start?scenario= resume (START DEMO) | full (FULL REPLAY) | winner | loser.

import { createServer } from "node:http";

// Loopback only. This is a constant on purpose: the replay must never be reachable
// from another machine.
export const HOST = "127.0.0.1";
const PORT = Number(process.env.DEMO_PORT ?? 8799);
const TAG = "DEMO_UI_REPLAY";
const STEP_MS = Number(process.env.DEMO_STEP_MS ?? 4000);

const BASE_EQUITY = 25000;
const WIN = { symbol: "SPY", qty: 10, entry: 500.0, path: [500.0, 500.42, 500.875, 501.34, 501.86] };
const LOSS = { symbol: "QQQ", qty: 5, entry: 420.0, path: [420.0, 419.58, 418.94, 418.32, 417.46] };

// Step labels. 0..10 = winning SPY trade, 11..20 = losing QQQ trade.
export const STEPS = [
  "Idle — no demo trades yet",
  "SPY alert received",
  "SPY validation passed",
  "SPY risk APPROVED",
  "SPY dry-run order intent",
  "SPY position opened @ $500.00",
  "SPY simulated price $500.42",
  "SPY simulated price $500.875",
  "SPY simulated price $501.34",
  "SPY simulated price $501.86",
  "SPY closed in profit",
  "QQQ alert received",
  "QQQ validation passed",
  "QQQ risk APPROVED",
  "QQQ dry-run order intent",
  "QQQ position opened @ $420.00",
  "QQQ simulated price $419.58",
  "QQQ simulated price $418.94",
  "QQQ simulated price $418.32",
  "QQQ simulated price $417.46",
  "QQQ simulated stop — closed at a loss",
];

let step = 0;
let stepTimes = [new Date().toISOString()];
let timer = null;
let range = [0, STEPS.length - 1];

function goto(n) {
  step = Math.max(0, Math.min(STEPS.length - 1, n));
  stepTimes = stepTimes.slice(0, step);
  while (stepTimes.length <= step) stepTimes.push(new Date().toISOString());
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function start(scenario) {
  stop();
  if (scenario === "resume") {
    // START DEMO: continue from the current step (or from the beginning when idle/finished).
    range = [step > 0 && step < STEPS.length - 1 ? step : 1, STEPS.length - 1];
    if (range[0] === 1) goto(0);
  } else {
    range = scenario === "winner" ? [1, 10] : scenario === "loser" ? [11, 20] : [1, 20];
    if (scenario === "loser") goto(10); // the loser starts after the winner has closed
    else goto(0);
  }
  goto(range[0]);
  timer = setInterval(() => {
    if (step >= range[1]) return stop();
    goto(step + 1);
  }, STEP_MS);
}

const r2 = (n) => Math.round(n * 100) / 100;
const at = (s) => stepTimes[Math.min(s, stepTimes.length - 1)] ?? new Date().toISOString();

/** Builds the full /api/dashboard payload for the current step. Pure function of `step`. */
export function snapshot(s = step) {
  const alerts = [], risk = [], orders = [], trades = [], activity = [];
  const positions = [];
  let realized = 0;
  let id = 0;
  const event = (when, category, level, message, extra = {}) =>
    activity.push({ id: ++id, ts: at(when), category, level, message: `[SIM_TEST] ${message}`, alert_id: null, symbol: null, action: "buy", error_detail: null, ...extra });

  const trade = (t, first, n) => {
    const alertId = `${TAG}-${t.symbol}-BUY-${n}`;
    const local = s - first; // 0 = alert step
    if (local < 0) return;
    const accepted = local >= 3;
    alerts.push({
      id: n, alert_id: alertId, received_at: at(first), processed_at: local >= 1 ? at(first + 1) : null,
      symbol: t.symbol, action: "buy", strategy: TAG, order_type: "market",
      requested_qty: String(t.qty), accepted_qty: accepted ? String(t.qty) : null,
      status: accepted ? "dry_run" : "processing", validation_result: local >= 1 ? "passed" : null,
      response_code: accepted ? "DRY_RUN_ACCEPTED" : local >= 1 ? "VALIDATED" : null, http_status: accepted ? 200 : null,
      rejection_reason: null, duplicate_count: 0, last_duplicate_at: null,
    });
    event(first, "webhook", "info", `${TAG} alert received`, { symbol: t.symbol, alert_id: alertId });
    if (local >= 1) event(first + 1, "validation", "info", "Validation passed", { symbol: t.symbol, alert_id: alertId });
    if (local >= 2) {
      const notional = t.qty * t.entry;
      risk.push({
        id: n, alert_fk: n, alert_id: alertId, symbol: t.symbol, action: "buy", strategy: TAG, decided_at: at(first + 2),
        approved: true, code: "APPROVED", reason: "All PAPER risk checks passed (SIM_TEST)", side: "buy",
        final_qty: String(t.qty), reference_price: t.entry.toFixed(2), reference_price_time: at(first + 2),
        estimated_notional: notional.toFixed(2),
        checks: [
          { check: "symbol_allowed", passed: true, detail: `${t.symbol} is allowed` },
          { check: "max_order_qty", passed: true, detail: `${t.qty} <= 10` },
          { check: "max_order_notional", passed: true, detail: `${notional.toFixed(2)} <= 5000` },
          { check: "max_open_positions", passed: true, detail: "0 < 5" },
        ],
      });
      event(first + 2, "risk", "info", "Risk APPROVED", { symbol: t.symbol, alert_id: alertId });
    }
    if (local >= 3) {
      orders.push({
        id: n, alert_id: alertId, strategy: TAG, source: "demo", client_order_id: `${TAG}-at-${t.symbol.toLowerCase()}-${n}`,
        alpaca_order_id: null, symbol: t.symbol, side: "buy", qty: String(t.qty), order_type: "market", time_in_force: "day",
        status: "dry_run_accepted", submitted_at: at(first + 3), updated_at: at(first + 3), error_detail: null,
        broker_request_sent: false,
      });
      event(first + 3, "order", "success", "Dry-run order intent recorded — no broker order submitted", { symbol: t.symbol, alert_id: alertId });
    }
    const openStep = first + 4;
    const closeStep = first + 9;
    if (s >= openStep) {
      // Events for every step the position was held (fill, then each simulated price move).
      for (let k = openStep; k <= Math.min(s, closeStep - 1); k++) {
        const px = t.path[k - openStep];
        const u = r2((px - t.entry) * t.qty);
        if (k === openStep) event(k, "position", "success", `Simulated fill ${t.qty} @ $${t.entry.toFixed(2)} (SIMULATED DEMO PRICE)`, { symbol: t.symbol });
        else event(k, "price", "info", `SIMULATED DEMO PRICE $${px} · unrealized ${u >= 0 ? "+" : "−"}$${Math.abs(u).toFixed(2)}`, { symbol: t.symbol });
      }
      if (s < closeStep) {
        const price = t.path[Math.min(s - openStep, t.path.length - 1)];
        const upl = r2((price - t.entry) * t.qty);
        positions.push({
          symbol: t.symbol, side: "long", qty: t.qty, qty_available: t.qty, avg_entry_price: t.entry,
          market_value: r2(price * t.qty), cost_basis: r2(t.entry * t.qty), current_price: price, lastday_price: t.entry,
          unrealized_pl: upl, unrealized_plpc: upl / (t.entry * t.qty), change_today: (price - t.entry) / t.entry,
        });
      } else {
        const exit = t.path[t.path.length - 1];
        const pnl = r2((exit - t.entry) * t.qty);
        realized += pnl;
        trades.push({
          id: n, symbol: t.symbol, direction: "long", status: "CLOSED", strategy: `DEMO PAPER TRADE · SIMULATED FOR UI TESTING · ${TAG}`,
          entry_qty: String(t.qty), entry_avg_price: t.entry.toFixed(2), exit_qty: String(t.qty), exit_avg_price: exit.toFixed(2),
          open_qty: "0", realized_pnl: pnl.toFixed(2), return_pct: ((exit - t.entry) / t.entry * 100).toFixed(4),
          opened_at: at(openStep), closed_at: at(closeStep),
        });
        event(closeStep, "position", pnl >= 0 ? "success" : "error",
          pnl >= 0 ? `Closed in profit +$${pnl.toFixed(2)} — DEMO PAPER TRADE, simulated for UI testing` : `Simulated stop hit −$${Math.abs(pnl).toFixed(2)} — DEMO PAPER TRADE, simulated for UI testing`,
          { symbol: t.symbol, action: "sell" });
      }
    }
  };

  trade(WIN, 1, 1);
  trade(LOSS, 11, 2);

  const upl = positions.reduce((a, p) => a + p.unrealized_pl, 0);
  const longValue = positions.reduce((a, p) => a + p.market_value, 0);
  const equity = r2(BASE_EQUITY + realized + upl);
  const cash = r2(BASE_EQUITY + realized - positions.reduce((a, p) => a + p.cost_basis, 0));
  activity.sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id);

  return {
    generated_at: new Date().toISOString(),
    mode: "PAPER",
    execution: "DRY_RUN_ONLY",
    broker_submission: false,
    enable_trading: false,
    demo: TAG,
    engine: { state: "STOPPED", kill_switch: 0, killed_at: null, reason: `${TAG}: simulated replay, engine not involved`, updated_at: at(0), updated_by: "demo" },
    broker: {
      mode: "PAPER", read_only: true, errors: [],
      account: {
        id: TAG, status: "ACTIVE", currency: "USD", cash, equity, last_equity: BASE_EQUITY, portfolio_value: equity,
        buying_power: r2(cash * 2), long_market_value: r2(longValue), short_market_value: 0,
        trading_blocked: false, account_blocked: false, pattern_day_trader: false, daytrade_count: 0,
        todays_pnl: r2(equity - BASE_EQUITY),
      },
      positions,
      clock: { timestamp: new Date().toISOString(), is_open: true, next_open: null, next_close: new Date(Date.now() + 3 * 3600e3).toISOString() },
    },
    counts: {
      alerts: { total: alerts.length, dry_run: alerts.filter((a) => a.status === "dry_run").length, rejected: 0, processing: alerts.filter((a) => a.status === "processing").length, duplicates: 0 },
      risk: { total: risk.length, approved: risk.length, rejected: 0 },
      orders: { total: orders.length, dry_run_accepted: orders.length, unknown: 0, failed: 0 },
      trades: { total: trades.length, open: 0, closed: trades.length, realized_pnl: r2(realized) },
    },
    recent: { alerts: alerts.reverse(), risk: risk.reverse(), orders: orders.reverse(), trades: trades.reverse(), activity },
  };
}

function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(data);
}

export const server = createServer((req, res) => {
  const url = new URL(req.url, "http://demo.local");
  const p = url.pathname;
  if (p === "/auth/session") return send(res, 200, { ok: true, authenticated: true, read_only: true, demo: TAG });
  if (p === "/auth/logout") return send(res, 200, { ok: true, authenticated: false });
  if (p === "/api/dashboard") return send(res, 200, { ok: true, data: snapshot() });
  if (p === "/api/__demo/state") return send(res, 200, { ok: true, step, total: STEPS.length - 1, label: STEPS[step], playing: !!timer, tag: TAG });
  if (req.method === "POST" && p === "/api/__demo/start") { start(url.searchParams.get("scenario") ?? "full"); return send(res, 200, { ok: true, step }); }
  if (req.method === "POST" && p === "/api/__demo/reset") { stop(); goto(0); return send(res, 200, { ok: true, step }); }
  if (req.method === "POST" && p === "/api/__demo/stop") { stop(); return send(res, 200, { ok: true, step }); }
  if (req.method === "POST" && p === "/api/__demo/goto") { stop(); goto(Number(url.searchParams.get("step") ?? 0)); return send(res, 200, { ok: true, step }); }
  return send(res, 404, { ok: false, code: "NOT_FOUND", message: "Demo replay server: unknown route" });
});

server.listen(PORT, HOST, () => {
  const a = server.address();
  console.log(`${TAG} server on http://${HOST}:${typeof a === "object" && a ? a.port : PORT} (in-memory, no database, no broker)`);
});

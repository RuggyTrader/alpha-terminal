import { useState } from "react";
import { api, ApiError } from "../api/client";
import { TopStatus } from "../components/AppShell";
import { HeroOrb } from "../components/icons";
import { CountUpValue } from "../components/motion";
import { Badge, ConfirmSheet, ErrorState, SettingsGroup, SRow, StatusBadge, statusTone } from "../components/ui";
import { alertsToday } from "../lib/derive";
import { ago, price, qty } from "../lib/format";
import { useData } from "../store/DataProvider";
import type { AlertBrief, ApiEnvelope, HealthComponent } from "../types/api";

const HEALTH_ROWS: [string, string][] = [
  ["webhook", "Webhook"], ["database", "Database"], ["alpaca_paper", "Alpaca PAPER"], ["execution_engine", "Execution engine"],
  ["duplicate_protection", "Duplicate protection"], ["market_data", "Market data"], ["activity_logging", "Activity logging"],
  ["authentication", "Authentication"],
];

/** HEALTHY gets a friendlier word; every other status is shown exactly as reported. */
function friendly(c: HealthComponent | undefined, ok: string): string {
  if (!c) return "N/A";
  return c.status === "HEALTHY" ? ok : c.status;
}

function alertLine(a: AlertBrief | null) {
  if (!a) return "NONE";
  return `${(a.action ?? "?").toUpperCase()} ${a.symbol ?? ""} · ${ago(a.received_at)}`;
}

type Pending = null | { title: string; body: string; confirm: string; path: string; payload?: unknown; danger?: boolean };

export function EnginePage() {
  const { engine, alerts, refresh } = useData();
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const d = engine.data;
  const state = d?.engine.state ?? null;
  const killed = !!d?.engine.kill_switch;
  const h = d?.health;

  async function act(path: string, payload?: unknown) {
    setBusy(true);
    try {
      const r = await api.post<ApiEnvelope>(path, payload);
      setMsg({ text: r.message, bad: !r.ok });
    } catch (e) {
      setMsg({ text: e instanceof ApiError ? e.message : "Request failed", bad: true });
    } finally {
      setBusy(false);
    }
    await refresh("engine", "summary", "activity", "positions");
  }

  const tile = (label: string, c: HealthComponent | undefined, ok: string) => {
    const v = friendly(c, ok);
    return (
      <div className="mtile">
        <span>{label}</span>
        <b className={`t-${statusTone(c?.status)}`}><i className="dot" />{v}</b>
      </div>
    );
  };

  return (
    <div>
      <TopStatus title="Alpha Engine" />
      <ErrorState error={engine.error} what="ENGINE" />
      <div className="two-col">
        <div className="col">
          <section className="engine-hero">
            <HeroOrb />
            <div className="engine-hero-main">
              <div className="hero-title">Alpha Engine</div>
              <span className="hero-badge">PAPER EXECUTION</span>
              <div className="hero-label">CURRENT STATE</div>
              <div className={`engine-state s-${state ?? "NA"}`}>{state ?? "N/A"}</div>
              <div className="hero-sub">{killed ? "Kill switch active — new orders blocked" : d ? `since ${ago(d.engine.updated_at)}` : "—"}</div>
            </div>
            <div className="engine-actions">
              {!d ? null : killed ? (
                <button className="btn light" disabled={busy} onClick={() => setPending({
                  title: "Reset kill switch?", confirm: "RESET KILL SWITCH", path: "/kill/reset",
                  body: "The engine stays STOPPED after the reset. You still have to press START.",
                })}>RESET KILL SWITCH</button>
              ) : state === "STOPPED" ? (
                <button className="btn primary wide" disabled={busy || !d.enable_trading} onClick={() => act("/engine/start")}>START</button>
              ) : state === "RUNNING" ? (
                <>
                  <button className="btn primary" disabled={busy} onClick={() => act("/engine/pause")}>PAUSE</button>
                  <button className="btn light" disabled={busy} onClick={() => act("/engine/stop")}>STOP</button>
                </>
              ) : state === "PAUSED" ? (
                <>
                  <button className="btn primary" disabled={busy} onClick={() => act("/engine/resume")}>RESUME</button>
                  <button className="btn light" disabled={busy} onClick={() => act("/engine/stop")}>STOP</button>
                </>
              ) : null}
            </div>
            {d && !d.enable_trading && <p className="engine-note">ENABLE_TRADING=false on the server — PAPER execution cannot start.</p>}
            {msg && <p className={`engine-note ${msg.bad ? "neg" : "pos"}`}>{msg.text}</p>}
          </section>

          <div className="mgrid">
            {tile("WEBHOOK", h?.components.webhook, "READY")}
            {tile("ALPACA", h?.components.alpaca_paper, "CONNECTED")}
            {tile("DATABASE", h?.components.database, "HEALTHY")}
            {tile("DUPLICATE GUARD", h?.components.duplicate_protection, "ACTIVE")}
          </div>

          <div className="counters">
            <div><CountUpValue id="eng-today" value={alerts.data ? alertsToday(alerts.data.alerts) : null} format={(n) => String(Math.round(n))} /><span>ALERTS TODAY</span></div>
            <div><CountUpValue id="eng-acc" className="pos" value={d ? d.counters.alerts_accepted : null} format={(n) => String(Math.round(n))} /><span>ACCEPTED</span></div>
            <div><CountUpValue id="eng-rej" className={d?.counters.alerts_rejected ? "neg" : ""} value={d ? d.counters.alerts_rejected : null} format={(n) => String(Math.round(n))} /><span>REJECTED</span></div>
            <div><CountUpValue id="eng-dup" value={d ? d.counters.duplicates_blocked : null} format={(n) => String(Math.round(n))} /><span>DUPLICATES</span></div>
          </div>

          <SettingsGroup title="LATEST" footer={`Accepted / rejected / duplicates are all-time counts (${d ? d.counters.alerts_received : "N/A"} webhook calls received). Alerts today come from stored alert records.`}>
            <SRow k="Last alert" v={alertLine(d?.last_alert ?? null)} />
            <SRow k="Last accepted" v={alertLine(d?.last_accepted_alert ?? null)} cls={d?.last_accepted_alert ? "pos" : ""} />
            <SRow k="Last rejected" v={alertLine(d?.last_rejected_alert ?? null)} cls={d?.last_rejected_alert ? "neg" : ""} />
            {d?.last_rejected_alert?.rejection_reason && <SRow k="Reason" v={d.last_rejected_alert.rejection_reason} cls="neg" />}
            <SRow k="Last PAPER order" v={d?.last_order
              ? `${d.last_order.side.toUpperCase()} ${qty(d.last_order.qty)} ${d.last_order.symbol} · ${d.last_order.status.toUpperCase()}${d.last_order.filled_avg_price ? ` @ ${price(d.last_order.filled_avg_price)}` : ""}`
              : "NONE"} />
            <SRow k="Open PAPER positions" v={d?.open_positions ?? "N/A"} />
            <SRow k="Last webhook" v={ago(d?.last_webhook_at)} />
          </SettingsGroup>
        </div>

        <div className="col">
          <SettingsGroup title="SYSTEM HEALTH" footer={h ? `Overall: ${h.system_health}. Market data and engine state are reported but not counted in the overall status.` : undefined}>
            {HEALTH_ROWS.map(([key, label]) => <SRow key={key} k={label} v={<StatusBadge status={h?.components[key]?.status ?? "UNAVAILABLE"} />} />)}
          </SettingsGroup>

          <SettingsGroup title="EMERGENCY CONTROLS" footer="Stops every new PAPER order from webhooks immediately. Does not close positions or cancel open orders.">
            <div className="pad">
              <button className="btn danger-outline block" disabled={!d || killed} onClick={() => setPending({
                title: "Stop new orders?", confirm: "ENGAGE KILL SWITCH", path: "/kill", danger: true,
                body: "All new PAPER orders are blocked and the engine is forced to STOPPED. Existing positions and open orders are left untouched.",
              })}>{killed ? "KILL SWITCH ACTIVE" : "STOP NEW ORDERS"}</button>
            </div>
          </SettingsGroup>

          <SettingsGroup title="POSITIONS & ORDERS" footer="Separate, explicit actions. The kill switch never does these.">
            <div className="pad stack-8">
              <button className="btn danger-outline block small" disabled={!d} onClick={() => setPending({
                title: "Cancel all open PAPER orders?", confirm: "CANCEL OPEN ORDERS", path: "/api/orders/cancel-open",
                payload: { confirm: "CANCEL OPEN ORDERS" }, danger: true,
                body: "Sends a cancel request to Alpaca PAPER for every working order. Filled orders are not affected.",
              })}>CANCEL OPEN ORDERS</button>
              <button className="btn danger-outline block small" disabled={!d || !d.open_positions} onClick={() => setPending({
                title: "Close all PAPER positions?", confirm: "SUBMIT CLOSE ORDERS", path: "/api/positions/close-all",
                payload: { confirm: "CLOSE ALL PAPER POSITIONS" }, danger: true,
                body: `Submits PAPER market orders to flatten ${d?.open_positions ?? 0} position(s).`,
              })}>CLOSE ALL POSITIONS</button>
            </div>
          </SettingsGroup>
          <p className="footnote"><Badge>PAPER ONLY</Badge> Controls affect Alpaca PAPER execution only.</p>
        </div>
      </div>

      <ConfirmSheet open={!!pending} title={pending?.title ?? ""} body={pending?.body} confirm={pending?.confirm ?? ""}
        danger={pending?.danger} onClose={() => setPending(null)}
        onConfirm={async () => { if (pending) await act(pending.path, pending.payload); }} />
    </div>
  );
}

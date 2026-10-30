import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { Icon } from "../components/icons";
import { SymbolIcon } from "../components/trading";
import { Badge, EmptyState, ErrorState, LoadingRows, SettingsGroup, SRow, StatusBadge } from "../components/ui";
import { usePoll } from "../hooks/usePoll";
import { alertStage } from "../lib/derive";
import { dateTime, money, price, qty } from "../lib/format";
import type { AlertDetail, OrderRow, RiskDecision } from "../types/api";

export function BackBar({ title }: { title: string }) {
  const nav = useNavigate();
  return (
    <header className="backbar">
      <button onClick={() => (window.history.length > 1 ? nav(-1) : nav("/trades"))} aria-label="Back"><Icon name="back" size={20} /></button>
      <b>{title}</b>
      <span />
    </header>
  );
}

export function AlertDetailPage() {
  const { id } = useParams();
  const q = usePoll(() => api.get<AlertDetail>(`/api/alerts/${id}`), 10000, [id]);
  const a = q.data;
  return (
    <div className="detail">
      <BackBar title="Alert receipt" />
      <ErrorState error={q.error} what="ALERT" />
      {!a ? (q.loading ? <LoadingRows rows={5} /> : <EmptyState>NOT FOUND</EmptyState>) : (
        <>
          <div className="receipt-head">
            <SymbolIcon symbol={a.symbol ?? "?"} size={40} />
            <h1>{a.symbol ?? "—"}</h1>
            <span className="receipt-side">{(a.action ?? "?").toUpperCase()} · {a.strategy ?? "UNSPECIFIED"}</span>
            <div className="receipt-badges">
              <StatusBadge status={a.status === "error" ? "ERROR" : a.status.toUpperCase()} />
              <Badge>{alertStage(a).toUpperCase()}</Badge>
            </div>
            {a.rejection_reason && <p className="receipt-reason neg">{a.code}: {a.rejection_reason}</p>}
          </div>
          <AlertGroups a={a} />
        </>
      )}
    </div>
  );
}

export function AlertGroups({ a }: { a: AlertDetail }) {
  const risk = a.risk_decisions[a.risk_decisions.length - 1];
  return (
    <>
      <SettingsGroup title="SIGNAL">
        <SRow k="TradingView alert ID" v={a.alert_id} mono />
        <SRow k="Received" v={dateTime(a.received_at)} />
        <SRow k="Processed" v={dateTime(a.processed_at)} />
        <SRow k="Strategy" v={a.strategy ?? "N/A"} />
        <SRow k="Action" v={(a.action ?? "N/A").toUpperCase()} />
        <SRow k="Order type" v={(a.order_type ?? "N/A").toUpperCase()} />
        <SRow k="Requested qty" v={qty(a.requested_qty)} />
        <SRow k="Accepted qty" v={qty(a.accepted_qty)} />
        <SRow k="Duplicates blocked" v={a.duplicate_count} />
      </SettingsGroup>
      <SettingsGroup title="VALIDATION">
        <SRow k="Result" v={(a.validation_result ?? "N/A").toUpperCase()}
          cls={a.validation_result === "failed" ? "neg" : a.validation_result === "passed" ? "pos" : ""} />
        <SRow k="Response" v={`${a.http_status ?? "—"} ${a.code ?? ""}`} mono />
        <SRow k="Database record" v={`#${a.database_record_id}`} mono />
      </SettingsGroup>
      <RiskGroup risk={risk} />
      {a.orders.map((o) => <OrderGroup key={o.id} o={o} />)}
      {a.payload && (
        <SettingsGroup title="RECEIVED PAYLOAD" footer="The webhook secret is removed before storage.">
          <pre className="json">{JSON.stringify(a.payload, null, 2)}</pre>
        </SettingsGroup>
      )}
    </>
  );
}

export function RiskGroup({ risk }: { risk: RiskDecision | undefined }) {
  if (!risk) {
    return <SettingsGroup title="RISK"><SRow k="Risk decision" v="NOT EVALUATED (stopped earlier)" /></SettingsGroup>;
  }
  return (
    <SettingsGroup title="RISK">
      <SRow k="Risk decision" v={risk.approved ? "APPROVED" : risk.code} cls={risk.approved ? "pos" : "neg"} />
      {!risk.approved && <SRow k="Rejection reason" v={risk.reason} cls="neg" />}
      <SRow k="Reference price" v={risk.reference_price ? `${price(risk.reference_price)} · ${dateTime(risk.reference_price_time)}` : "N/A"} />
      <SRow k="Est. notional" v={money(risk.estimated_notional)} />
      <div className="checks">
        {risk.checks.map((c) => (
          <div key={c.check} className="check">
            <span className={c.passed ? "pos" : "neg"}>{c.passed ? "✓" : "✕"}</span>
            <span><b>{c.check.replace(/_/g, " ")}</b> <em>{c.detail}</em></span>
          </div>
        ))}
      </div>
    </SettingsGroup>
  );
}

export function OrderGroup({ o }: { o: OrderRow }) {
  return (
    <SettingsGroup title={o.source === "manual_close" ? "BROKER · MANUAL CLOSE" : "BROKER"}>
      <SRow k="Badge" v={<Badge tone={o.verified ? "green" : "orange"}>{o.verified ? "VERIFIED PAPER" : "PAPER ORDER"}</Badge>} />
      <SRow k="Alpaca PAPER order ID" v={o.alpaca_order_id ?? "N/A"} mono />
      <SRow k="Client order ID" v={o.client_order_id} mono />
      <SRow k="Order status" v={<StatusBadge status={o.status} />} />
      <SRow k="Side / qty" v={`${o.side.toUpperCase()} ${qty(o.qty)}`} />
      <SRow k="Type / TIF" v={`${o.order_type.toUpperCase()} / ${o.time_in_force.toUpperCase()}`} />
      <SRow k="Market open at submit" v={o.market_open_at_submit === null ? "UNKNOWN" : o.market_open_at_submit ? "YES" : "NO — QUEUED"} />
      <SRow k="Filled (Alpaca aggregate)" v={qty(o.filled_qty)} />
      <SRow k="Average fill" v={price(o.filled_avg_price)} />
      <SRow k="Submitted" v={dateTime(o.submitted_at)} />
      <SRow k="Filled at" v={dateTime(o.filled_at)} />
      {o.canceled_at && <SRow k="Canceled at" v={dateTime(o.canceled_at)} />}
      <SRow k="Last synced" v={dateTime(o.last_synced_at)} />
      {o.error_detail && <SRow k="Error" v={o.error_detail} cls="neg" />}
    </SettingsGroup>
  );
}

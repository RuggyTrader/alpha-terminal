import { useState } from "react";
import { AlertCard } from "../components/AlertCard";
import { OrderIntentCard } from "../components/OrderIntentCard";
import { RiskDecisionCard } from "../components/RiskDecisionCard";
import { TradeCard } from "../components/TradeCard";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { useDash } from "../store";

export type TradesTab = "alerts" | "risk" | "orders" | "history";

const TABS: { id: TradesTab; label: string }[] = [
  { id: "alerts", label: "Alerts" },
  { id: "risk", label: "Risk" },
  { id: "orders", label: "Orders" },
  { id: "history", label: "History" },
];

export function TradesPage({ initialTab = "alerts" }: { initialTab?: TradesTab }) {
  const { state } = useDash();
  const [tab, setTab] = useState<TradesTab>(initialTab);
  const d = state.data;
  const c = d?.counts;
  const loading = state.status === "loading" && !d;
  const idx = TABS.findIndex((t) => t.id === tab);

  return (
    <div className="page-narrow">
      <h1 className="page-title">Trades</h1>
      <div className="seg" role="tablist" style={{ ["--i" as string]: idx }}>
        <span className="seg-pill" aria-hidden />
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "alerts" ? (
        <section aria-label="Alerts">
          <SectionHeader
            title="TradingView alerts"
            right={c ? <span className="muted-s">{c.alerts.total} total · {c.alerts.rejected} rejected · {c.alerts.duplicates} dup</span> : null}
          />
          {loading ? <SkeletonCards count={3} /> : !d ? <EmptyState title="No data" />
            : d.recent.alerts.length === 0 ? <EmptyState title="No TradingView alerts yet">Alerts received by the Worker will appear here.</EmptyState>
            : <div className="stack">{d.recent.alerts.map((a) => <AlertCard key={a.id} a={a} />)}</div>}
        </section>
      ) : null}

      {tab === "risk" ? (
        <section aria-label="Risk decisions">
          <SectionHeader
            title="Risk decisions"
            right={c ? <span className="muted-s">{c.risk.approved} approved · {c.risk.rejected} rejected</span> : null}
          />
          {loading ? <SkeletonCards count={3} /> : !d ? <EmptyState title="No data" />
            : d.recent.risk.length === 0 ? <EmptyState title="No risk decisions yet">Decisions from the PAPER risk engine will appear here.</EmptyState>
            : <div className="stack">{d.recent.risk.map((r) => <RiskDecisionCard key={r.id} r={r} />)}</div>}
        </section>
      ) : null}

      {tab === "orders" ? (
        <section aria-label="Order intents">
          <SectionHeader title="Order intents" sub={<StatusBadge tone="warn">DRY RUN — NO BROKER ORDER SUBMITTED</StatusBadge>} />
          {loading ? <SkeletonCards count={3} /> : !d ? <EmptyState title="No data" />
            : d.recent.orders.length === 0 ? <EmptyState title="No dry-run order intents yet">Approved alerts are recorded here as intents only.</EmptyState>
            : <div className="stack">{d.recent.orders.map((o) => <OrderIntentCard key={o.id} o={o} />)}</div>}
        </section>
      ) : null}

      {tab === "history" ? (
        <section aria-label="Trade history">
          <SectionHeader title="Trade history" right={c && c.trades.total > 0 ? <span className="muted-s">{c.trades.open} open · {c.trades.closed} closed</span> : null} />
          {loading ? <SkeletonCards count={2} /> : !d ? <EmptyState title="No data" />
            : d.recent.trades.length === 0 ? <EmptyState title="No completed PAPER trades yet.">Only persisted trade records are shown.</EmptyState>
            : <div className="stack">{d.recent.trades.map((t) => <TradeCard key={t.id} t={t} />)}</div>}
        </section>
      ) : null}
    </div>
  );
}

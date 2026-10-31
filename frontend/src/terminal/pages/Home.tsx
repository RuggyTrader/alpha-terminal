import { Link } from "react-router-dom";
import { AccountHero } from "../components/AccountHero";
import { AccountOverview } from "../components/AccountOverview";
import { AlertCard } from "../components/AlertCard";
import { PositionCard } from "../components/PositionCard";
import { SafetyCard } from "../components/SafetyCard";
import { EmptyState, SectionHeader, SkeletonCards } from "../components/ui";
import { useDash } from "../store";

export function PositionsSection() {
  const { state } = useDash();
  const broker = state.data?.broker ?? null;
  const err = broker?.errors.find((e) => e.source === "positions");
  const rows = broker?.positions ?? [];
  return (
    <section aria-label="Open positions">
      <SectionHeader title="Open positions" right={broker && !err ? <span className="count">{rows.length}</span> : null} />
      {!broker ? (
        state.status === "loading" ? <SkeletonCards count={1} tall /> : <EmptyState title="No data" />
      ) : err ? (
        <EmptyState title="PAPER positions unavailable" tone="warn">
          {err.code === "BROKER_NOT_CONFIGURED" ? "Alpaca PAPER keys are not configured on the server." : `${err.code}: ${err.message}`}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title="No open PAPER positions">Positions held in the Alpaca PAPER account will appear here.</EmptyState>
      ) : (
        <div className="stack">{rows.map((p) => <PositionCard key={p.symbol} p={p} />)}</div>
      )}
    </section>
  );
}

export function HomePage() {
  const { state } = useDash();
  const d = state.data;
  const alerts = d?.recent.alerts ?? [];
  const total = d?.counts.alerts.total ?? 0;
  return (
    <div className="home-grid">
      <div className="col-main">
        <AccountHero state={state} />
        <AccountOverview broker={d?.broker ?? null} />
        <PositionsSection />
      </div>
      <div className="col-side">
        <section aria-label="Recent alerts">
          <SectionHeader
            title="Recent alerts"
            right={d ? <Link className="link" to="/trades">{total} total · View all</Link> : null}
          />
          {!d ? (
            state.status === "loading" ? <SkeletonCards count={2} /> : <EmptyState title="No data" />
          ) : alerts.length === 0 ? (
            <EmptyState title="No TradingView alerts yet">Alerts received by the Worker will appear here.</EmptyState>
          ) : (
            <div className="stack">{alerts.slice(0, 5).map((a) => <AlertCard key={a.id} a={a} />)}</div>
          )}
        </section>
        <SafetyCard data={d} />
      </div>
    </div>
  );
}

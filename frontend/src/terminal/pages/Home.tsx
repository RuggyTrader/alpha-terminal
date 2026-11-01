import { Link } from "react-router-dom";
import { AccountHero } from "../components/AccountHero";
import { AccountOverview } from "../components/AccountOverview";
import { AlertCard } from "../components/AlertCard";
import { PositionCard } from "../components/PositionCard";
import { SafetyCard } from "../components/SafetyCard";
import { EmptyState, SectionHeader, SkeletonCards } from "../components/ui";
import { AnimatedList, Reveal } from "../motion";
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
      ) : (
        <>
          {/* Stays mounted when empty so a closing position can fade out. */}
          <AnimatedList items={rows} getKey={(p) => p.symbol} render={(p) => <PositionCard p={p} />} />
          {rows.length === 0 ? (
            <EmptyState title="No open PAPER positions">Positions held in the Alpaca PAPER account will appear here.</EmptyState>
          ) : null}
        </>
      )}
    </section>
  );
}

export function HomePage() {
  const { state, reconnected } = useDash();
  const d = state.data;
  const alerts = d?.recent.alerts ?? [];
  const total = d?.counts.alerts.total ?? 0;
  return (
    <div className="home-grid">
      <div className="col-main m-stagger">
        <AccountHero state={state} reconnected={reconnected} />
        <AccountOverview broker={d?.broker ?? null} loading={state.status === "loading" && !d} />
        <PositionsSection />
      </div>
      <div className="col-side m-stagger">
        <Reveal>
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
              <AnimatedList items={alerts.slice(0, 5)} getKey={(a) => String(a.id)} render={(a) => <AlertCard a={a} />} />
            )}
          </section>
        </Reveal>
        <Reveal>
          <SafetyCard data={d} />
        </Reveal>
      </div>
    </div>
  );
}

import { Link } from "react-router-dom";
import { AccountHero } from "../components/AccountHero";
import { AccountOverview } from "../components/AccountOverview";
import { AlertCard } from "../components/AlertCard";
import { AlphaPaperPerformance } from "../components/AlphaPaperPerformance";
import { AlphaPaperPositionCard } from "../components/AlphaPaperPositionCard";
import { PositionCard } from "../components/PositionCard";
import { SafetyCard } from "../components/SafetyCard";
import { EmptyState, SectionHeader, SkeletonCards } from "../components/ui";
import { AnimatedList, Reveal } from "../motion";
import { useDash } from "../store";

/** Internal ALPHA PAPER ledger positions (simulated). The main positions list. */
export function PositionsSection() {
  const { state } = useDash();
  const d = state.data;
  const paper = d?.paper ?? null;
  const rows = paper?.positions ?? [];
  return (
    <section aria-label="ALPHA PAPER positions">
      <SectionHeader
        title="ALPHA PAPER positions"
        sub="Simulated from dry-run intents · not broker positions"
        right={paper ? <span className="count">{rows.length}</span> : null}
      />
      {!d ? (
        state.status === "loading" ? <SkeletonCards count={1} tall /> : <EmptyState title="No data" />
      ) : !paper ? (
        <EmptyState title="ALPHA PAPER ledger unavailable" tone="warn">This Worker does not report the simulated ledger.</EmptyState>
      ) : (
        <>
          {/* Stays mounted when empty so a closing position can fade out. */}
          <AnimatedList items={rows} getKey={(p) => String(p.id)} render={(p) => <AlphaPaperPositionCard p={p} />} />
          {rows.length === 0 ? (
            <EmptyState title="No open ALPHA PAPER positions">An accepted dry-run BUY opens a simulated position here.</EmptyState>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Positions actually held in the Alpaca PAPER account. Shown only when there are any (or an error). */
export function BrokerPositionsSection() {
  const { state } = useDash();
  const broker = state.data?.broker ?? null;
  const err = broker?.errors.find((e) => e.source === "positions");
  const rows = broker?.positions ?? [];
  if (!broker || (!err && rows.length === 0)) return null;
  return (
    <section aria-label="Alpaca PAPER account positions">
      <SectionHeader title="Alpaca PAPER account positions" sub="Broker account · not the ALPHA PAPER ledger" right={!err ? <span className="count">{rows.length}</span> : null} />
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
        {d?.paper ? <AlphaPaperPerformance paper={d.paper} /> : null}
        <PositionsSection />
        <BrokerPositionsSection />
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

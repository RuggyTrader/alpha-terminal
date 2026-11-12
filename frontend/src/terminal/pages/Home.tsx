import { PerformanceSelector } from "../components/PerformanceSelector";
import { Link } from "react-router-dom";
import { AccountHero } from "../components/AccountHero";
import { AlertCard } from "../components/AlertCard";
import { AlphaPaperPositionCard } from "../components/AlphaPaperPositionCard";
import { ActivityPanel, PipelinePanel } from "../components/HomePanels";
import { BotPipelinePanel } from "../components/BotPipeline";
import { PortfolioSummaryCard } from "../components/PaperPortfolio";
import { PositionCard } from "../components/PositionCard";
import { SafetyCard } from "../components/SafetyCard";
import { MarketsCard, SystemHealthCard } from "../components/SystemHealth";
import { EmptyState, SectionHeader, SkeletonCards } from "../components/ui";
import { AnimatedList, Reveal } from "../motion";
import { useActivity } from "../activity";
import { useDash } from "../store";
import { useVerified } from "../useVerified";
import { useFundedVerified } from "../fundedTrades";

/** Internal ALPHA PAPER ledger positions (simulated). The main positions list. */
export function PositionsSection() {
  const { state } = useDash();
  const d = state.data;
  const paper = d?.paper ?? null;
  const rows = paper?.positions ?? [];
  return (
    <section aria-label="Open positions">
      <SectionHeader
        title="Open positions"
        sub="ALPHA PAPER ledger · simulated, not broker positions"
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

/** Positions held in the optional Alpaca PAPER broker account. Shown only when there are any; its errors are in Settings. */
export function BrokerPositionsSection() {
  const { state } = useDash();
  const broker = state.data?.broker ?? null;
  const err = broker?.errors.find((e) => e.source === "positions");
  const rows = broker?.positions ?? [];
  if (!broker || err || rows.length === 0) return null;
  return (
    <section aria-label="Alpaca PAPER account positions">
      <SectionHeader title="Alpaca PAPER account positions" sub="Optional broker account · not the ALPHA PAPER ledger" right={<span className="count">{rows.length}</span>} />
      <AnimatedList items={rows} getKey={(p) => p.symbol} render={(p) => <PositionCard p={p} />} />
    </section>
  );
}

export function HomePage() {
  const { state, reconnected } = useDash();
  // One funded trade set for the hero and the Funded PAPER tab: the legacy ledger + the bot ledger, never twice.
  const verified = useFundedVerified(useVerified());
  const d = state.data;
  const alerts = d?.recent.alerts ?? [];
  const total = d?.counts.alerts.total ?? 0;
  const activity = useActivity(reconnected, state.status === "stale" || state.status === "error");
  return (
    <div className="home-grid">
      <div className="col-main m-stagger">
        <AccountHero state={state} verified={verified} reconnected={reconnected} />
        <PerformanceSelector verified={verified} />
        <div className="hp-panels">
          <PipelinePanel state={state} mirror={activity.mirror} />

          <BotPipelinePanel />
          <ActivityPanel activity={activity} />
        </div>
        <MarketsCard state={state} />
        {d?.portfolio ? <PortfolioSummaryCard portfolio={d.portfolio} /> : null}
        <PositionsSection />
        <BrokerPositionsSection />
      </div>
      <div className="col-side m-stagger">
        <Reveal>
          <SystemHealthCard state={state} />
        </Reveal>
        <Reveal>
          <section aria-label="Recent signals">
            <SectionHeader
              title="Recent signals"
              right={d ? <Link className="link" to="/trades">{total} total · View all</Link> : null}
            />
            {!d ? (
              state.status === "loading" ? <SkeletonCards count={2} /> : <EmptyState title="No data" />
            ) : alerts.length === 0 ? (
              <EmptyState title="No signals yet">Signals received by the Worker will appear here.</EmptyState>
            ) : (
              <AnimatedList items={alerts.slice(0, 3)} getKey={(a) => String(a.id)} render={(a) => <AlertCard a={a} />} />
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

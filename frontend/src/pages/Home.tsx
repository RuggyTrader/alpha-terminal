import { useMemo } from "react";
import { Link } from "react-router-dom";
import { TopStatus } from "../components/AppShell";
import { ActivityPanel, HeroPnL, PositionRow, StrategyPerformance, TradeGrid } from "../components/trading";
import { EmptyState, ErrorState, LoadingRows, Section } from "../components/ui";
import { strategyStats } from "../lib/derive";
import { useData } from "../store/DataProvider";

export function HomePage() {
  const { summary, trades, positions, activity, engine } = useData();
  const all = trades.data?.trades ?? [];
  const stats = useMemo(() => strategyStats(all), [all]);
  const closed = all.filter((t) => t.status === "CLOSED")
    .sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? ""));
  const pos = positions.data;
  const state = engine.data?.engine.state ?? summary.data?.engine.state ?? null;

  return (
    <div className="home">
      <TopStatus />
      <div className="home-grid">
        <div className="home-col">
          <HeroPnL summary={summary.data} error={summary.error} updatedAt={summary.updatedAt} loading={summary.loading} />
          <StrategyPerformance stats={stats} capped={all.length >= 500} />
          <Section title="Closed trades" right={<Link to="/trades">{summary.data ? `${summary.data.closed_trades} total` : ""} · View all</Link>}>
            <ErrorState error={trades.error} what="TRADES" />
            {trades.loading && !trades.data ? <LoadingRows rows={2} />
              : closed.length === 0 ? <EmptyState small>NO CLOSED PAPER TRADES YET</EmptyState>
              : <TradeGrid trades={closed} stats={stats} />}
          </Section>
        </div>
        <div className="home-col">
          <ActivityPanel events={activity.events} fresh={activity.freshIds} state={state} />
          <Section title="Open positions" right={pos?.available ? `${pos.positions.length}` : undefined}>
            <ErrorState error={positions.error} what="POSITIONS" />
            {positions.loading && !pos ? <LoadingRows rows={1} />
              : pos && !pos.available ? <EmptyState small>POSITIONS {pos.error === "NOT CONFIGURED" ? "NOT CONFIGURED" : "UNAVAILABLE"}</EmptyState>
              : pos && pos.positions.length === 0 ? <EmptyState small>NO OPEN PAPER POSITIONS</EmptyState>
              : <div className="prow-list">{pos?.positions.map((p) => <PositionRow key={p.symbol} p={p} />)}</div>}
          </Section>
          <p className="footnote">All values are simulated Alpaca PAPER data. Nothing here is real money.</p>
        </div>
      </div>
    </div>
  );
}

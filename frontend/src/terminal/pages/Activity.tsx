import { ActivityFeed } from "../components/ActivityFeed";
import { EmptyState, SectionHeader, SkeletonCards } from "../components/ui";
import { useDash } from "../store";

export function ActivityPage() {
  const { state } = useDash();
  const d = state.data;
  return (
    <div className="page-narrow m-stagger">
      <h1 className="page-title">Activity</h1>
      <section className="card feed-card" aria-label="Activity feed">
        <SectionHeader title="Alpha Engine" sub="Recorded system activity" right={d ? <span className="count">{d.recent.activity.length}</span> : null} />
        {!d ? (
          state.status === "loading" ? <SkeletonCards count={4} /> : <EmptyState title="No data" />
        ) : (
          <ActivityFeed rows={d.recent.activity} />
        )}
      </section>
      <p className="hint">Alerts, risk decisions, dry-run intents and ALPHA PAPER position changes as recorded by the Worker. Full records are on the Trades tab.</p>
    </div>
  );
}

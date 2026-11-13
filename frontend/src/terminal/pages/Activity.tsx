import { useState } from "react";
import { ActivityFeed } from "../components/ActivityFeed";
import { ActivityRowView } from "../components/HomePanels";
import { EmptyState, SectionHeader, SkeletonCards } from "../components/ui";
import { SOURCE_LABEL, useActivity, type ActivitySource } from "../activity";
import { useDash } from "../store";

/** The Worker's events endpoint returns at most this many (worker/src/events.ts activityFeed). */
export const ACTIVITY_PAGE_LIMIT = 50;

/**
 * The chronological event history: the SAME authoritative feed as Home's Activity card (GET /api/dashboard/events:
 * trade lifecycle events, bot orders and refusals, signals, engine heartbeats), so "All activity →" never leads to a
 * different list. Each event links to its record (trade proof, chart). Filters come from the events themselves.
 * The legacy single-engine log (activity_events) stays available below, collapsed.
 */
export function ActivityPage() {
  const { state, reconnected } = useDash();
  const activity = useActivity(reconnected, state.status === "stale" || state.status === "error", ACTIVITY_PAGE_LIMIT);
  const items = activity.items;
  const sources = items ? ([...new Set(items.map((i) => i.source))] as ActivitySource[]) : [];
  const [src, setSrc] = useState<ActivitySource | "all">("all");
  const shown = items ? (src === "all" ? items : items.filter((i) => i.source === src)) : null;
  const legacy = state.data?.recent.activity ?? [];

  return (
    <div className="page-narrow m-stagger">
      <h1 className="page-title">Activity log</h1>
      {sources.length > 1 ? (
        <div className="chips" role="tablist" aria-label="Filter by source">
          {(["all", ...sources] as const).map((c) => (
            <button key={c} type="button" role="tab" aria-selected={src === c} className={`chip m-press${src === c ? " on" : ""}`} onClick={() => setSrc(c)}>
              {c === "all" ? "ALL" : SOURCE_LABEL[c]}
            </button>
          ))}
        </div>
      ) : null}
      <section className="card feed-card" aria-label="Activity feed">
        <SectionHeader title="Recorded events" sub={`Newest first · the latest ${ACTIVITY_PAGE_LIMIT} as recorded by the Worker`} right={shown ? <span className="count">{shown.length}</span> : null} />
        {activity.error && items ? <div className="ac-stale">Not refreshed: {activity.error}</div> : null}
        {shown === null ? (
          activity.error ? <EmptyState title="Activity unavailable" tone="warn">{activity.error}</EmptyState> : <SkeletonCards count={4} />
        ) : shown.length === 0 ? (
          <EmptyState title="No recorded activity yet">Orders, fills, stop moves, exits and refusals appear here as the Worker records them.</EmptyState>
        ) : (
          <div className="ac-list">{shown.map((e) => <ActivityRowView key={e.id} e={e} />)}</div>
        )}
      </section>
      <p className="hint">
        Each event links to its trade proof or chart. Activity is the history of what happened; the current state of every
        order and position is on the Trades tab. Strategy Mirror events are hypothetical and labelled.
      </p>
      {legacy.length ? (
        <details className="card feed-card">
          <summary><b>Legacy engine log</b> <span className="muted-s">({legacy.length} signals, risk decisions and intents of the original single-engine path)</span></summary>
          <ActivityFeed rows={legacy} />
        </details>
      ) : null}
    </div>
  );
}

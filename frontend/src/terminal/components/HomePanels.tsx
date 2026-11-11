import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SOURCE_LABEL, type ActivityItem, type ActivityState } from "../activity";
import { hms } from "../fmt";
import { AnimatedList, useChanged } from "../motion";
import { buildPipeline, type Stage } from "../pipeline";
import type { FeedState } from "../poller";
import { EmptyState, SectionHeader, SkeletonCards } from "./ui";

/** Re-render every `ms` so countdowns and "x ago" stay current (no new data is made up). */
function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

function StageRow({ s, last }: { s: Stage; last: boolean }) {
  const changed = useChanged(s.status);
  return (
    <li className={`pl-stage pl-${s.tone} ${s.active ? "is-active" : ""}`} aria-label={`${s.title}: ${s.status}`}>
      <div className="pl-rail" aria-hidden>
        <span className="pl-dot" />
        {!last ? <span className="pl-line" /> : null}
      </div>
      <div className="pl-body">
        <div className="pl-head">
          <span className="pl-title">{s.title}</span>
          <span className={`pl-status ${changed ? "m-pop" : ""}`}>{s.status}</span>
        </div>
        <div className="pl-detail">{s.detail}</div>
        {s.sub ? <div className="pl-sub">{s.sub}</div> : null}
      </div>
    </li>
  );
}

/** Five real stages of the ALPHA TERMINAL flow, from the Worker's data only. */
export function PipelinePanel({ state, mirror }: { state: FeedState; mirror: ActivityState["mirror"] }) {
  const now = useNow();
  const stages = buildPipeline({ feed: state, mirror, now });
  return (
    <section className="card hp-card" aria-label="Pipeline">
      <SectionHeader title="Pipeline" sub="Live state of each step · PAPER only" right={<Link className="link" to="/engine">Engine</Link>} />
      <ol className="pl-list">
        {stages.map((s, i) => (
          <StageRow key={s.key} s={s} last={i === stages.length - 1} />
        ))}
      </ol>
    </section>
  );
}

function ActivityRowView({ e }: { e: ActivityItem }) {
  const inner = (
    <>
      <div className="ac-meta">
        <time className="ac-time" dateTime={e.at}>{hms(e.at)}</time>
        <span className={`ac-src ac-src-${e.source}`}>{SOURCE_LABEL[e.source] ?? e.source.toUpperCase()}</span>
        {e.classification && e.classification !== "live" ? <span className="ac-cls">{e.classification === "catch_up" ? "catch-up" : e.classification}</span> : null}
      </div>
      <div className="ac-title">{e.title}</div>
      {e.outcome ? <div className="ac-out">{e.outcome}</div> : null}
    </>
  );
  return e.url ? (
    <Link className={`ac-item ac-${e.tone}`} to={e.url}>{inner}</Link>
  ) : (
    <div className={`ac-item ac-${e.tone}`}>{inner}</div>
  );
}

/** Timestamped events recorded by the Worker (plus connection changes seen by this device). Nothing synthetic. */
export function ActivityPanel({ activity }: { activity: ActivityState }) {
  const items = activity.items;
  return (
    <section className="card hp-card" aria-label="Activity">
      <SectionHeader
        title="Activity"
        sub={<span className="ac-legend"><i className="ac-src ac-src-funded">ALPHA PAPER</i><i className="ac-src ac-src-mirror">MIRROR · hypothetical</i><i className="ac-src ac-src-system">SYSTEM</i></span>}
      />
      {items === null ? (
        activity.error ? <EmptyState title="Activity unavailable" tone="warn">{activity.error}</EmptyState> : <SkeletonCards count={2} />
      ) : items.length === 0 ? (
        <EmptyState title="No recorded activity yet">Fills, exits, signals and processed candles appear here as the Worker records them.</EmptyState>
      ) : (
        <>
          {activity.error ? <div className="ac-stale">Not refreshed: {activity.error}</div> : null}
          <AnimatedList className="ac-list" items={items.slice(0, 8)} getKey={(e) => e.id} render={(e) => <ActivityRowView e={e} />} />
        </>
      )}
    </section>
  );
}

import { useState } from "react";
import { ActivityFeed } from "../components/ActivityFeed";
import { EmptyState, SectionHeader, SkeletonCards } from "../components/ui";
import { useDash } from "../store";

/** Category filters come from the recorded events themselves; nothing is generated for display. */
export function ActivityPage() {
  const { state } = useDash();
  const d = state.data;
  const rows = d?.recent.activity ?? [];
  const cats = [...new Set(rows.map((r) => (r.category || "system").toLowerCase()))].sort();
  const [cat, setCat] = useState<string>("all");
  const shown = cat === "all" ? rows : rows.filter((r) => (r.category || "system").toLowerCase() === cat);

  return (
    <div className="page-narrow m-stagger">
      <h1 className="page-title">Activity log</h1>
      {cats.length > 1 ? (
        <div className="chips" role="tablist" aria-label="Filter by category">
          {["all", ...cats].map((c) => (
            <button key={c} type="button" role="tab" aria-selected={cat === c} className={`chip m-press${cat === c ? " on" : ""}`} onClick={() => setCat(c)}>
              {c.toUpperCase()}
            </button>
          ))}
        </div>
      ) : null}
      <section className="card feed-card" aria-label="Activity feed">
        <SectionHeader title="Recorded events" sub="Newest first · as stored by the Worker" right={d ? <span className="count">{shown.length}</span> : null} />
        {!d ? (
          state.status === "loading" ? <SkeletonCards count={4} /> : <EmptyState title="No data" />
        ) : (
          <ActivityFeed rows={shown} />
        )}
      </section>
      <div className="legend" aria-label="Colour key">
        <span className="lg lg-ok">success</span>
        <span className="lg lg-warn">strategy / risk</span>
        <span className="lg lg-bad">error</span>
        <span className="lg lg-muted">information</span>
      </div>
      <p className="hint">
        Signals, risk decisions, dry-run intents and ALPHA PAPER position changes recorded by the Worker (latest {rows.length}).
        The engine's per-candle checks are kept in its own audit file on your PC, not here. Full records are on the Trades tab.
      </p>
    </div>
  );
}

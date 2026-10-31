import { activityTone } from "../classify";
import { hms } from "../fmt";
import type { ActivityRow } from "../types";
import { AnimatedList } from "../motion";
import { EmptyState } from "./ui";

/** Rounded feed of persisted activity_events only. Nothing is generated client-side. */
export function ActivityFeed({ rows, limit }: { rows: ActivityRow[]; limit?: number }) {
  const list = limit ? rows.slice(0, limit) : rows;
  if (list.length === 0) {
    return <EmptyState title="No recorded activity yet.">Events appear here once the Worker records them.</EmptyState>;
  }
  return (
    <AnimatedList
      className="feed"
      items={list}
      getKey={(e) => String(e.id)}
      render={(e) => {
        const ctx = [e.symbol, e.action?.toUpperCase()].filter(Boolean).join(" ");
        return (
          <div className={`feed-item feed-${activityTone(e)}`}>
            <div className="feed-meta">
              <span className="feed-time">{hms(e.ts)}</span>
              <span className="feed-cat">{(e.category || "system").toUpperCase()}</span>
            </div>
            <div className="feed-msg">
              {ctx ? <b>{ctx} </b> : null}
              {e.message}
              {e.error_detail ? <span className="feed-err"> — {e.error_detail}</span> : null}
            </div>
          </div>
        );
      }}
    />
  );
}

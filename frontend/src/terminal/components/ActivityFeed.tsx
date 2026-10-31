import { activityTone } from "../classify";
import { hms } from "../fmt";
import type { ActivityRow } from "../types";
import { EmptyState } from "./ui";

/** Rounded feed of persisted activity_events only. Nothing is generated client-side. */
export function ActivityFeed({ rows, limit }: { rows: ActivityRow[]; limit?: number }) {
  const list = limit ? rows.slice(0, limit) : rows;
  if (list.length === 0) {
    return <EmptyState title="No recorded activity yet.">Events appear here once the Worker records them.</EmptyState>;
  }
  return (
    <ol className="feed" aria-label="Activity">
      {list.map((e) => {
        const ctx = [e.symbol, e.action?.toUpperCase()].filter(Boolean).join(" ");
        return (
          <li key={e.id} className={`feed-item feed-${activityTone(e)}`}>
            <div className="feed-meta">
              <span className="feed-time">{hms(e.ts)}</span>
              <span className="feed-cat">{(e.category || "system").toUpperCase()}</span>
            </div>
            <div className="feed-msg">
              {ctx ? <b>{ctx} </b> : null}
              {e.message}
              {e.error_detail ? <span className="feed-err"> — {e.error_detail}</span> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

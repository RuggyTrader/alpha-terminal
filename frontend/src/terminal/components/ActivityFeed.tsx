import { levelTone } from "../classify";
import { stamp } from "../fmt";
import type { ActivityRow } from "../types";
import { Empty, Panel, SkeletonRows } from "./primitives";

export function ActivityFeed({ rows, loading }: { rows: ActivityRow[] | null; loading: boolean }) {
  return (
    <Panel title="Activity / system log" meta="D1 activity_events" className="tp-log">
      {rows === null ? (
        loading ? <SkeletonRows rows={4} /> : <Empty>No data</Empty>
      ) : rows.length === 0 ? (
        <Empty>No activity events recorded</Empty>
      ) : (
        <ol className="tl" aria-label="Activity log">
          {rows.map((e) => {
            const t = levelTone(e.level);
            const ctx = [e.symbol, e.action?.toUpperCase(), e.alert_id].filter(Boolean).join(" ");
            return (
              <li key={e.id} className={`tl-row tl-${t}`}>
                <span className="tl-ts">{stamp(e.ts)}</span>
                <span className="tl-lvl">{(e.level || "info").toUpperCase().padEnd(5, " ")}</span>
                <span className="tl-cat">{(e.category || "-").toUpperCase()}</span>
                <span className="tl-msg">
                  {e.message}
                  {ctx ? <span className="tl-ctx"> [{ctx}]</span> : null}
                  {e.error_detail ? <span className="tl-err"> — {e.error_detail}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

import { useState } from "react";
import { TopStatus } from "../components/AppShell";
import { ActivityRow } from "../components/trading";
import { Chips, EmptyState, ErrorState, LoadingRows } from "../components/ui";
import { useData } from "../store/DataProvider";
import type { ActivityEvent } from "../types/api";

type F = "all" | "webhook" | "risk" | "broker" | "system";

const MATCH: Record<F, (e: ActivityEvent) => boolean> = {
  all: () => true,
  webhook: (e) => e.category === "WEBHOOK" || e.category === "AUTH",
  risk: (e) => e.category === "RISK",
  broker: (e) => e.category === "BROKER",
  system: (e) => ["SYSTEM", "ENGINE", "SECURITY"].includes(e.category),
};

export function ActivityPage() {
  const { activity } = useData();
  const [f, setF] = useState<F>("all");
  const rows = activity.events.filter(MATCH[f]);
  return (
    <div>
      <TopStatus title="Activity" />
      <Chips value={f} onChange={setF} options={(["all", "webhook", "risk", "broker", "system"] as F[]).map((v) => ({
        value: v, label: v === "all" ? "All" : v[0].toUpperCase() + v.slice(1), count: activity.events.filter(MATCH[v]).length,
      }))} />
      <ErrorState error={activity.error} what="ACTIVITY" />
      {!activity.loaded ? <LoadingRows rows={6} /> : rows.length === 0 ? <EmptyState>NO {f === "all" ? "" : f.toUpperCase() + " "}ACTIVITY YET</EmptyState> : (
        <div className="alog">
          {rows.map((e) => <ActivityRow key={e.id} e={e} fresh={activity.freshIds.has(e.id)} />)}
        </div>
      )}
      <p className="legend">
        <span className="lv-success"><i />success</span>
        <span className="lv-decision"><i />decision</span>
        <span className="lv-error"><i />rejection / error</span>
        <span className="lv-info"><i />info</span>
      </p>
      <p className="footnote">Persisted events only, newest first. Showing the latest {activity.events.length} events (up to 300).</p>
    </div>
  );
}

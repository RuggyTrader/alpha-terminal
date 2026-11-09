import { engineTone } from "../classify";
import type { DashboardData } from "../types";
import { SectionHeader, StatusBadge } from "./ui";

/** Compact, calm system-mode summary. Read-only. */
export function SafetyCard({ data }: { data: DashboardData | null }) {
  const e = data?.engine ?? null;
  const unsafe = !!data && (data.enable_trading || data.broker_submission || data.execution !== "DRY_RUN_ONLY");
  return (
    <section className="card safety" aria-label="System mode">
      <SectionHeader title="System mode" />
      {!data ? (
        <div className="safety-row"><StatusBadge tone="muted">NO DATA</StatusBadge></div>
      ) : (
        <div className="safety-row">
          <StatusBadge tone="info">{data.mode}</StatusBadge>
          <StatusBadge tone={data.execution === "DRY_RUN_ONLY" ? "warn" : "bad"}>
            {data.execution === "DRY_RUN_ONLY" ? "DRY RUN" : data.execution}
          </StatusBadge>
          <StatusBadge tone={e ? engineTone(e.state) : "bad"} title="The separate broker webhook route (/webhook). The OTE engine uses the dry-run route.">BROKER ROUTE {e ? e.state : "N/A"}</StatusBadge>
          <StatusBadge tone={data.broker_submission ? "bad" : "muted"}>BROKER SUBMISSION {data.broker_submission ? "ON" : "OFF"}</StatusBadge>
          {e?.kill_switch ? <StatusBadge tone="bad">KILL SWITCH ENGAGED</StatusBadge> : null}
        </div>
      )}
      {unsafe ? <p className="safety-warn">The backend reports a non-dry-run setting. Check the Worker configuration.</p> : null}
    </section>
  );
}

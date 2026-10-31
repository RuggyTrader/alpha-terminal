import { engineTone } from "../classify";
import { stamp } from "../fmt";
import type { DashboardData } from "../types";
import { Badge, Empty, Panel } from "./primitives";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="ts-row">
      <span className="ts-k">{k}</span>
      <span className="ts-v">{children}</span>
    </div>
  );
}

/** Read-only. There is deliberately no control here that can start execution. */
export function SafetyPanel({ data }: { data: DashboardData | null }) {
  if (!data) {
    return (
      <Panel title="Engine & safety" className="tp-safety">
        <Empty>No data</Empty>
      </Panel>
    );
  }
  const e = data.engine;
  const unsafe = data.enable_trading || data.broker_submission || data.execution !== "DRY_RUN_ONLY";

  return (
    <Panel title="Engine & safety" meta="read-only" className="tp-safety">
      <Row k="Engine">
        {e ? <Badge tone={engineTone(e.state)}>{e.state}</Badge> : <Badge tone="err">STATE MISSING</Badge>}
      </Row>
      <Row k="Kill switch">
        {e ? (e.kill_switch ? <Badge tone="err">ENGAGED</Badge> : <Badge tone="muted">OFF</Badge>) : <Badge tone="muted">N/A</Badge>}
      </Row>
      <Row k="ENABLE_TRADING">
        {data.enable_trading ? <Badge tone="err">TRUE</Badge> : <Badge tone="ok">FALSE · DISABLED</Badge>}
      </Row>
      <Row k="Execution">
        <Badge tone={data.execution === "DRY_RUN_ONLY" ? "warn" : "err"}>{data.execution}</Badge>
      </Row>
      <Row k="Broker submission">
        {data.broker_submission ? <Badge tone="err">ON</Badge> : <Badge tone="ok">OFF</Badge>}
      </Row>
      <Row k="Mode">
        <Badge tone="info">{data.mode}</Badge>
      </Row>
      {e ? (
        <div className="ts-foot mono">
          {e.reason ? `${e.reason} · ` : ""}updated {stamp(e.updated_at)}
          {e.updated_by ? ` · ${e.updated_by}` : ""}
          {e.kill_switch && e.killed_at ? ` · killed ${stamp(e.killed_at)}` : ""}
        </div>
      ) : null}
      {unsafe ? (
        <Empty tone="err">Backend reports a non-dry-run setting. Check the Worker configuration.</Empty>
      ) : null}
      <p className="ts-note">Engine controls are not available in the browser in this phase.</p>
    </Panel>
  );
}

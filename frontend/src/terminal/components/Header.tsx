import { connectionLabel, engineTone } from "../classify";
import { clock } from "../fmt";
import type { FeedState } from "../poller";
import { Badge, LabelBadge } from "./primitives";

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="th-f">
      <span className="th-k">{k}</span>
      {children}
    </span>
  );
}

export function Header({
  state,
  onRefresh,
  onSignOut,
}: {
  state: FeedState;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  const d = state.data;
  const clk = d?.broker.clock ?? null;
  const engine = d?.engine ?? null;
  const conn = connectionLabel(state);

  return (
    <header className="th">
      <div className="th-brand">
        <span className="th-logo" aria-hidden="true">α</span>
        <h1>ALPHA TERMINAL</h1>
        <Badge tone="info" title="Simulated Alpaca PAPER account. No real money.">PAPER</Badge>
        <Badge tone="warn" title="Approved alerts are recorded as dry-run intents only. No broker order is submitted.">
          DRY RUN
        </Badge>
      </div>

      <div className="th-status">
        <Field k="BACKEND">
          <LabelBadge label={conn} />
        </Field>
        <Field k="MARKET">
          {clk ? (
            <Badge tone={clk.is_open ? "ok" : "muted"}>{clk.is_open ? "OPEN" : "CLOSED"}</Badge>
          ) : (
            <Badge tone="muted" title="Alpaca PAPER clock unavailable">N/A</Badge>
          )}
        </Field>
        <Field k="ENGINE">
          {engine ? <Badge tone={engineTone(engine.state)}>{engine.state}</Badge> : <Badge tone="muted">N/A</Badge>}
        </Field>
        <Field k="KILL SWITCH">
          {engine ? (
            engine.kill_switch ? <Badge tone="err">ENGAGED</Badge> : <Badge tone="muted">OFF</Badge>
          ) : (
            <Badge tone="muted">N/A</Badge>
          )}
        </Field>
        <Field k="REFRESHED">
          <span className={`th-time${state.status === "stale" ? " is-stale" : ""}`}>{clock(state.lastSuccessAt)}</span>
        </Field>
      </div>

      <div className="th-actions">
        <button type="button" className="tbtn" onClick={onRefresh} disabled={state.inFlight}>
          {state.inFlight ? "Refreshing…" : "Refresh"}
        </button>
        <button type="button" className="tbtn tbtn-ghost" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}

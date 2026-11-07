import { engineTone } from "../classify";
import { stamp } from "../fmt";
import { EmptyState, SectionHeader } from "../components/ui";
import { AlphaGlobe } from "../components/AlphaGlobe";
import { useFlash } from "../motion";
import { useDash } from "../store";

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  const flash = useFlash(v);
  return (
    <div className={`eng-stat ${flash}`}>
      <span>{k}</span>
      <b key={v} className={`m-crossfade ${tone ? `t-${tone}` : ""}`}>{v}</b>
    </div>
  );
}

/** Read-only engine view. Engine controls are intentionally not available in the browser. */
export function EnginePage() {
  const { state, reconnected } = useDash();
  const d = state.data;
  const e = d?.engine ?? null;
  const c = d?.counts;
  const stateText = e ? e.state : d ? "MISSING" : "N/A";
  const stateFlash = useFlash(e ? e.state : null);

  return (
    <div className="page-narrow m-stagger">
      <h1 className="page-title">Engine</h1>
      <section className="engine-card" aria-label="Alpha engine">
        <AlphaGlobe className="engine-globe" tiltKey={e ? `${e.state}|${e.kill_switch}` : undefined} reconnected={reconnected} />
        <div className="eng-head">
          <div>
            <div className="hero-title">ALPHA ENGINE</div>
            <span className="hero-badge">PAPER EXECUTION</span>
          </div>
        </div>
        <div className="eng-state-label">STATE</div>
        <div className={`eng-state eng-${e ? engineTone(e.state) : "muted"} ${stateFlash}`}>
          <span key={stateText} className="m-crossfade">{stateText}</span>
        </div>
        <div className="eng-grid">
          <Stat k="EXECUTION" v={d ? (d.execution === "DRY_RUN_ONLY" ? "DRY RUN" : d.execution) : "N/A"} />
          <Stat k="BROKER SUBMISSION" v={d ? (d.broker_submission ? "ON" : "OFF") : "N/A"} tone={d?.broker_submission ? "neg" : undefined} />
          <Stat k="ENABLE_TRADING" v={d ? (d.enable_trading ? "TRUE" : "FALSE") : "N/A"} tone={d?.enable_trading ? "neg" : undefined} />
          <Stat k="KILL SWITCH" v={e ? (e.kill_switch ? "ENGAGED" : "OFF") : "N/A"} tone={e?.kill_switch ? "neg" : undefined} />
        </div>
      </section>

      <div className="card note-card">
        <b>Engine controls are intentionally unavailable from the browser.</b>
        <p>
          This dashboard session cannot control the engine. Starting, pausing or stopping the engine and the kill switch are protected
          server-side admin actions.
        </p>
      </div>

      {d && (d.enable_trading || d.broker_submission || d.execution !== "DRY_RUN_ONLY") ? (
        <EmptyState title="Non-dry-run setting reported" tone="bad">Check the Worker configuration.</EmptyState>
      ) : null}

      <section aria-label="Engine details">
        <SectionHeader title="Last change" />
        {e ? (
          <div className="card list-card">
            <div className="li"><span>Updated</span><b className="mono-s">{stamp(e.updated_at)}</b></div>
            <div className="li"><span>By</span><b>{e.updated_by || "N/A"}</b></div>
            <div className="li li-wrap"><span>Reason</span><b>{e.reason || "N/A"}</b></div>
            {e.kill_switch && e.killed_at ? <div className="li"><span>Kill switch set</span><b className="mono-s">{stamp(e.killed_at)}</b></div> : null}
          </div>
        ) : (
          <EmptyState title="No engine record" />
        )}
      </section>

      <section aria-label="Pipeline totals">
        <SectionHeader title="Pipeline totals" right={<span className="muted-s">D1</span>} />
        {c ? (
          <div className="tiles">
            <div className="tile"><span>Alerts</span><b>{c.alerts.total}</b><i>{c.alerts.dry_run} dry-run · {c.alerts.rejected} rejected</i></div>
            <div className="tile"><span>Risk decisions</span><b>{c.risk.total}</b><i>{c.risk.approved} approved · {c.risk.rejected} rejected</i></div>
            <div className="tile"><span>Order intents</span><b>{c.orders.total}</b><i>dry run · none sent to broker</i></div>
            <div className="tile"><span>Duplicates</span><b>{c.alerts.duplicates}</b><i>blocked repeat alerts</i></div>
          </div>
        ) : (
          <EmptyState title="No data" />
        )}
      </section>
    </div>
  );
}

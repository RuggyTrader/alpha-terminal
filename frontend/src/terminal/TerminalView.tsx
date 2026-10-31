// Pure presentation of a FeedState. All data comes from the Worker response;
// when something is missing the panels say so instead of inventing values.

import { clock, stamp } from "./fmt";
import type { FeedState } from "./poller";
import { AccountSummary } from "./components/AccountSummary";
import { ActivityFeed } from "./components/ActivityFeed";
import { AlertsPanel } from "./components/AlertsPanel";
import { Header } from "./components/Header";
import { OrdersPanel } from "./components/OrdersPanel";
import { PositionsPanel } from "./components/PositionsPanel";
import { RiskPanel } from "./components/RiskPanel";
import { SafetyPanel } from "./components/SafetyPanel";
import { TradesPanel } from "./components/TradesPanel";

function StatusBanner({ state, onRefresh }: { state: FeedState; onRefresh: () => void }) {
  const e = state.error;
  if (state.status === "stale" && e) {
    return (
      <div className="tbanner tbanner-warn" role="status">
        <b>STALE DATA</b> Last refresh failed ({e.code}: {e.message}). Showing the last good snapshot from{" "}
        {clock(state.lastSuccessAt)}. Retrying automatically.
      </div>
    );
  }
  if (state.status === "error" && e) {
    return (
      <div className="tbanner tbanner-err" role="alert">
        <b>{e.status === 0 ? "BACKEND UNREACHABLE" : "BACKEND ERROR"}</b> {e.code}: {e.message}. No data has been loaded yet.
        <button type="button" className="tbtn tbtn-sm" onClick={onRefresh}>
          Retry now
        </button>
      </div>
    );
  }
  return null;
}

export function TerminalView({
  state,
  onRefresh,
  onSignOut,
}: {
  state: FeedState;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  const d = state.data;
  const loading = state.status === "loading";
  const r = d?.recent ?? null;

  return (
    <div className={`term${state.status === "stale" ? " term-stale" : ""}`}>
      <Header state={state} onRefresh={onRefresh} onSignOut={onSignOut} />
      <StatusBanner state={state} onRefresh={onRefresh} />

      <main className="tg">
        <div className="tg-top">
          <AccountSummary broker={d?.broker ?? null} loading={loading} />
          <SafetyPanel data={d} />
        </div>
        <PositionsPanel broker={d?.broker ?? null} loading={loading} />
        <AlertsPanel rows={r?.alerts ?? null} counts={d?.counts ?? null} loading={loading} />
        <div className="tg-2">
          <RiskPanel rows={r?.risk ?? null} loading={loading} />
          <OrdersPanel rows={r?.orders ?? null} loading={loading} />
        </div>
        <div className="tg-2">
          <TradesPanel rows={r?.trades ?? null} counts={d?.counts ?? null} loading={loading} />
          <ActivityFeed rows={r?.activity ?? null} loading={loading} />
        </div>
      </main>

      <footer className="tfoot mono">
        PAPER account · DRY RUN only · ALPHA TERMINAL does not submit broker orders in this phase
        {d ? ` · snapshot ${stamp(d.generated_at)}` : ""}
      </footer>
    </div>
  );
}

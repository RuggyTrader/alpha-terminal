import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Icon, Mark, type IconName } from "../components/icons";
import { connectionLabel } from "./classify";
import { clock } from "./fmt";
import { useDash } from "./store";

export function TopBar() {
  const { state, refresh } = useDash();
  const conn = connectionLabel(state);
  return (
    <header className="topbar">
      <div className="tb-id">
        <Mark size={30} />
        <div className="tb-name">
          <b>ALPHA TERMINAL</b>
          <span>PAPER DESK</span>
        </div>
      </div>
      <div className="tb-right">
        <span className={`conn conn-${conn.tone}`} title={state.lastSuccessAt ? `Last update ${clock(state.lastSuccessAt)}` : undefined}>
          <i aria-hidden />
          {conn.text}
        </span>
        <button
          type="button"
          className={`icon-btn ${state.inFlight ? "is-spinning" : ""}`}
          onClick={refresh}
          disabled={state.inFlight}
          aria-label="Refresh"
          title="Refresh"
        >
          <Icon name="refresh" size={18} />
        </button>
      </div>
    </header>
  );
}

function Banners() {
  const { state, refresh, signOut, doSignOut, dismissSignOut } = useDash();
  const e = state.error;
  return (
    <>
      {signOut.error ? (
        <div className="banner banner-bad" role="alert">
          <div>
            <b>Sign-out failed</b>
            <p>{signOut.error}</p>
          </div>
          <div className="banner-actions">
            <button type="button" className="btn btn-sm" onClick={doSignOut} disabled={signOut.busy}>Retry sign out</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={dismissSignOut}>Dismiss</button>
          </div>
        </div>
      ) : null}
      {state.status === "stale" && e ? (
        <div className="banner banner-warn" role="status">
          <div>
            <b>Showing data from {clock(state.lastSuccessAt)}</b>
            <p>The last refresh failed ({e.code}). Retrying automatically.</p>
          </div>
        </div>
      ) : null}
      {state.status === "error" && e ? (
        <div className="banner banner-bad" role="alert">
          <div>
            <b>{e.status === 0 ? "Backend unreachable" : "Backend error"}</b>
            <p>{e.code}: {e.message}. No data has been loaded.</p>
          </div>
          <div className="banner-actions">
            <button type="button" className="btn btn-sm" onClick={refresh}>Retry</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "Home", icon: "home", end: true },
  { to: "/trades", label: "Trades", icon: "trades" },
  { to: "/engine", label: "Engine", icon: "bolt" },
  { to: "/activity", label: "Activity", icon: "activity" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

export function BottomNav() {
  return (
    <nav className="bnav" aria-label="Main">
      <div className="bnav-in">
        {NAV.map((n) =>
          n.to === "/engine" ? (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `bnav-engine${isActive ? " on" : ""}`}>
              <Icon name="bolt" size={15} fill />
              <span>Engine</span>
            </NavLink>
          ) : (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `bnav-item${isActive ? " on" : ""}`}>
              <Icon name={n.icon} size={22} />
              <span>{n.label}</span>
            </NavLink>
          ),
        )}
      </div>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  return (
    <div className="shell">
      <div className="shell-in">
        <TopBar />
        <Banners />
        <main className="page" key={loc.pathname.split("/")[1] || "home"}>
          {children}
        </main>
        <footer className="foot">PAPER account · dry run only · no broker orders are submitted</footer>
      </div>
      <BottomNav />
    </div>
  );
}

import { AssistantDrawer } from "./components/Assistant";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Icon, Mark, type IconName } from "../components/icons";
import { connectionLabel } from "./classify";
import { clock } from "./fmt";
import { markPageEntry, Presence } from "./motion";
import { useDash } from "./store";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

// DEMO_UI_REPLAY controls (tools/demo-replay) exist only in a Vite dev server started
// with VITE_DEMO_UI=1. `import.meta.env.DEV` is false in production builds, so this
// branch and the demo module are removed from the bundle entirely, whatever
// VITE_DEMO_UI is set to. As a second guard the overlay only renders on localhost.
const DemoOverlay = import.meta.env.DEV && import.meta.env.VITE_DEMO_UI === "1" ? lazy(() => import("./demo/DemoOverlay")) : null;
const demoHost = typeof window !== "undefined" && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname);

export function TopBar() {
  const { state, refresh, reconnected } = useDash();
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
        <span
          className={`conn conn-${conn.tone} ${reconnected ? "is-reconnected" : ""}`}
          title={state.lastSuccessAt ? `Last update ${clock(state.lastSuccessAt)}` : undefined}
        >
          <i aria-hidden />
          <span key={conn.text} className="m-crossfade">{conn.text}</span>
        </span>
        <button
          type="button"
          className={`icon-btn m-press ${state.inFlight ? "is-spinning" : ""}`}
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
      <Presence show={!!signOut.error}>
        <div className="banner banner-bad" role="alert">
          <div>
            <b>Sign-out failed</b>
            <p>{signOut.error}</p>
          </div>
          <div className="banner-actions">
            <button type="button" className="btn btn-sm m-press" onClick={doSignOut} disabled={signOut.busy}>Retry sign out</button>
            <button type="button" className="btn btn-sm btn-ghost m-press" onClick={dismissSignOut}>Dismiss</button>
          </div>
        </div>
      </Presence>
      <Presence show={state.status === "stale" && !!e}>
        <div className="banner banner-warn" role="status">
          <div>
            <b>Showing data from {clock(state.lastSuccessAt)}</b>
            <p>The last refresh failed ({e?.code}). Retrying automatically.</p>
          </div>
        </div>
      </Presence>
      <Presence show={state.status === "error" && !!e}>
        <div className="banner banner-bad" role="alert">
          <div>
            <b>{e?.status === 0 ? "Backend unreachable" : "Backend error"}</b>
            <p>{e?.code}: {e?.message}. No data has been loaded.</p>
          </div>
          <div className="banner-actions">
            <button type="button" className="btn btn-sm m-press" onClick={refresh}>Retry</button>
          </div>
        </div>
      </Presence>
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

function activeIndex(pathname: string): number {
  const first = pathname.split("/")[1] ?? "";
  const seg = "/" + (first === "mirror" || first === "bots" ? "engine" : first); // Strategy Mirror and Bots are reached from the Engine page
  const i = NAV.findIndex((n) => n.to === seg);
  return i < 0 ? 0 : i;
}

/** Bottom nav with one shared indicator that slides to the active item. */
export function BottomNav() {
  const loc = useLocation();
  const inner = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<CSSProperties>({});
  const idx = activeIndex(loc.pathname);

  useIsoLayoutEffect(() => {
    const place = () => {
      const box = inner.current;
      const el = box?.querySelectorAll<HTMLElement>("[data-nav]")[idx];
      if (!box || !el) return;
      const engine = NAV[idx].to === "/engine";
      const x = el.offsetLeft + el.offsetWidth / 2 - 11;
      // The orange Engine pill carries its own active ring, so the bar hides there.
      setInd({ ["--x" as string]: `${x}px`, ["--o" as string]: engine ? 0 : 1 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [idx]);

  return (
    <nav className="bnav" aria-label="Main">
      <div className="bnav-in" ref={inner}>
        <i className="bnav-ind" style={ind} aria-hidden />
        {NAV.map((n) =>
          n.to === "/engine" ? (
            <NavLink key={n.to} to={n.to} data-nav className={({ isActive }) => `bnav-engine m-press${isActive ? " on" : ""}`}>
              <Icon name="bolt" size={15} fill />
              <span>Engine</span>
            </NavLink>
          ) : (
            <NavLink key={n.to} to={n.to} end={n.end} data-nav className={({ isActive }) => `bnav-item${isActive ? " on" : ""}`}>
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
  const section = loc.pathname.split("/")[1] || "home";
  useEffect(() => {
    markPageEntry();
  }, [section]);
  return (
    <div className="shell">
      <div className="shell-in">
        {DemoOverlay && demoHost ? (
          <Suspense fallback={null}>
            <DemoOverlay />
          </Suspense>
        ) : null}
        <TopBar />
        <Banners />
        <main className="page" key={section}>
          {children}
        </main>
        <footer className="foot">PAPER account · dry run only · no broker orders are submitted</footer>
      </div>
      <AssistantDrawer />
      <BottomNav />
    </div>
  );
}

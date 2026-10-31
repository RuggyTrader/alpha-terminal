// One shared dashboard store for every page: a single refresh loop, so
// switching tabs never refetches or flashes loaders.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { logout } from "./api";
import type { FeedState } from "./poller";
import { idleSignOut, performSignOut, type SignOutState } from "./signOut";
import { useDashboard } from "./useDashboard";

export interface DashboardContextValue {
  state: FeedState;
  refresh: () => void;
  signOut: SignOutState;
  doSignOut: () => void;
  dismissSignOut: () => void;
  /** True for a moment after the backend recovers from stale/offline (drives a brief pulse). */
  reconnected: boolean;
}

/** Brief true window when the feed goes from stale/error back to ok. */
export function useReconnected(status: FeedState["status"]): boolean {
  const prev = useRef(status);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const was = prev.current;
    prev.current = status;
    if (status === "ok" && (was === "stale" || was === "error")) {
      setOn(true);
      const t = window.setTimeout(() => setOn(false), 1800);
      return () => window.clearTimeout(t);
    }
  }, [status]);
  return on;
}

export const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDash(): DashboardContextValue {
  const v = useContext(DashboardContext);
  if (!v) throw new Error("useDash must be used inside DashboardProvider");
  return v;
}

export function DashboardProvider({
  onSignedOut,
  onExpired,
  children,
}: {
  onSignedOut: () => void;
  onExpired: () => void;
  children: ReactNode;
}) {
  const { state, refresh } = useDashboard(onExpired);
  const [signOut, setSignOut] = useState<SignOutState>(idleSignOut);
  const reconnected = useReconnected(state.status);

  const doSignOut = async () => {
    if (signOut.busy) return;
    setSignOut({ busy: true, error: null });
    const result = await performSignOut(logout);
    // Only leave the signed-in UI once the server confirmed the session is gone.
    if (result.ok) onSignedOut();
    else setSignOut({ busy: false, error: result.message });
  };

  return (
    <DashboardContext.Provider
      value={{ state, refresh, signOut, doSignOut: () => void doSignOut(), dismissSignOut: () => setSignOut(idleSignOut), reconnected }}
    >
      {children}
    </DashboardContext.Provider>
  );
}

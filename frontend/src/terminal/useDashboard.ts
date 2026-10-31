import { useEffect, useState, useSyncExternalStore } from "react";
import { fetchDashboard } from "./api";
import { DashboardPoller, type FeedState } from "./poller";

/** Starts the dashboard refresh loop for the lifetime of the component. */
export function useDashboard(onUnauthorized: () => void): { state: FeedState; refresh: () => void } {
  const [poller] = useState(() => new DashboardPoller(() => fetchDashboard(), { onUnauthorized }));
  const state = useSyncExternalStore(poller.subscribe, poller.getState);

  useEffect(() => {
    poller.start();
    // Pause while the tab is hidden; refresh as soon as it is visible again.
    const onVisibility = () => {
      if (document.hidden) poller.stop();
      else poller.start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
    };
  }, [poller]);

  return { state, refresh: () => void poller.refresh() };
}

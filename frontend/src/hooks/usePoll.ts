import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

export interface PollState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  updatedAt: Date | null;
  refresh: () => Promise<void>;
}

/** Fetch now and every `intervalMs` while the tab is visible. Never invents data:
 * on error the previous value is kept but `error` is set so the UI can say so. */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[] = []): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      const value = await fetchRef.current();
      setData(value);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, intervalMs]);

  return { data, error, loading, updatedAt, refresh };
}

// iOS-style banners that slide down from the top. Fed only by real persisted
// events (see lib/derive.ts toastForEvent) and real milestones.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ToastSpec } from "../lib/derive";
import { Mark } from "./icons";

interface ToastApi { push: (t: ToastSpec) => void }
const Ctx = createContext<ToastApi>({ push: () => undefined });

const SHOW_MS = 3400;
const MAX_QUEUE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<ToastSpec[]>([]);
  const [current, setCurrent] = useState<(ToastSpec & { extra: number }) | null>(null);
  const [leaving, setLeaving] = useState(false);
  const seen = useRef(new Set<string>());

  const push = useCallback((t: ToastSpec) => {
    if (seen.current.has(t.key)) return;
    seen.current.add(t.key);
    setQueue((q) => [...q, t]);
  }, []);

  useEffect(() => {
    if (current || queue.length === 0) return;
    // Don't spam: show the first, fold the rest of a burst into "+N more".
    const [next, ...rest] = queue;
    const dropped = Math.max(0, rest.length - (MAX_QUEUE - 1));
    setQueue(rest.slice(dropped));
    setCurrent({ ...next, extra: dropped });
    setLeaving(false);
  }, [queue, current]);

  useEffect(() => {
    if (!current) return;
    const a = window.setTimeout(() => setLeaving(true), SHOW_MS);
    const b = window.setTimeout(() => setCurrent(null), SHOW_MS + 320);
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, [current]);

  const api = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-host" aria-live="polite">
        {current && (
          <div className={`toast tone-${current.tone}${leaving ? " leaving" : ""}`} key={current.key}
            onClick={() => setLeaving(true)} role="status">
            <span className="toast-icon"><Mark size={20} /></span>
            <span className="toast-text">
              <b>{current.title}</b>
              <span>{current.body}{current.extra ? ` · +${current.extra} more` : ""}</span>
            </span>
            <span className="toast-time">now</span>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

export function useToasts(): ToastApi {
  return useContext(Ctx);
}

// Small motion helpers for the terminal. No animation library: CSS classes from
// motion.css plus a few hooks. Nothing here ever invents a value: numbers animate
// only from the previous real value to the new real value.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export const MOTION = { fast: 160, normal: 250, slow: 480, flash: 900 } as const;

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// Last value shown per id survives remounts, so revisiting a page never re-animates.
const lastShown = new Map<string, number>();

/** Test helper: forget remembered values. */
export function resetMotionMemory(): void {
  lastShown.clear();
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Shows `value` formatted. When a real value changes, rolls from the previous real
 * value over ~480 ms. First render shows the value directly (never from zero).
 * Reduced motion: updates instantly.
 */
export function AnimatedNumber({
  id,
  value,
  format,
  className = "",
  duration = MOTION.slow,
}: {
  id: string;
  value: number;
  format: (n: number) => string;
  className?: string;
  duration?: number;
}) {
  const [shown, setShown] = useState<number>(() => lastShown.get(id) ?? value);
  const [changing, setChanging] = useState(false);
  const raf = useRef<number>();

  useEffect(() => {
    const from = lastShown.get(id);
    lastShown.set(id, value);
    const hidden = typeof document !== "undefined" && document.hidden;
    if (from === undefined || from === value || hidden || prefersReducedMotion()) {
      setShown(value);
      return;
    }
    setChanging(true);
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      setShown(from + (value - from) * easeOutCubic(k));
      if (k < 1) raf.current = requestAnimationFrame(step);
      else setChanging(false);
    };
    raf.current = requestAnimationFrame(step);
    // Animation frames pause in background tabs; always land on the real value.
    const settle = window.setTimeout(() => {
      if (raf.current) cancelAnimationFrame(raf.current);
      setShown(value);
      setChanging(false);
    }, duration + 80);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      window.clearTimeout(settle);
    };
  }, [id, value, duration]);

  return <span className={`m-num ${changing ? "is-changing" : ""} ${className}`}>{format(shown)}</span>;
}

export type FlashClass = "" | "m-flash-up" | "m-flash-down" | "m-flash-neutral";

/**
 * Returns a highlight class for ~900 ms after `value` changes (never on first render).
 * Numbers flash green when up, red when down; other values flash neutral.
 */
export function useFlash(value: unknown): FlashClass {
  const prev = useRef<unknown>(value);
  const [cls, setCls] = useState<FlashClass>("");
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (Object.is(before, value) || before === undefined || before === null || value === null || value === undefined) return;
    const next: FlashClass =
      typeof before === "number" && typeof value === "number" ? (value > before ? "m-flash-up" : value < before ? "m-flash-down" : "") : "m-flash-neutral";
    if (!next || prefersReducedMotion()) return;
    // Restart the highlight even if the previous one is still showing.
    setCls("");
    const a = window.setTimeout(() => setCls(next), 16);
    const t = window.setTimeout(() => setCls(""), MOTION.flash + 16);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(t);
    };
  }, [value]);
  return cls;
}

/** True for one short window after `value` changes (not on first render). */
export function useChanged(value: unknown, ms: number = MOTION.slow): boolean {
  const prev = useRef<unknown>(value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    setOn(true);
    const t = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return on;
}

export interface PresenceItem<T> {
  item: T;
  key: string;
  /** "initial" = present on first render; "new" = arrived later; "leaving" = removed, animating out. */
  phase: "initial" | "new" | "leaving";
}

/**
 * Keeps removed items for a moment so they can animate out, and marks items that
 * arrive after the first render so they can get a one-time accent.
 */
export function usePresence<T>(items: T[], getKey: (t: T) => string, exitMs: number = MOTION.normal): PresenceItem<T>[] {
  const firstKeys = useRef<Set<string> | null>(null);
  if (firstKeys.current === null) firstKeys.current = new Set(items.map(getKey));
  const [leaving, setLeaving] = useState<Map<string, { item: T; index: number }>>(() => new Map());
  const prevItems = useRef<T[]>(items);

  useEffect(() => {
    const now = new Set(items.map(getKey));
    const gone = new Map<string, { item: T; index: number }>();
    prevItems.current.forEach((it, index) => {
      const k = getKey(it);
      if (!now.has(k)) gone.set(k, { item: it, index });
    });
    prevItems.current = items;
    if (gone.size === 0 || prefersReducedMotion()) return;
    setLeaving((m) => new Map([...m, ...gone]));
    const t = window.setTimeout(() => {
      setLeaving((m) => {
        const next = new Map(m);
        gone.forEach((_, k) => next.delete(k));
        return next;
      });
    }, exitMs);
    return () => window.clearTimeout(t);
  }, [items, exitMs]);

  const out: PresenceItem<T>[] = items.map((item) => {
    const key = getKey(item);
    return { item, key, phase: firstKeys.current!.has(key) ? "initial" : "new" };
  });
  leaving.forEach(({ item, index }, key) => {
    if (out.some((o) => o.key === key)) return;
    out.splice(Math.min(index, out.length), 0, { item, key, phase: "leaving" });
  });
  return out;
}

export function presenceClass(phase: PresenceItem<unknown>["phase"]): string {
  return phase === "new" ? "m-item is-new" : phase === "leaving" ? "m-item is-leaving" : "m-item";
}

/** Mounts children with an enter animation and keeps them briefly for an exit animation. */
export function Presence({ show, children, className = "" }: { show: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(show);
  const [leaving, setLeaving] = useState(false);
  const last = useRef<ReactNode>(children);
  if (show) last.current = children;

  useEffect(() => {
    if (show) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    setLeaving(true);
    const t = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, MOTION.fast);
    return () => window.clearTimeout(t);
  }, [show]);

  if (!mounted && !show) return null;
  return <div className={`${className} ${leaving ? "m-banner-out" : "m-banner-in"}`}>{show ? children : last.current}</div>;
}

/**
 * Reveals a lower section once when it scrolls into view. Content is only hidden
 * after mount, only if it starts below the viewport, and only while JS runs, so
 * server rendering, tests and reduced motion always show it.
 */
export function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"shown" | "pending" | "in">("shown");

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof IntersectionObserver === "undefined") return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return; // already visible: no reveal
    setState("pending");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState("in");
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    // Never leave content hidden: reveal after 2 s even if the observer never fires.
    const t = window.setTimeout(() => setState((s) => (s === "pending" ? "in" : s)), 2000);
    return () => {
      io.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  const cls = state === "pending" ? "m-reveal-pending" : state === "in" ? "m-reveal-in" : "";
  return (
    <div ref={ref} className={`${cls} ${className}`}>
      {children}
    </div>
  );
}

/**
 * List whose first items stagger in once, later real arrivals slide in with a brief
 * accent, and removed items fade out. Data refreshes with the same keys do not replay.
 */
export function AnimatedList<T>({
  items,
  getKey,
  render,
  className = "stack",
}: {
  items: T[];
  getKey: (t: T) => string;
  render: (t: T) => ReactNode;
  className?: string;
}) {
  const list = usePresence(items, getKey);
  let initialIndex = 0;
  return (
    <div className={className}>
      {list.map((p) => {
        const style = p.phase === "initial" ? ({ "--i": Math.min(initialIndex++, 6) } as CSSProperties) : undefined;
        return (
          <div key={p.key} className={presenceClass(p.phase)} style={style}>
            {render(p.item)}
          </div>
        );
      })}
    </div>
  );
}

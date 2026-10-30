// Small, dependency-free motion helpers: count-up numbers, FLIP list moves,
// and the milestone particle burst.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

// Last value shown per id survives remounts, so revisiting a tab never
// re-animates from zero.
const lastShown = new Map<string, number>();

function easeOut(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

export function CountUpValue({ id, value, format, className, duration = 650 }: {
  id: string; value: number | null; format: (n: number) => string; className?: string; duration?: number;
}) {
  const prev = lastShown.get(id);
  const [shown, setShown] = useState<number | null>(value === null ? null : prev ?? value);
  const [pulse, setPulse] = useState<"" | "up" | "down">("");
  const raf = useRef<number>();

  useEffect(() => {
    if (value === null) {
      setShown(null);
      return;
    }
    const from = lastShown.get(id);
    lastShown.set(id, value);
    if (from === undefined || from === value) {
      setShown(value);
      return;
    }
    setPulse(value > from ? "up" : "down");
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      setShown(from + (value - from) * easeOut(k));
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    const clear = window.setTimeout(() => setPulse(""), 900);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); window.clearTimeout(clear); };
  }, [id, value, duration]);

  return (
    <span className={[className, pulse && `pulse-${pulse}`].filter(Boolean).join(" ")}>
      {shown === null ? "N/A" : format(shown)}
    </span>
  );
}

/** Animate children marked with data-flip="key" from their old to new position. */
export function useFlip(ref: RefObject<HTMLElement>, signature: string): Set<string> {
  const prev = useRef<Map<string, { x: number; y: number }> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number }>();
    const entered: string[] = [];
    root.querySelectorAll<HTMLElement>("[data-flip]").forEach((node) => {
      const key = node.dataset.flip!;
      const r = node.getBoundingClientRect();
      const pos = { x: r.left - base.left, y: r.top - base.top };
      next.set(key, pos);
      const old = prev.current?.get(key);
      if (old && (old.x !== pos.x || old.y !== pos.y)) {
        node.animate?.([{ transform: `translate(${old.x - pos.x}px, ${old.y - pos.y}px)` }, { transform: "none" }],
          { duration: 480, easing: "cubic-bezier(.2,.8,.2,1)" });
      } else if (!old && prev.current) {
        entered.push(key);
        node.animate?.([{ opacity: 0, transform: "translateY(10px) scale(.94)" }, { opacity: 1, transform: "none" }],
          { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    });
    prev.current = next;
    if (entered.length) {
      setFresh(new Set(entered));
      const t = window.setTimeout(() => setFresh(new Set()), 2400);
      return () => window.clearTimeout(t);
    }
  }, [ref, signature]);

  return fresh;
}

const COLORS = ["#F2661B", "#14A35B", "#3A6FF2", "#8B5CF6", "#E5A50A", "#E0457B"];

/** Short particle burst, shown only when `trigger` increments (a real milestone). */
export function Celebration({ trigger }: { trigger: number }) {
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (trigger === 0) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setRun(trigger);
    const t = window.setTimeout(() => setRun(0), 2200);
    return () => window.clearTimeout(t);
  }, [trigger]);
  if (!run) return null;
  const bits = Array.from({ length: 42 }, (_, i) => {
    const left = (i * 37) % 100;
    const delay = (i % 7) * 60;
    const drift = ((i * 53) % 80) - 40;
    const rot = (i * 97) % 360;
    return (
      <i key={i} style={{
        left: `${left}%`, background: COLORS[i % COLORS.length], animationDelay: `${delay}ms`,
        ["--drift" as string]: `${drift}px`, ["--rot" as string]: `${rot + 360}deg`,
        width: i % 3 ? 6 : 4, height: i % 3 ? 10 : 12,
      }} />
    );
  });
  return <div className="confetti" aria-hidden key={run}>{bits}</div>;
}

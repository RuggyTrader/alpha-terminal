import { useEffect, useId, useState, type ReactNode } from "react";
import { Icon } from "../../components/icons";
import type { Label, Tone } from "../classify";
import { MOTION, prefersReducedMotion, useChanged } from "../motion";

export function StatusBadge({ tone = "muted", children, title, dot = false, className = "" }: { tone?: Tone; children: ReactNode; title?: string; dot?: boolean; className?: string }) {
  return (
    <span className={`sb sb-${tone} ${className}`} title={title}>
      {dot ? <i className="sb-dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

/** Status badge that scales in once when its state actually changes (not on first render). */
export function LabelBadge({ label }: { label: Label | null }) {
  const changed = useChanged(label?.text ?? null);
  return label ? <StatusBadge tone={label.tone} className={changed ? "m-pop" : ""}>{label.text}</StatusBadge> : null;
}

export function SectionHeader({ title, right, sub }: { title: string; right?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="sh">
      <div className="sh-l">
        <h2>{title}</h2>
        {sub ? <div className="sh-sub">{sub}</div> : null}
      </div>
      {right ? <div className="sh-r">{right}</div> : null}
    </div>
  );
}

export function Card({ children, className = "", tone }: { children: ReactNode; className?: string; tone?: Tone }) {
  return <div className={`card ${tone ? `card-${tone}` : ""} ${className}`}>{children}</div>;
}

/** Intentional, truthful empty state. Never a placeholder number. */
export function EmptyState({ title, children, tone = "muted" }: { title: string; children?: ReactNode; tone?: Tone }) {
  return (
    <div className={`empty empty-${tone} m-fade`}>
      <div className="empty-t">{title}</div>
      {children ? <div className="empty-s">{children}</div> : null}
    </div>
  );
}

export function SkeletonCards({ count = 2, tall = false }: { count?: number; tall?: boolean }) {
  return (
    <div className="skel-list m-fade" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`skel ${tall ? "skel-tall" : ""}`} />
      ))}
    </div>
  );
}

/**
 * Card whose technical details stay hidden until tapped. Details open with a smooth
 * height + opacity accordion and close the same way before unmounting. Closed details
 * are not rendered, so they are never hidden-but-present.
 */
export function Expandable({
  head,
  children,
  tone,
  defaultOpen = false,
  className = "",
}: {
  head: ReactNode;
  children: ReactNode;
  tone?: Tone;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [phase, setPhase] = useState<"idle" | "entering" | "closing">("idle");
  const id = useId();

  useEffect(() => {
    if (phase === "idle") return;
    const t = window.setTimeout(() => {
      if (phase === "closing") setOpen(false);
      setPhase("idle");
    }, phase === "closing" ? MOTION.fast : MOTION.normal + 120);
    return () => window.clearTimeout(t);
  }, [phase]);

  const toggle = () => {
    const reduce = prefersReducedMotion();
    if (open && phase !== "closing") {
      if (reduce) setOpen(false);
      else setPhase("closing");
    } else {
      setOpen(true);
      setPhase(reduce ? "idle" : "entering");
    }
  };

  const expanded = open && phase !== "closing";
  return (
    <div className={`xc m-lift ${tone ? `xc-${tone}` : ""} ${expanded ? "is-open" : ""} ${className}`}>
      <button type="button" className="xc-head m-press" aria-expanded={expanded} aria-controls={id} onClick={toggle}>
        <div className="xc-main">{head}</div>
        <span className="xc-chev" aria-hidden>
          <Icon name="chevron" size={16} />
        </span>
      </button>
      {open ? (
        <div className={`xc-body-wrap ${phase === "entering" ? "is-entering" : phase === "closing" ? "is-closing" : ""}`} id={id}>
          <div className="xc-body-inner">
            <div className="xc-body">{children}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Label/value rows for details. */
export function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Technical identifier: monospace, wraps anywhere instead of overflowing. */
export function Code({ children }: { children: string | null | undefined }) {
  return children ? <code className="code">{children}</code> : <span className="na">N/A</span>;
}

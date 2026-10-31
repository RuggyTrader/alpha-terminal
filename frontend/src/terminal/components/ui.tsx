import { useId, useState, type ReactNode } from "react";
import { Icon } from "../../components/icons";
import type { Label, Tone } from "../classify";

export function StatusBadge({ tone = "muted", children, title, dot = false }: { tone?: Tone; children: ReactNode; title?: string; dot?: boolean }) {
  return (
    <span className={`sb sb-${tone}`} title={title}>
      {dot ? <i className="sb-dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function LabelBadge({ label }: { label: Label | null }) {
  return label ? <StatusBadge tone={label.tone}>{label.text}</StatusBadge> : null;
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
    <div className={`empty empty-${tone}`}>
      <div className="empty-t">{title}</div>
      {children ? <div className="empty-s">{children}</div> : null}
    </div>
  );
}

export function SkeletonCards({ count = 2, tall = false }: { count?: number; tall?: boolean }) {
  return (
    <div className="skel-list" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`skel ${tall ? "skel-tall" : ""}`} />
      ))}
    </div>
  );
}

/** Card whose technical details stay hidden until tapped. */
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
  const id = useId();
  return (
    <div className={`xc ${tone ? `xc-${tone}` : ""} ${open ? "is-open" : ""} ${className}`}>
      <button type="button" className="xc-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <div className="xc-main">{head}</div>
        <span className="xc-chev" aria-hidden>
          <Icon name="chevron" size={16} />
        </span>
      </button>
      {open ? (
        <div className="xc-body" id={id}>
          {children}
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

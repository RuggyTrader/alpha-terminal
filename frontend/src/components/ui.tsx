import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./icons";

export type Tone = "green" | "orange" | "red" | "gray" | "dark";

export function statusTone(status: string | null | undefined): Tone {
  switch ((status ?? "").toUpperCase().replace(/_/g, " ")) {
    case "HEALTHY": case "ONLINE": case "RUNNING": case "ACTIVE": case "CURRENT": case "ACCEPTED": case "FILLED":
    case "VERIFIED PAPER": case "READY": case "CONNECTED": case "CLOSED WIN":
      return "green";
    case "PAUSED": case "STALE": case "DEGRADED": case "PAPER ORDER": case "PARTIALLY FILLED": case "NEW": case "ACCEPTED FOR BIDDING":
    case "PENDING NEW": case "UNKNOWN": case "DUPLICATE": case "OPEN": case "SUBMITTING":
      return "orange";
    case "OFFLINE": case "ERROR": case "REJECTED": case "BROKER REJECTED": case "FAILED": case "CANCELED": case "EXPIRED":
    case "UNAVAILABLE": case "KILL SWITCH":
      return "red";
    default:
      return "gray";
  }
}

export function Badge({ tone = "gray", dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{dot && <span className="dot" />}{children}</span>;
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  return <Badge tone={statusTone(status)} dot>{(status ?? "N/A").replace(/_/g, " ").toUpperCase()}</Badge>;
}

export function Section({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={["section", className].filter(Boolean).join(" ")}>
      <div className="section-head"><h2>{title}</h2>{right && <span className="section-right">{right}</span>}</div>
      {children}
    </section>
  );
}

export function SegmentControl<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  const i = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="segment" role="tablist" style={{ ["--n" as string]: options.length }}>
      <span className="segment-pill" style={{ transform: `translateX(${i * 100}%)` }} />
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={o.value} className={`chip${o.value === value ? " on" : ""}`} onClick={() => onChange(o.value)}>
          {o.label}{o.count !== undefined && <span className="chip-n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ children, small }: { children: ReactNode; small?: boolean }) {
  return <div className={`empty${small ? " small" : ""}`}>{children}</div>;
}

export function Skeleton({ h = 14, w = "100%", r = 8 }: { h?: number; w?: number | string; r?: number }) {
  return <span className="skeleton" style={{ height: h, width: w, borderRadius: r }} />;
}

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="loading-rows">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={40} r={12} />)}
    </div>
  );
}

export function ErrorState({ error, what = "DATA" }: { error: { status?: number; message: string } | null; what?: string }) {
  if (!error) return null;
  const label = error.status === 0 ? "CONNECTION ERROR" : `${what} UNAVAILABLE`;
  return <div className="error-state"><span className="dot" />{label}<span className="error-msg">{error.status === 0 ? "Backend unreachable" : error.message}</span></div>;
}

export function StaleNote({ error, updatedAt }: { error: unknown; updatedAt: number | null }) {
  if (!error || !updatedAt) return null;
  const t = new Date(updatedAt).toLocaleTimeString("en-GB", { hour12: false });
  return <span className="stale-note">STALE · last update {t}</span>;
}

/** iOS grouped list. */
export function SettingsGroup({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="sgroup">
      <h3>{title}</h3>
      <div className="sgroup-body">{children}</div>
      {footer && <p className="sgroup-foot">{footer}</p>}
    </section>
  );
}

export function SRow({ k, v, cls, mono, onClick }: { k: ReactNode; v: ReactNode; cls?: string; mono?: boolean; onClick?: () => void }) {
  return (
    <div className={`srow${onClick ? " tap" : ""}`} onClick={onClick}>
      <span className="srow-k">{k}</span>
      <span className={["srow-v", cls, mono && "mono"].filter(Boolean).join(" ")}>{v}</span>
      {onClick && <span className="srow-chev"><Icon name="chevron" size={16} /></span>}
    </div>
  );
}

/** Bottom sheet confirmation for consequential actions. */
export function ConfirmSheet({ open, title, body, confirm, danger, onConfirm, onClose }: {
  open: boolean; title: string; body: ReactNode; confirm: string; danger?: boolean;
  onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) setBusy(false); }, [open]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grip" />
        <h3>{title}</h3>
        <div className="sheet-body">{body}</div>
        <button className={`btn ${danger ? "danger" : "primary"} block`} disabled={busy}
          onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); onClose(); } }}>
          {busy ? "WORKING…" : confirm}
        </button>
        <button className="btn ghost block" onClick={onClose}>CANCEL</button>
      </div>
    </div>
  );
}

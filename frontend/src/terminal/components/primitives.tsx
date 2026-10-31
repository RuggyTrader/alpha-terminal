import { Fragment, useState, type ReactNode } from "react";
import type { Label, Tone } from "../classify";

export function Badge({ tone = "muted", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`tb tb-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function LabelBadge({ label }: { label: Label | null }) {
  return label ? <Badge tone={label.tone}>{label.text}</Badge> : null;
}

export function Panel({
  title,
  meta,
  right,
  notice,
  className,
  children,
}: {
  title: string;
  meta?: ReactNode;
  right?: ReactNode;
  notice?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`tp ${className ?? ""}`}>
      <header className="tp-head">
        <h2>{title}</h2>
        {meta ? <span className="tp-meta">{meta}</span> : null}
        <span className="tp-right">{right}</span>
      </header>
      {notice ? <div className="tp-notice">{notice}</div> : null}
      <div className="tp-body">{children}</div>
    </section>
  );
}

/** Truthful placeholder for missing data: never a fake number. */
export function Empty({ children, tone = "muted" }: { children: ReactNode; tone?: Tone }) {
  return <div className={`t-empty t-empty-${tone}`}>{children}</div>;
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="t-skel" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="t-skel-row" />
      ))}
    </div>
  );
}

/** Text that truncates with an ellipsis and shows the full value on hover. */
export function Clip({ children, mono = false, width }: { children: string | null | undefined; mono?: boolean; width?: number }) {
  const v = children ?? "";
  if (!v) return <span className="t-na">—</span>;
  return (
    <span className={`t-clip${mono ? " mono" : ""}`} title={v} style={width ? { maxWidth: width } : undefined}>
      {v}
    </span>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowClass,
  empty,
  expand,
  label,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  rowClass?: (row: T) => string;
  empty: ReactNode;
  expand?: (row: T) => ReactNode;
  label: string;
}) {
  const [open, setOpen] = useState<Set<string | number>>(() => new Set());
  if (rows.length === 0) return <>{empty}</>;
  const toggle = (k: string | number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const span = columns.length + (expand ? 1 : 0);
  return (
    <div className="tt-wrap">
      <table className="tt" aria-label={label}>
        <thead>
          <tr>
            {expand ? <th className="tt-x" aria-label="Expand" /> : null}
            {columns.map((c) => (
              <th key={c.key} className={`${c.align ? `a-${c.align}` : ""} ${c.className ?? ""}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const k = rowKey(row);
            const isOpen = open.has(k);
            return (
              <Fragment key={k}>
                <tr
                  className={`${rowClass?.(row) ?? ""}${expand ? " tt-click" : ""}${isOpen ? " tt-open" : ""}`}
                  onClick={expand ? () => toggle(k) : undefined}
                >
                  {expand ? (
                    <td className="tt-x">
                      <button
                        type="button"
                        className="tt-chev"
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "Hide details" : "Show details"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(k);
                        }}
                      >
                        {isOpen ? "▾" : "▸"}
                      </button>
                    </td>
                  ) : null}
                  {columns.map((c) => (
                    <td key={c.key} className={`${c.align ? `a-${c.align}` : ""} ${c.className ?? ""}`}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
                {expand && isOpen ? (
                  <tr className="tt-detail">
                    <td colSpan={span}>{expand(row)}</td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

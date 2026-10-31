// Maps stored Worker/D1 values to display labels and tones. Pure functions.

import type { FeedState } from "./poller";
import type { AlertRow, OrderRow, RiskCheck, RiskRow } from "./types";

export type Tone = "ok" | "bad" | "warn" | "err" | "info" | "dup" | "muted";

export interface Label {
  text: string;
  tone: Tone;
}

/** Alert outcome. Duplicates are shown separately via duplicateLabel(). */
export function alertLabel(a: Pick<AlertRow, "status">): Label {
  switch (a.status) {
    case "dry_run":
      return { text: "DRY RUN OK", tone: "ok" };
    case "rejected":
      return { text: "REJECTED", tone: "bad" };
    case "error":
      return { text: "ERROR", tone: "err" };
    case "processing":
      return { text: "PROCESSING", tone: "warn" };
    case "unknown":
      return { text: "UNKNOWN", tone: "warn" };
    default:
      return { text: (a.status || "N/A").toUpperCase(), tone: "muted" };
  }
}

export function duplicateLabel(a: Pick<AlertRow, "duplicate_count">): Label | null {
  const n = Number(a.duplicate_count ?? 0);
  return n > 0 ? { text: `DUP ×${n}`, tone: "dup" } : null;
}

/** Row class so each alert state reads differently at a glance. */
export function alertRowClass(a: Pick<AlertRow, "status" | "duplicate_count">): string {
  const base = alertLabel(a).tone;
  return `row-${base}${duplicateLabel(a) ? " row-has-dup" : ""}`;
}

export function riskLabel(r: Pick<RiskRow, "approved">): Label {
  return r.approved ? { text: "APPROVED", tone: "ok" } : { text: "REJECTED", tone: "bad" };
}

export function riskChecks(r: Pick<RiskRow, "checks">): RiskCheck[] {
  if (!Array.isArray(r.checks)) return [];
  return r.checks.filter(
    (c): c is RiskCheck => !!c && typeof c === "object" && typeof (c as RiskCheck).check === "string",
  );
}

/** Dry-run order status. None of these are broker orders. */
export function orderLabel(o: Pick<OrderRow, "status">): Label {
  switch (o.status) {
    case "dry_run_accepted":
      return { text: "DRY RUN · ACCEPTED", tone: "ok" };
    case "dry_run_reconciled":
      return { text: "DRY RUN · RECONCILED", tone: "info" };
    case "unknown":
      return { text: "DRY RUN · UNKNOWN", tone: "warn" };
    case "dry_run_failed":
      return { text: "DRY RUN · FAILED", tone: "bad" };
    default:
      return { text: `DRY RUN · ${(o.status || "N/A").toUpperCase()}`, tone: "muted" };
  }
}

export function levelTone(level: string | null | undefined): Tone {
  const l = (level ?? "").toLowerCase();
  if (l === "error" || l === "critical" || l === "fatal") return "err";
  if (l === "warn" || l === "warning") return "warn";
  if (l === "success" || l === "ok") return "ok";
  return "info";
}

export function engineTone(state: string | null | undefined): Tone {
  if (state === "RUNNING") return "ok";
  if (state === "PAUSED") return "warn";
  if (state === "STOPPED") return "muted";
  return "err";
}

export function connectionLabel(s: Pick<FeedState, "status" | "error">): Label {
  switch (s.status) {
    case "ok":
      return { text: "CONNECTED", tone: "ok" };
    case "stale":
      return { text: "STALE", tone: "warn" };
    case "loading":
      return { text: "CONNECTING", tone: "muted" };
    case "unauthorized":
      return { text: "SIGNED OUT", tone: "bad" };
    default:
      return { text: s.error?.status === 0 ? "OFFLINE" : "ERROR", tone: "err" };
  }
}

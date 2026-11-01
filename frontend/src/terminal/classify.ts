// Maps stored Worker/D1 values to display labels and tones. Pure functions.
// Tones: ok = green, bad = red, warn = orange, info = blue, muted = gray.

import type { FeedState } from "./poller";
import type { ActivityRow, AlertRow, OrderRow, RiskCheck, RiskRow } from "./types";

export type Tone = "ok" | "bad" | "warn" | "info" | "muted";

export interface Label {
  text: string;
  tone: Tone;
}

/** Alert outcome. Duplicates are shown separately via duplicateLabel(). */
export function alertLabel(a: Pick<AlertRow, "status">): Label {
  switch (a.status) {
    case "dry_run":
      return { text: "DRY-RUN ACCEPTED", tone: "ok" };
    case "rejected":
      return { text: "REJECTED", tone: "bad" };
    case "error":
      return { text: "ERROR", tone: "bad" };
    case "processing":
      return { text: "PROCESSING", tone: "muted" };
    case "unknown":
      return { text: "UNKNOWN", tone: "warn" };
    default:
      return { text: (a.status || "N/A").toUpperCase(), tone: "muted" };
  }
}

export function duplicateLabel(a: Pick<AlertRow, "duplicate_count">): Label | null {
  const n = Number(a.duplicate_count ?? 0);
  return n > 0 ? { text: n === 1 ? "DUPLICATE" : `DUPLICATE ×${n}`, tone: "warn" } : null;
}

/** Accent of an alert card: its outcome, or orange when only duplicates are notable. */
export function alertTone(a: Pick<AlertRow, "status" | "duplicate_count">): Tone {
  const t = alertLabel(a).tone;
  return t === "muted" && duplicateLabel(a) ? "warn" : t;
}

export function actionLabel(action: string | null | undefined): Label {
  const a = (action ?? "").toLowerCase();
  if (a === "buy") return { text: "BUY", tone: "ok" };
  if (a === "sell") return { text: "SELL", tone: "bad" };
  if (a === "close") return { text: "CLOSE", tone: "warn" };
  return { text: a ? a.toUpperCase() : "N/A", tone: "muted" };
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

/** Dry-run order intent status. None of these are broker orders. */
export function orderLabel(o: Pick<OrderRow, "status">): Label {
  switch (o.status) {
    case "dry_run_accepted":
      return { text: "ACCEPTED", tone: "ok" };
    case "dry_run_reconciled":
      return { text: "RECONCILED", tone: "info" };
    case "unknown":
      return { text: "UNKNOWN", tone: "warn" };
    case "dry_run_failed":
      return { text: "FAILED", tone: "bad" };
    default:
      return { text: (o.status || "N/A").toUpperCase(), tone: "muted" };
  }
}

/** Activity colour: red errors, orange strategy/risk, green success, gray info. */
export function activityTone(e: Pick<ActivityRow, "level" | "category">): Tone {
  const l = (e.level ?? "").toLowerCase();
  const c = (e.category ?? "").toLowerCase();
  if (l === "error" || l === "critical" || l === "fatal") return "bad";
  if (l === "warn" || l === "warning") return "warn";
  if (l === "success" || l === "ok") return "ok";
  if (c.includes("risk") || c.includes("strategy")) return "warn";
  return "muted";
}

export function engineTone(state: string | null | undefined): Tone {
  if (state === "RUNNING") return "ok";
  if (state === "PAUSED") return "warn";
  if (state === "STOPPED") return "muted";
  return "bad";
}

/** Asset class from the symbol. Alpaca crypto pairs end in USD/USDT/USDC or contain "/". */
export function marketType(symbol: string | null | undefined): "STOCK" | "CRYPTO" | null {
  if (!symbol) return null;
  const s = symbol.toUpperCase();
  if (s.includes("/") || (s.length > 5 && /(USD|USDT|USDC)$/.test(s))) return "CRYPTO";
  return "STOCK";
}

export function connectionLabel(s: Pick<FeedState, "status" | "error">): Label {
  switch (s.status) {
    case "ok":
      return { text: "ONLINE", tone: "ok" };
    case "stale":
      return { text: "STALE", tone: "warn" };
    case "loading":
      return { text: "CONNECTING", tone: "muted" };
    case "unauthorized":
      return { text: "SIGNED OUT", tone: "bad" };
    default:
      return { text: s.error?.status === 0 ? "OFFLINE" : "ERROR", tone: "bad" };
  }
}

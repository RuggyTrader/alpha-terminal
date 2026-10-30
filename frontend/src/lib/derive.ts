// Pure functions that derive display data from real API responses.
// Nothing here invents values: missing inputs produce null / empty results.

import type { ActivityEvent, AlertBrief, TradeRow } from "../types/api";

export const STRATEGY_COLORS = ["#F2661B", "#3A6FF2", "#14A35B", "#8B5CF6", "#E5A50A", "#E0457B", "#0EA5B7", "#6B7280"];

export interface StrategyStat {
  name: string;
  color: string;
  closed: number;
  wins: number;
  realized: number; // sum of realized P&L of closed trades
}

/** Per-strategy stats over CLOSED trades only (open trades have no final result). */
export function strategyStats(trades: TradeRow[]): StrategyStat[] {
  const order: string[] = [];
  const map = new Map<string, StrategyStat>();
  const chronological = [...trades].sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  for (const t of chronological) {
    const name = (t.strategy ?? "UNSPECIFIED").toUpperCase();
    if (!map.has(name)) {
      order.push(name);
      map.set(name, { name, color: "", closed: 0, wins: 0, realized: 0 });
    }
    if (t.status !== "CLOSED") continue;
    const s = map.get(name)!;
    const pnl = Number(t.realized_pnl ?? 0);
    s.closed += 1;
    if (pnl > 0) s.wins += 1;
    s.realized += Number.isFinite(pnl) ? pnl : 0;
  }
  return order.map((name, i) => ({ ...map.get(name)!, color: STRATEGY_COLORS[i % STRATEGY_COLORS.length] }));
}

export function strategyColor(stats: StrategyStat[], strategy: string | null): string {
  const s = stats.find((x) => x.name === (strategy ?? "UNSPECIFIED").toUpperCase());
  return s?.color ?? "#B3ADA2";
}

export type TileTone = "win" | "loss" | "flat" | "open";

export function tradeTone(t: TradeRow): TileTone {
  if (t.status === "OPEN") return "open";
  const p = Number(t.realized_pnl ?? 0);
  if (p > 0) return "win";
  if (p < 0) return "loss";
  return "flat";
}

/** Count alerts whose received_at falls on the viewer's current local day. */
export function alertsToday(alerts: AlertBrief[], now = new Date()): number {
  const day = now.toDateString();
  return alerts.filter((a) => new Date(a.received_at).toDateString() === day).length;
}

export interface ToastSpec {
  key: string;
  title: string;
  body: string;
  tone: "success" | "decision" | "error" | "info";
}

/** Which persisted activity events deserve a top banner. Returns null for the rest. */
export function toastForEvent(e: ActivityEvent): ToastSpec | null {
  const sym = e.symbol ? `${e.symbol} ` : "";
  if (e.category === "BROKER" && e.level === "success" && /filled/i.test(e.message)) {
    return { key: `ev-${e.id}`, title: "PAPER order filled", body: `${sym}${(e.action ?? "").toUpperCase()} ${e.qty ?? ""}`.trim(), tone: "success" };
  }
  if (e.category === "BROKER" && e.level === "error") {
    return { key: `ev-${e.id}`, title: "Broker error", body: `${sym}${e.message}`, tone: "error" };
  }
  if (e.category === "RISK" && e.level === "error") {
    return { key: `ev-${e.id}`, title: "Risk check blocked an order", body: e.message, tone: "error" };
  }
  if (e.category === "ENGINE" && /^Engine (RUNNING|PAUSED|STOPPED)$/.test(e.message)) {
    return { key: `ev-${e.id}`, title: e.message.replace("Engine", "Engine").toUpperCase(), body: "PAPER execution state changed", tone: "decision" };
  }
  if (e.category === "ENGINE" && /KILL SWITCH ENGAGED/.test(e.message)) {
    return { key: `ev-${e.id}`, title: "KILL SWITCH ENGAGED", body: "New PAPER orders are blocked", tone: "error" };
  }
  return null;
}

export interface Milestone {
  key: string;
  title: string;
  body: string;
}

const CLOSED_MILESTONES = [10, 25, 50, 100, 250, 500];

/** Milestones reached by real ledger data. */
export function reachedMilestones(trades: TradeRow[], closedTotal: number): Milestone[] {
  const out: Milestone[] = [];
  if (trades.some((t) => t.status === "CLOSED" && Number(t.realized_pnl ?? 0) > 0)) {
    out.push({ key: "first-profitable", title: "First profitable PAPER trade", body: "A closed PAPER trade finished in profit" });
  }
  for (const n of CLOSED_MILESTONES) {
    if (closedTotal >= n) out.push({ key: `closed-${n}`, title: `${n} closed PAPER trades`, body: `${n} round trips completed by the engine` });
  }
  return out;
}

/** Milestones in `now` that were not in `seen`. If `seen` is null (first visit on this
 * device) nothing is celebrated: existing history is recorded silently. */
export function newMilestones(now: Milestone[], seen: string[] | null): Milestone[] {
  if (seen === null) return [];
  return now.filter((m) => !seen.includes(m.key));
}

/** Which pipeline stage decided the alert, from its persisted response code. */
export function alertStage(a: AlertBrief): string {
  const c = a.code ?? "";
  if (a.status === "accepted") return "Alpaca PAPER";
  if (a.status === "processing") return "Processing";
  if (/^(INVALID_|MISSING_|UNSUPPORTED_)/.test(c)) return "Validation";
  if (/^ENGINE_|KILL_SWITCH|EXECUTION_DISABLED/.test(c)) return "Engine";
  if (/^BROKER_/.test(c)) return "Broker";
  return "Risk";
}


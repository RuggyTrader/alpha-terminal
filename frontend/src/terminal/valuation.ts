import type { Fleet } from "./bots";
import type { DashboardData, PaperPortfolio } from "./types";
export type ValuationState = "FRESH" | "STALE" | "UNAVAILABLE";
/** A number alone is not proof that its underlying mark is current. */
export function valuationState(portfolio: PaperPortfolio, paper: DashboardData["paper"] | undefined, fleet: Fleet | null, now: number, feedStale = false): ValuationState {
  if (portfolio.totals.equity_usd === null || portfolio.totals.equity_usd === undefined) return "UNAVAILABLE";
  const expected = portfolio.wallets.reduce((n, w) => n + w.open_positions, 0);
  const legacy = paper?.positions ?? [];
  const bots = fleet?.available ? fleet.bots.filter(b => b.ledger_api === "bot").flatMap(b => b.open_positions) : [];
  if (expected > legacy.length + bots.length) return "UNAVAILABLE";
  if (legacy.some(p => p.mark_price === null) || bots.some(p => p.mark_price === null || !p.mark_at)) return "UNAVAILABLE";
  const old = bots.some(p => { const at = Date.parse(p.mark_at ?? ""); return !Number.isFinite(at) || now - at > 120_000; });
  return feedStale || paper?.performance.marks_stale || legacy.some(p => p.mark_status !== "FRESH") || old ? "STALE" : "FRESH";
}

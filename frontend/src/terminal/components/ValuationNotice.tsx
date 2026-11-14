import { useFleet } from "../fleetStore";
import { valuationState } from "../valuation";
import type { DashboardData, PaperPortfolio } from "../types";
export function ValuationNotice({ portfolio, paper, feedStale = false }: { portfolio: PaperPortfolio; paper?: DashboardData["paper"]; feedStale?: boolean }) {
  const shared = useFleet();
  const state = valuationState(portfolio, paper, shared.fleet, Date.now(), feedStale || shared.stale);
  return <p className={`sizing-note ${state === "FRESH" ? "" : "t-warn"}`} role="status" data-valuation={state}>
    {state === "FRESH" ? "Equity uses recorded market marks. Profit transfers are already included." : state === "STALE"
      ? "STALE MARKET MARKS · equity uses the last recorded prices, not current executable prices."
      : "EQUITY UNAVAILABLE · a complete equity value or market-mark evidence is missing. Missing data is not zero."}
  </p>;
}

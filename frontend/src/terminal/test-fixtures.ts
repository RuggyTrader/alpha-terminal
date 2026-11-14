// TEST fixtures only. Production code never imports this module.
import { computeMetrics } from "./performance";
import type { LifetimePerformance, VerifiedTrade } from "./types";
export function fixtureLifetime(trades: VerifiedTrade[] = []): LifetimePerformance {
  const m = computeMetrics(trades, "ALL", 0, null);
  return { scope: "all-funded-paper", complete: true, bot_id: null, closed_trades: m.trades, wins: m.wins, losses: m.losses,
    break_even: m.trades - m.wins - m.losses, gross_usd: m.totalPnl, fees_usd: 0, net_usd: m.totalPnl,
    win_rate: m.winRate === null ? null : m.winRate / 100, profit_factor: m.profitFactor, expectancy_usd: m.expectancy,
    max_drawdown_usd: m.maxDrawdown ?? 0, drawdown_basis: "TEST closed-trade curve", first_close: null, last_close: null };
}

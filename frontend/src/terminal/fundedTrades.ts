// ONE funded PAPER trade set for Home (hero + Funded PAPER tab): the legacy ALPHA PAPER ledger's verified trades (GET
// /api/dashboard/performance) PLUS the bot ledger's closed trades (GET /api/dashboard/bot-trades, ledger = "bot" only).
// Legacy bot rows also appear in bot-trades (ledger = "legacy"); they are NOT added again, so no trade is counted twice.
// Every figure is a ledger net (after its recorded fees). Strategy Mirror trades are never included.

import { useEffect, useState } from "react";
import { fetchBotTrades, type BotTradeRow } from "./botTrades";
import { useFleet } from "./fleetStore";
import type { VerifiedTrade } from "./types";
import type { VerifiedState } from "./useVerified";

/** A closed bot-ledger trade in the verified-trade shape (negative ids: never collide with legacy ledger ids). */
export function botRowToVerified(r: BotTradeRow, i: number): VerifiedTrade {
  return { id: -(i + 1), symbol: r.symbol, direction: r.side.toLowerCase(), strategy: r.bot_id, realized_pnl: r.net_usd ?? 0, proof_url: r.proof_url, return_pct: null,
    cost_basis: r.qty * r.entry_price, opened_at: r.opened_at, closed_at: r.closed_at ?? r.opened_at, price_sources: "kraken", gross_pnl: r.gross_usd, fees_usd: r.fees_usd, slippage_usd: 0,
    cost_profile: "ndax-flat-0.20" };
}

export function mergeFunded(verified: VerifiedState, botRows: BotTradeRow[] | null): VerifiedState {
  if (!verified.data || !botRows) return verified;
  const unique = [...new Map(botRows.map(r => [r.trade_id, r])).values()];
  const extra = unique.filter((r) => r.ledger === "bot" && r.status === "CLOSED" && r.net_usd !== null).map(botRowToVerified);
  if (!extra.length) return verified;
  return { ...verified, data: { ...verified.data, trades: [...verified.data.trades, ...extra],
    truncated: verified.data.truncated || (verified.data.lifetime !== undefined && verified.data.trades.length + extra.length < verified.data.lifetime.closed_trades),
    verification: `${verified.data.verification} Includes ${extra.length} closed bot-ledger trade(s) (each bot's own wallet, net of its recorded fees).` } };
}

/** Re-reads the bot trades whenever the shared fleet snapshot changes (so a close shows on Home with the fleet). */
export function useFundedVerified(verified: VerifiedState): VerifiedState {
  const { fleet, fetchedAt } = useFleet();
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [rows, setRows] = useState<BotTradeRow[] | null>(null);
  const historyKey = fleet?.bots.map(b => `${b.bot_id}:${b.paper.trades}:${b.paper.net_usd}`).join("|") ?? "";
  const retryMinute = Math.floor((fetchedAt ?? 0) / 60_000);
  const botLedger = !!fleet?.bots.some((b) => b.ledger_api === "bot");
  useEffect(() => {
    if (!botLedger) { setRows([]); return; }
    let live = true;
    fetchBotTrades({ limit: 50 }).then((d) => { if (live) { setRows(d.available ? d.trades : []); setHistoryError(null); } }).catch(() => { if (live) setHistoryError("Recent bot trade rows could not refresh; lifetime totals remain separate."); });
    return () => { live = false; };
  }, [botLedger, historyKey, retryMinute]);
  const result = mergeFunded(verified, rows);
  return result.data ? { ...result, data: { ...result.data, history_error: historyError } } : result;
}

// ONE funded PAPER trade set for Home (hero + Funded PAPER tab): the legacy ALPHA PAPER ledger's verified trades (GET
// /api/dashboard/performance) PLUS the bot ledger's closed trades (GET /api/dashboard/bot-trades, ledger = "bot" only).
// Legacy bot rows also appear in bot-trades (ledger = "legacy"); they are NOT added again, so no trade is counted twice.
// Every figure is a ledger net (after its recorded fees). Strategy Mirror trades are never included.

import { useEffect, useState } from "react";
import { fetchBotTrades, ledgerSignature, type BotTradeRow } from "./botTrades";
import { useFleet } from "./fleetStore";
import type { VerifiedTrade } from "./types";
import type { VerifiedState } from "./useVerified";

/** A closed bot-ledger trade in the verified-trade shape (negative ids: never collide with legacy ledger ids). */
export function botRowToVerified(r: BotTradeRow, i: number): VerifiedTrade {
  return { id: -(i + 1), symbol: r.symbol, direction: r.side.toLowerCase(), strategy: r.bot_id, realized_pnl: r.net_usd ?? 0, return_pct: null,
    cost_basis: r.qty * r.entry_price, opened_at: r.opened_at, closed_at: r.closed_at ?? r.opened_at, price_sources: "kraken", gross_pnl: r.gross_usd, fees_usd: r.fees_usd, slippage_usd: 0,
    cost_profile: "ndax-flat-0.20" };
}

export function mergeFunded(verified: VerifiedState, botRows: BotTradeRow[] | null): VerifiedState {
  if (!verified.data || !botRows) return verified;
  const extra = botRows.filter((r) => r.ledger === "bot" && r.status === "CLOSED" && r.net_usd !== null).map(botRowToVerified);
  if (!extra.length) return verified;
  return { ...verified, data: { ...verified.data, trades: [...verified.data.trades, ...extra],
    verification: `${verified.data.verification} Includes ${extra.length} closed bot-ledger trade(s) (each bot's own wallet, net of its recorded fees).` } };
}

/** Bot-ledger rows for the funded totals, or why they could not be used. */
export interface FundedRows { rows: BotTradeRow[] | null; problem: string | null }

/**
 * The funded totals Home shows. If the bot-ledger history could not be read COMPLETELY (request failed, or the
 * Worker returned fewer rows than exist), the totals are reported unavailable with the reason: a total that silently
 * leaves out the bot ledger would be a misleading profit figure.
 */
export function fundedState(verified: VerifiedState, f: FundedRows): VerifiedState {
  if (f.problem) return { status: "error", data: null, error: `Funded totals unavailable: ${f.problem}. Nothing is shown rather than a partial total.` };
  return mergeFunded(verified, f.rows);
}

/** Re-reads the bot trades whenever the shared fleet snapshot shows a ledger change (so a close shows on Home with the fleet). */
export function useFundedVerified(verified: VerifiedState): VerifiedState {
  const { fleet } = useFleet();
  const [f, setF] = useState<FundedRows>({ rows: null, problem: null });
  const botLedger = !!fleet?.bots.some((b) => b.ledger_api === "bot");
  // Refetch only when a bot's trades actually changed (not on every 20 s fleet poll: this read is the full history).
  const sig = ledgerSignature(fleet ?? null);
  useEffect(() => {
    if (!botLedger) { setF({ rows: [], problem: null }); return; }
    let live = true;
    fetchBotTrades({ limit: 5000 }).then((d) => {
      if (!live) return;
      if (!d.available) { setF({ rows: [], problem: null }); return; }
      if (d.page?.truncated) { setF({ rows: null, problem: `the Worker returned ${d.page.returned} of ${d.page.total} bot-ledger trades` }); return; }
      setF({ rows: d.trades, problem: null });
    }).catch((e) => { if (live) setF({ rows: null, problem: `the bot-ledger trades could not be loaded (${String((e as Error)?.message ?? e)})` }); });
    return () => { live = false; };
  }, [botLedger, sig]);
  return fundedState(verified, f);
}

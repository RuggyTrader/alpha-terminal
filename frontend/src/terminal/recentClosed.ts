// Home "Closed trades": the latest COMPLETED funded PAPER trades across the fleet, from the shared bot-trades snapshot
// (the same rows as Trades → Completed). Only rows the ledger closed with a recorded net result are eligible; pending,
// open, refused, cancelled, Strategy Mirror and research rows never appear here.

import type { BotTradeRow } from "./botTrades";

export interface ClosedCard {
  key: string;               // stable identity: ledger + trade id
  botId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  net: number;               // ledger net after its recorded fees
  gross: number | null;      // recorded result before fees (null when not recorded)
  /** Net ÷ entry notional (qty × entry price), from the recorded figures; null when they are missing. */
  returnPct: number | null;
  closedAt: string;
  openedAt: string;
  url: string;
}

export function closedCards(rows: BotTradeRow[] | null | undefined, max = 4): ClosedCard[] {
  if (!rows) return [];
  const seen = new Set<string>();
  const out: ClosedCard[] = [];
  for (const r of rows) {
    if (String(r.status).toUpperCase() !== "CLOSED" || r.net_usd === null || !Number.isFinite(r.net_usd) || !r.closed_at) continue;
    const key = `${r.ledger}:${r.trade_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const side = String(r.side).toUpperCase() === "SHORT" ? "SHORT" : "LONG";
    const notional = Number(r.qty) * Number(r.entry_price);
    out.push({ key, botId: r.bot_id, symbol: r.symbol, side, net: r.net_usd, gross: r.gross_usd ?? null, returnPct: notional > 0 ? (r.net_usd / notional) * 100 : null,
      closedAt: r.closed_at, openedAt: r.opened_at, url: r.proof_url });
  }
  // newest completion first; ties broken by the stable key so the order never flickers between polls
  out.sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return out.slice(0, max);
}

/** "12m", "3h 05m", "2d 4h": the recorded holding time. */
export function holdTime(openedAt: string, closedAt: string): string | null {
  const ms = Date.parse(closedAt) - Date.parse(openedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

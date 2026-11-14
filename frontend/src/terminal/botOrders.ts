// Durable PAPER pending limit orders (GET /api/dashboard/bot-orders, worker table bot_pending_orders, schema 7).
// One record per strategy order with its explicit outcome: PENDING, FILLED, CANCELLED, EXPIRED, REPLACED, REJECTED.
// Refreshes when the fleet's ledger signature changes (a fill, a close, a new or cancelled order) and every minute;
// a failed refresh keeps the last snapshot and marks it stale. Before migration 0007: installed = false.

import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Fleet } from "./bots";
import { ledgerSignature } from "./botTrades";

export type OrderStatus = "PENDING" | "FILLED" | "CANCELLED" | "EXPIRED" | "REPLACED" | "REJECTED";
export interface DurableOrder {
  order_id: string; bot_id: string; symbol: string; timeframe_min: number; side: "LONG" | "SHORT";
  limit: number; stop: number; tp: number; requested_qty: number; accepted_qty: number | null;
  risk_usd: number | null; actual_risk_usd: number | null; collateral_usd: number | null; fee_estimate_usd: number | null;
  placed_at: string; expires_at: string | null; status: OrderStatus; code: string; message: string | null;
  fill_trade_id: string | null; received_at: string; updated_at: string;
}
export interface BotOrdersSnapshot { installed: boolean | null; orders: DurableOrder[]; error: string | null; fetchedAt: number | null; stale: boolean }

export async function fetchBotOrders(limit = 100): Promise<{ installed: boolean; orders: DurableOrder[] }> {
  const env = await api.get<{ ok: boolean; data?: { installed: boolean; orders: DurableOrder[] } }>(`/api/dashboard/bot-orders?limit=${limit}`);
  if (!env?.ok || !env.data) throw new Error("Unexpected bot-orders response");
  return env.data;
}

export const ORDERS_POLL_MS = 60_000;

export function useBotOrders(fleet: Fleet | null, fetcher: () => Promise<{ installed: boolean; orders: DurableOrder[] }> = () => fetchBotOrders()): BotOrdersSnapshot {
  const [s, setS] = useState<BotOrdersSnapshot>({ installed: null, orders: [], error: null, fetchedAt: null, stale: false });
  const seq = useRef(0);
  const sig = ledgerSignature(fleet);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const my = ++seq.current;
      fetcher().then((d) => { if (alive && my === seq.current) setS({ installed: d.installed, orders: d.orders, error: null, fetchedAt: Date.now(), stale: false }); })
        .catch((e) => { if (alive && my === seq.current) setS((p) => ({ ...p, error: String(e instanceof Error ? e.message : e), stale: p.fetchedAt !== null })); });
    };
    load();
    const t = setInterval(load, ORDERS_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

export const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  PENDING: "Pending", FILLED: "Filled", CANCELLED: "Cancelled", EXPIRED: "Expired", REPLACED: "Replaced", REJECTED: "Rejected",
};

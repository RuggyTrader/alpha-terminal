import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { SymbolIcon } from "../components/trading";
import { Badge, EmptyState, ErrorState, LoadingRows, SettingsGroup, SRow, StatusBadge } from "../components/ui";
import { usePoll } from "../hooks/usePoll";
import { dateTime, money, num, pct, price, qty, signedMoney, tone } from "../lib/format";
import type { TradeDetail } from "../types/api";
import { AlertGroups, BackBar, OrderGroup, RiskGroup } from "./AlertDetail";

export function TradeDetailPage() {
  const { id } = useParams();
  const q = usePoll(() => api.get<TradeDetail>(`/api/trades/${id}`), 10000, [id]);
  const t = q.data;
  const first = t?.legs[0];
  const firstAlert = first?.alert ?? null;
  const risk = firstAlert?.risk_decisions[firstAlert.risk_decisions.length - 1];
  const open = t?.status === "OPEN";
  const pnl = open && t?.unrealized?.available ? num(t.unrealized.pnl) : num(t?.realized_pnl);

  return (
    <div className="detail">
      <BackBar title="Trade receipt" />
      <ErrorState error={q.error} what="TRADE" />
      {!t ? (q.loading ? <LoadingRows rows={5} /> : <EmptyState>NOT FOUND</EmptyState>) : (
        <>
          <div className="receipt-head">
            <SymbolIcon symbol={t.symbol} size={40} />
            <h1>{t.symbol}</h1>
            <span className="receipt-side">{t.direction} / {t.side} · {t.market}</span>
            <div className={`receipt-pnl ${tone(pnl)}`}>{signedMoney(pnl)}</div>
            <div className={`receipt-pct ${tone(num(t.return_pct))}`}>
              {open ? (t.unrealized?.available ? "UNREALIZED (ALPACA PAPER)" : "UNREALIZED N/A") : pct(t.return_pct)}
            </div>
            <div className="receipt-badges">
              <StatusBadge status={t.status} />
              <Badge tone={t.badge === "VERIFIED PAPER" ? "green" : "orange"}>{t.badge}</Badge>
            </div>
          </div>
          <SettingsGroup title="EXECUTION">
            <SRow k="Entry" v={`${qty(t.qty)} @ ${price(t.entry_price)}`} />
            <SRow k="Exit" v={t.exit_price ? `${qty(t.exit_qty)} @ ${price(t.exit_price)}` : "—"} />
            <SRow k="Quantity" v={qty(t.qty)} />
            <SRow k="Open quantity" v={qty(t.open_qty)} />
            <SRow k="Order type" v={t.order_type} />
            <SRow k="Realized PAPER P&L" v={signedMoney(t.realized_pnl)} cls={tone(num(t.realized_pnl))} />
            {open && <SRow k="Unrealized PAPER P&L" v={t.unrealized?.available ? signedMoney(t.unrealized.pnl ?? null) : "N/A"}
              cls={t.unrealized?.available ? tone(num(t.unrealized.pnl ?? null)) : "na"} />}
            <SRow k="Closed cost basis" v={money(t.closed_cost_basis)} />
            <SRow k="Opened" v={dateTime(t.opened_at)} />
            <SRow k="Closed" v={t.closed_at ? dateTime(t.closed_at) : "OPEN"} />
          </SettingsGroup>
          <SettingsGroup title="SIGNAL">
            <SRow k="Strategy" v={t.strategy ?? "UNSPECIFIED"} />
            <SRow k="TradingView alert ID" v={t.alert_id ?? "N/A (manual)"} mono />
            <SRow k="Received" v={dateTime(firstAlert?.received_at)} />
          </SettingsGroup>
          <SettingsGroup title="BROKER">
            <SRow k="Alpaca PAPER order ID" v={t.alpaca_order_id ?? "N/A"} mono />
            <SRow k="Order status" v={<StatusBadge status={t.order_status} />} />
            <SRow k="Average fill" v={price(first?.order.filled_avg_price)} />
            <SRow k="Database record" v={`#${t.database_record_id}`} mono />
          </SettingsGroup>
          <RiskGroup risk={risk} />
          {t.legs.map((leg, i) => (
            <details className="leg" key={leg.order.id}>
              <summary>LEG {i + 1} · {leg.order.side.toUpperCase()} {qty(leg.order.filled_qty)} @ {price(leg.order.filled_avg_price)}</summary>
              {leg.alert ? <AlertGroups a={leg.alert} /> : <OrderGroup o={leg.order} />}
            </details>
          ))}
        </>
      )}
    </div>
  );
}

import { marketType } from "../classify";
import { costMoney, percent, price, qty, signedMoney, stamp, text, tone, upper, when } from "../fmt";
import type { TradeRow } from "../types";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Code, Expandable, KV, StatusBadge } from "./ui";

export function TradeCard({ t, defaultOpen = false }: { t: TradeRow; defaultOpen?: boolean }) {
  const mt = marketType(t.symbol);
  const closed = t.status === "CLOSED";
  // Ledger trades are simulated from dry-run intents, never broker fills.
  const alphaPaper = t.source === "ALPHA_PAPER";
  // Trades closed with a cost profile carry gross, fees and slippage; realized_pnl is then NET.
  const costed = closed && t.cost_profile !== null && t.cost_profile !== undefined;
  return (
    <Expandable
      tone={closed ? (tone(t.realized_pnl) === "neg" ? "bad" : tone(t.realized_pnl) === "pos" ? "ok" : "muted") : "info"}
      className="trade-card"
      defaultOpen={defaultOpen}
      head={
        <>
          <div className="row-a">
            <b className="sym">{t.symbol}</b>
            <span className="act">{upper(t.direction)}</span>
            {t.strategy ? <span className="strat">{t.strategy}</span> : null}
            <span className="time">{when(t.closed_at ?? t.opened_at)}</span>
          </div>
          <div className="row-b">
            {alphaPaper && closed ? <StatusBadge tone="ok">✓ VERIFIED PAPER</StatusBadge>
              : alphaPaper ? <StatusBadge tone="info">ALPHA PAPER</StatusBadge>
              : <StatusBadge tone="warn">UNVERIFIED SOURCE</StatusBadge>}
            <StatusBadge tone={closed ? "muted" : "info"}>{text(t.status)}</StatusBadge>
            {mt ? <StatusBadge tone="muted">{mt}</StatusBadge> : null}
            <span className="trade-pnl">
              <b className={`t-${tone(t.realized_pnl)}`}>{signedMoney(t.realized_pnl)}</b>
              <span className={`t-${tone(t.return_pct)}`}>{percent(t.return_pct)}</span>
            </span>
          </div>
        </>
      }
    >
      <KV
        rows={[
          ["Strategy", text(t.strategy)],
          ["Entry", `${qty(t.entry_qty)} @ ${price(t.entry_avg_price)}`],
          ["Exit", `${qty(t.exit_qty)} @ ${price(t.exit_avg_price)}`],
          ["Open qty", qty(t.open_qty)],
          ...(costed
            ? ([
                ["Gross P&L (before costs)", signedMoney(t.gross_pnl)],
                ["Simulated slippage", costMoney(t.slippage_usd)],
                ["Simulated fees", costMoney(t.fees_usd)],
                ["Net PAPER P&L", <b key="n" className={`t-${tone(t.realized_pnl)}`}>{signedMoney(t.realized_pnl)}</b>],
                ["Cost profile", text(t.cost_profile)],
              ] as [string, ReactNode][])
            : ([["Realized PAPER P&L", signedMoney(t.realized_pnl)]] as [string, ReactNode][])),
          ["Return", percent(t.return_pct)],
          ["Opened", <span key="o" className="mono-s">{stamp(t.opened_at)}</span>],
          ["Closed", <span key="c" className="mono-s">{stamp(t.closed_at)}</span>],
          ...(alphaPaper
            ? ([
                ["Execution", "ALPHA PAPER · simulated, not broker-executed"],
                ["Entry alert", <Code key="ea">{text(t.open_alert_id)}</Code>],
                ["Exit alert", <Code key="xa">{text(t.close_alert_id)}</Code>],
                ["Entry intent", <Code key="eo">{text(t.open_order_id)}</Code>],
                ["Exit intent", <Code key="xo">{text(t.close_order_id)}</Code>],
                ["Price source", text(t.price_sources)],
              ] as [string, ReactNode][])
            : ([["Verification", "Not an ALPHA PAPER ledger trade: excluded from verified performance"]] as [string, ReactNode][])),
        ]}
      />
      <Link to={`/trades/${t.id}`} className="proof-link m-press">Trade proof →</Link>
    </Expandable>
  );
}

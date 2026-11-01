import { marketType } from "../classify";
import { percent, price, qty, signedMoney, stamp, text, tone, upper, when } from "../fmt";
import type { TradeRow } from "../types";
import { Expandable, KV, StatusBadge } from "./ui";

export function TradeCard({ t }: { t: TradeRow }) {
  const mt = marketType(t.symbol);
  const closed = t.status === "CLOSED";
  return (
    <Expandable
      tone={closed ? (tone(t.realized_pnl) === "neg" ? "bad" : tone(t.realized_pnl) === "pos" ? "ok" : "muted") : "info"}
      className="trade-card"
      head={
        <>
          <div className="row-a">
            <b className="sym">{t.symbol}</b>
            <span className="act">{upper(t.direction)}</span>
            {t.strategy ? <span className="strat">{t.strategy}</span> : null}
            <span className="time">{when(t.closed_at ?? t.opened_at)}</span>
          </div>
          <div className="row-b">
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
          ["Realized PAPER P&L", signedMoney(t.realized_pnl)],
          ["Return", percent(t.return_pct)],
          ["Opened", <span key="o" className="mono-s">{stamp(t.opened_at)}</span>],
          ["Closed", <span key="c" className="mono-s">{stamp(t.closed_at)}</span>],
        ]}
      />
    </Expandable>
  );
}

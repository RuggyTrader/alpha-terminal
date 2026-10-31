import { marketType } from "../classify";
import { fractionPct, money, price, qty, signedMoney, tone, upper } from "../fmt";
import type { PaperPosition } from "../types";
import { StatusBadge } from "./ui";

// Alpaca returns *_plpc and change_today as fractions; colour by the percentage.
export function PositionCard({ p }: { p: PaperPosition }) {
  const mt = marketType(p.symbol);
  return (
    <article className="card pos-card">
      <div className="pc-top">
        <div className="pc-sym">
          <span className="sym-chip" aria-hidden>{p.symbol.slice(0, 1)}</span>
          <div>
            <b>{p.symbol}</b>
            <div className="pc-tags">
              {mt ? <StatusBadge tone="muted">{mt}</StatusBadge> : null}
              <StatusBadge tone={p.side === "long" ? "ok" : "bad"}>{upper(p.side)}</StatusBadge>
            </div>
          </div>
        </div>
        <div className="pc-pnl">
          <b className={`t-${tone(p.unrealized_pl)}`}>{signedMoney(p.unrealized_pl)}</b>
          <span className={`t-${tone(p.unrealized_plpc * 100)}`}>{fractionPct(p.unrealized_plpc)}</span>
        </div>
      </div>
      <div className="pc-grid">
        <div><span>Qty</span><b>{qty(p.qty)}</b></div>
        <div><span>Avg entry</span><b>{price(p.avg_entry_price)}</b></div>
        <div><span>Current</span><b>{price(p.current_price)}</b></div>
        <div><span>Market value</span><b>{money(p.market_value)}</b></div>
        <div><span>Today</span><b className={`t-${tone(p.change_today * 100)}`}>{fractionPct(p.change_today)}</b></div>
      </div>
    </article>
  );
}

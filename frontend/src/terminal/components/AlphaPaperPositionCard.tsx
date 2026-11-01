import { marketType } from "../classify";
import { NA, pct, price, qty, signedMoney, tone, upper, when } from "../fmt";
import { AnimatedNumber, useFlash } from "../motion";
import type { AlphaPaperPosition } from "../types";
import { StatusBadge } from "./ui";

/** "kraken:SOLUSD" → "Kraken". */
function sourceName(source: string | null): string {
  if (!source) return NA;
  const name = source.split(":")[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function age(seconds: number | null): string {
  if (seconds === null) return NA;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * Internal simulated position from the ALPHA PAPER ledger (filled at truthful reference prices).
 * Never a broker position. P&L is from the last real mark; when that mark is stale it says so.
 */
export function AlphaPaperPositionCard({ p }: { p: AlphaPaperPosition }) {
  const mt = marketType(p.symbol);
  const pnlFlash = useFlash(p.unrealized_pnl);
  const priceFlash = useFlash(p.mark_price);
  const fresh = p.mark_status === "FRESH";
  const pnlTone = p.unrealized_pnl === null ? "na" : tone(p.unrealized_pnl);
  return (
    <article className={`card pos-card ap-card m-lift ${fresh ? "" : "is-stale"}`} aria-label={`ALPHA PAPER position ${p.symbol}`}>
      <div className="ap-label">ALPHA PAPER POSITION · simulated, not a broker position</div>
      <div className="pc-top">
        <div className="pc-sym">
          <span className="sym-chip" aria-hidden>{p.symbol.slice(0, 1)}</span>
          <div>
            <b>{p.symbol}</b>
            <div className="pc-tags">
              {mt ? <StatusBadge tone="muted">{mt}</StatusBadge> : null}
              <StatusBadge tone="ok">{upper(p.side)}</StatusBadge>
              {fresh ? null : <StatusBadge tone="warn" title={p.mark_error ?? undefined}>{p.mark_status}</StatusBadge>}
            </div>
          </div>
        </div>
        <div className={`pc-pnl ${pnlFlash}`}>
          <b>
            {p.unrealized_pnl === null ? (
              <span className="na">{NA}</span>
            ) : (
              <AnimatedNumber id={`ap-upl-${p.id}`} value={p.unrealized_pnl} format={signedMoney} className={`t-${pnlTone}`} />
            )}
          </b>
          <span className={`t-${p.unrealized_pct === null ? "na" : tone(p.unrealized_pct)}`}>{pct(p.unrealized_pct)}</span>
        </div>
      </div>
      <div className="pc-grid">
        <div><span>Qty</span><b>{qty(p.qty)}</b></div>
        <div><span>Avg entry</span><b>{price(p.avg_entry_price)}</b></div>
        <div className={priceFlash}><span>Current</span><b>{price(p.mark_price)}</b></div>
        <div><span>Opened</span><b>{when(p.opened_at)}</b></div>
        <div className="pc-source">
          <span>Price source</span>
          <b title={p.mark_source ?? undefined}>{sourceName(p.mark_source)} · {age(p.mark_age_seconds)}</b>
        </div>
        {p.realized_pnl !== 0 ? (
          <div><span>Realized</span><b className={`t-${tone(p.realized_pnl)}`}>{signedMoney(p.realized_pnl)}</b></div>
        ) : null}
      </div>
      {fresh ? null : (
        <p className="ap-stale">
          {p.mark_error ? `Price refresh failed: ${p.mark_error}. ` : "Mark is old. "}
          P&L shows the last real mark, not a current price.
        </p>
      )}
    </article>
  );
}

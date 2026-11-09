import { money, NA, qty as fmtQty } from "../fmt";
import type { EngineSizing } from "../types";
import { StatusBadge } from "./ui";

const usd = (v: number | null | undefined) => (v === null || v === undefined ? NA : money(v));

/** The engine's position sizing as it reports it: mode, balance, and the latest order's numbers or skip reason. */
export function SizingPanel({ sizing }: { sizing: EngineSizing }) {
  const l = sizing.last;
  const percent = sizing.mode === "percent";
  return (
    <div className="sizing" aria-label="Position sizing">
      <div className="sizing-h">
        <b>Position sizing</b>
        <StatusBadge tone={percent ? "warn" : "muted"}>
          {percent ? `${sizing.risk_pct ?? NA}% OF BALANCE` : `FIXED ${usd(sizing.risk_usd_fixed)}`}
        </StatusBadge>
      </div>
      <div className="sizing-grid">
        {percent ? <div><span>PAPER balance used</span><b>{usd(sizing.capital_usd)}</b></div> : null}
        <div><span>Dollar risk (target)</span><b>{usd(l?.risk_target_usd)}</b></div>
        <div><span>Dollar risk (actual)</span><b>{usd(l?.risk_actual_usd)}</b></div>
        <div><span>Required capital</span><b>{usd(l?.required_capital_usd)}</b></div>
        <div><span>Quantity</span><b>{l?.qty === null || l?.qty === undefined ? NA : `${fmtQty(l.qty)} SOL`}</b></div>
        <div><span>Order value</span><b>{usd(l?.notional_usd)}</b></div>
      </div>
      {!l ? (
        <p className="sizing-note">No order sized yet.</p>
      ) : l.status === "SKIPPED" ? (
        <p className="sizing-note t-warn">Order skipped ({l.code}): {l.reason}</p>
      ) : (
        <p className="sizing-note">
          {l.side} {fmtQty(l.qty)} @ {usd(l.entry)}, stop {usd(l.stop)}
          {l.capped ? ` · capped by ${l.capped_by === "ORDER_LIMIT" ? "the order-value limit" : "the available balance"} (no leverage)` : ""}
          {l.fee_estimate_usd !== null ? ` · est. fees ${usd(l.fee_estimate_usd)} at ${sizing.fee_pct ?? NA}% per side (assumption; the PAPER ledger charges none)` : ""}
          {l.current ? "" : " · from an earlier candle"}
        </p>
      )}
      {percent ? <p className="sizing-note">Long only · no leverage · minimum {sizing.min_qty ?? NA} SOL / {usd(sizing.min_cost)} per order.</p> : null}
    </div>
  );
}

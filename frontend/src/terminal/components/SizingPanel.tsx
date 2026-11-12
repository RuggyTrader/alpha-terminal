import { money, NA, qty as fmtQty } from "../fmt";
import type { EngineSizing } from "../types";
import { StatusBadge } from "./ui";

const usd = (v: number | null | undefined) => (v === null || v === undefined ? NA : money(v));
const CAP: Record<string, string> = {
  BALANCE: "your available equity", ORDER_LIMIT: "the order-value limit", POSITION_LIMIT: "the position exposure limit", TOTAL_EXPOSURE: "the account exposure limit",
};
const check = (ok: boolean | undefined) => (ok === undefined ? NA : ok ? "✓" : "✗");

/**
 * The funded engine's position sizing exactly as it reports it (docs/UNIVERSAL-POSITION-SIZING.md): mode, equity,
 * target and maximum risk, the latest order's quantity, cost and stop risk, the binding limit, the minimum-order checks,
 * and the engine's own explanation. Nothing here is computed or invented by the dashboard.
 */
export function SizingPanel({ sizing }: { sizing: EngineSizing }) {
  const l = sizing.last;
  const percent = sizing.mode === "percent";
  const unit = (sizing.symbol ?? "SOLUSD").replace(/USD$/, "");
  return (
    <div className="sizing" aria-label="Position sizing">
      <div className="sizing-h">
        <b>Position sizing</b>
        <StatusBadge tone={percent ? "ok" : "warn"}>
          {percent ? `${sizing.risk_pct ?? NA}% OF EQUITY${sizing.max_risk_usd ? ` · MAX ${usd(sizing.max_risk_usd)}` : ""}` : `FIXED ${usd(sizing.risk_usd_fixed)}`}
        </StatusBadge>
      </div>
      {!percent ? (
        <p className="sizing-note t-warn">
          Fixed-dollar sizing ignores the available equity{sizing.fixed_reason ? ` (research: ${sizing.fixed_reason})` : ""}. Funded PAPER trading uses percent-of-equity sizing.
        </p>
      ) : null}
      <div className="sizing-grid">
        {percent ? <div><span>Available PAPER capital</span><b>{usd(sizing.capital_usd)}</b></div> : null}
        {percent ? <div><span>Target risk</span><b>{sizing.risk_pct ?? NA}%</b></div> : null}
        {percent ? <div><span>Maximum risk per trade</span><b>{usd(sizing.max_risk_usd)}</b></div> : null}
        <div><span>Calculated risk</span><b>{usd(l?.risk_target_usd)}</b></div>
        <div><span>Actual stop risk</span><b>{usd(l?.risk_actual_usd)}</b></div>
        <div><span>Quantity</span><b>{l?.qty === null || l?.qty === undefined ? NA : `${fmtQty(l.qty)} ${unit}`}</b></div>
        <div><span>Estimated position cost</span><b>{usd(l?.notional_usd)}</b></div>
        {percent ? <div><span>Buying-power cap</span><b>{l ? (l.capped ? `Yes: ${CAP[l.capped_by ?? ""] ?? l.capped_by}` : "No") : NA}</b></div> : null}
        {percent ? <div><span>Minimum order</span><b>{sizing.min_qty ?? NA} {unit} / {usd(sizing.min_cost)}{l?.min_order_cost_usd !== undefined && l?.min_order_cost_usd !== null ? ` (≈ ${usd(l.min_order_cost_usd)} incl. headroom)` : ""}</b></div> : null}
        {percent && l?.checks ? <div><span>Checks: min qty · min value · buying power</span><b>{check(l.checks.min_qty)} · {check(l.checks.min_cost)} · {check(l.checks.buying_power)}</b></div> : null}
      </div>
      {!l ? (
        <p className="sizing-note">No order sized yet.</p>
      ) : l.status === "SKIPPED" ? (
        <p className="sizing-note t-warn">
          <b>Skipped ({l.code}).</b> {l.explanation ? `${l.explanation} ` : ""}{l.reason}
        </p>
      ) : (
        <p className="sizing-note">
          <b>{l.outcome === "REDUCED_TO_FIT" ? "Reduced to fit." : "Accepted for sizing."}</b>{" "}
          {l.explanation ? `${l.explanation} ` : ""}
          {l.side} {fmtQty(l.qty)} {unit} @ {usd(l.entry)}, stop {usd(l.stop)}
          {l.fee_estimate_usd !== null ? ` · est. fees ${usd(l.fee_estimate_usd)} at ${sizing.fee_pct ?? NA}% per side (assumption)` : ""}
          {l.current ? "" : " · from an earlier candle"}
        </p>
      )}
      {percent ? <p className="sizing-note">Long only · no leverage · sized from this market's own PAPER wallet; the Worker re-checks the balance at the live price before accepting.</p> : null}
    </div>
  );
}

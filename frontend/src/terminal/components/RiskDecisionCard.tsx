import { actionLabel, riskChecks, riskLabel } from "../classify";
import { money, price, qty, stamp, text, upper, when } from "../fmt";
import type { RiskRow } from "../types";
import { Code, EmptyState, Expandable, KV, LabelBadge } from "./ui";

export function RiskDecisionCard({ r, defaultOpen = false }: { r: RiskRow; defaultOpen?: boolean }) {
  const act = actionLabel(r.action);
  const checks = riskChecks(r);
  return (
    <Expandable
      tone={r.approved ? "ok" : "bad"}
      defaultOpen={defaultOpen}
      className="risk-card"
      head={
        <>
          <div className="row-a">
            <b className="sym">{text(r.symbol)}</b>
            <span className={`act t-${act.tone}`}>{act.text}</span>
            <span className="time">{when(r.decided_at)}</span>
          </div>
          <div className="row-b">
            <LabelBadge label={riskLabel(r)} />
            <span className="meta">
              Qty <b>{qty(r.final_qty)}</b> · Notional <b>{money(r.estimated_notional)}</b>
            </span>
          </div>
          {r.reason ? <p className="reason">{r.reason}</p> : null}
        </>
      }
    >
      <KV
        rows={[
          ["Risk code", <Code key="c">{r.code}</Code>],
          ["Side", upper(r.side)],
          ["Reference price", price(r.reference_price)],
          ["Price time", <span key="t" className="mono-s">{stamp(r.reference_price_time)}</span>],
          ["Alert ID", <Code key="a">{r.alert_id}</Code>],
          ["Decided", <span key="d" className="mono-s">{stamp(r.decided_at)}</span>],
        ]}
      />
      <div className="checks-t">Individual checks</div>
      {checks.length === 0 ? (
        <EmptyState title="No individual checks were stored for this decision." />
      ) : (
        <ul className="checks">
          {checks.map((c, i) => (
            <li key={`${c.check}-${i}`} className={c.passed ? "pass" : "fail"}>
              <span className="chk-chip">{c.passed ? "✓" : "✕"} {c.check.replace(/_/g, " ")}</span>
              {c.detail ? <span className="chk-d">{c.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Expandable>
  );
}

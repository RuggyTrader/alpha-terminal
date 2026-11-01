import { actionLabel, alertLabel, alertTone, duplicateLabel } from "../classify";
import { qty, stamp, text, upper, when } from "../fmt";
import type { AlertRow } from "../types";
import { Code, Expandable, KV, LabelBadge, StatusBadge } from "./ui";

export function AlertCard({ a, defaultOpen = false }: { a: AlertRow; defaultOpen?: boolean }) {
  const act = actionLabel(a.action);
  const dup = duplicateLabel(a);
  return (
    <Expandable
      tone={alertTone(a)}
      defaultOpen={defaultOpen}
      className="alert-card"
      head={
        <>
          <div className="row-a">
            <b className="sym">{text(a.symbol)}</b>
            <span className={`act t-${act.tone}`}>{act.text}</span>
            {a.strategy ? <span className="strat">{a.strategy}</span> : null}
            <span className="time">{when(a.received_at)}</span>
          </div>
          <div className="row-b">
            <LabelBadge label={alertLabel(a)} />
            {dup ? <StatusBadge tone="warn">{dup.text}</StatusBadge> : null}
          </div>
          {a.rejection_reason ? <p className="reason">{a.rejection_reason}</p> : null}
        </>
      }
    >
      <KV
        rows={[
          ["Alert ID", <Code key="id">{a.alert_id}</Code>],
          ["Strategy", text(a.strategy)],
          ["Received", <span key="r" className="mono-s">{stamp(a.received_at)}</span>],
          ["Requested qty", qty(a.requested_qty)],
          ["Accepted qty", qty(a.accepted_qty)],
          ["Validation", upper(a.validation_result)],
          ["Response", <span key="c" className="mono-s">{a.http_status ?? "—"} {text(a.response_code)}</span>],
          ["Duplicates", String(a.duplicate_count ?? 0)],
          ["Order type", upper(a.order_type)],
        ]}
      />
      {a.rejection_reason ? <p className="detail-reason">{a.rejection_reason}</p> : null}
    </Expandable>
  );
}

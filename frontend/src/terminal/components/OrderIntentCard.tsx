import { actionLabel, orderLabel } from "../classify";
import { qty, stamp, text, upper, when } from "../fmt";
import type { OrderRow } from "../types";
import { Code, Expandable, KV, LabelBadge, StatusBadge } from "./ui";

export function OrderIntentCard({ o, defaultOpen = false }: { o: OrderRow; defaultOpen?: boolean }) {
  const side = actionLabel(o.side);
  const label = orderLabel(o);
  return (
    <Expandable
      tone={label.tone}
      defaultOpen={defaultOpen}
      className="order-card"
      head={
        <>
          <div className="row-a">
            <b className="sym">{o.symbol}</b>
            <span className={`act t-${side.tone}`}>{side.text}</span>
            <span className="meta">
              {qty(o.qty)} · {upper(o.order_type)} · {upper(o.time_in_force)}
            </span>
            <span className="time">{when(o.submitted_at)}</span>
          </div>
          <div className="row-b">
            <LabelBadge label={label} />
            {o.broker_request_sent === false ? null : <StatusBadge tone="bad">BROKER STATUS UNCONFIRMED</StatusBadge>}
          </div>
          {o.error_detail ? <p className="reason">{o.error_detail}</p> : null}
        </>
      }
    >
      <KV
        rows={[
          ["Client order ID", <Code key="c">{o.client_order_id}</Code>],
          ["Alert ID", <Code key="a">{o.alert_id}</Code>],
          ["Strategy", text(o.strategy)],
          ["Source", text(o.source)],
          ["Broker request", o.broker_request_sent === false ? "Not sent (dry run)" : "Unconfirmed"],
          ["Recorded", <span key="r" className="mono-s">{stamp(o.submitted_at)}</span>],
          ["Updated", <span key="u" className="mono-s">{stamp(o.updated_at)}</span>],
        ]}
      />
    </Expandable>
  );
}

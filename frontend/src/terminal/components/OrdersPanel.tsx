import { orderLabel } from "../classify";
import { qty, stamp, upper } from "../fmt";
import type { OrderRow } from "../types";
import { Badge, Clip, DataTable, Empty, LabelBadge, Panel, SkeletonRows, type Column } from "./primitives";

const columns: Column<OrderRow>[] = [
  { key: "coid", header: "Client order ID", render: (o) => <Clip mono width={190}>{o.client_order_id}</Clip> },
  { key: "sym", header: "Symbol", render: (o) => <b className="mono">{o.symbol}</b> },
  { key: "side", header: "Side", render: (o) => <span className={`mono ${o.side === "buy" ? "t-ok" : "t-bad"}`}>{upper(o.side)}</span> },
  { key: "q", header: "Qty", align: "right", render: (o) => <span className="mono">{qty(o.qty)}</span> },
  { key: "type", header: "Type", render: (o) => <span className="mono">{upper(o.order_type)}</span> },
  { key: "tif", header: "TIF", render: (o) => <span className="mono">{upper(o.time_in_force)}</span> },
  { key: "st", header: "Status", render: (o) => <LabelBadge label={orderLabel(o)} /> },
  {
    key: "broker",
    header: "Broker",
    render: (o) =>
      o.broker_request_sent === false ? (
        <Badge tone="muted" title="No request was sent to Alpaca for this intent">NOT SENT</Badge>
      ) : (
        <Badge tone="err" title="Unexpected: backend did not confirm this intent was dry-run only">CHECK</Badge>
      ),
  },
  { key: "t", header: "Recorded", render: (o) => <span className="mono t-dim">{stamp(o.submitted_at)}</span> },
  { key: "err", header: "Detail", render: (o) => <Clip width={220}>{o.error_detail}</Clip> },
];

export function OrdersPanel({ rows, loading }: { rows: OrderRow[] | null; loading: boolean }) {
  return (
    <Panel
      title="Dry-run order intents"
      meta="D1 only"
      right={<Badge tone="warn">NO BROKER ORDER SUBMITTED</Badge>}
      notice="These are dry-run order intents recorded by ALPHA TERMINAL. NO BROKER ORDER SUBMITTED — none of these rows are Alpaca orders or fills."
      className="tp-orders"
    >
      {rows === null ? (
        loading ? <SkeletonRows /> : <Empty>No data</Empty>
      ) : (
        <DataTable
          label="Dry-run order intents"
          columns={columns}
          rows={rows}
          rowKey={(o) => o.id}
          rowClass={(o) => `row-${orderLabel(o).tone}`}
          empty={<Empty>No dry-run order intents yet</Empty>}
        />
      )}
    </Panel>
  );
}

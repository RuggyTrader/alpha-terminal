import { alertLabel, alertRowClass, duplicateLabel } from "../classify";
import { qty, stamp, text, upper } from "../fmt";
import type { AlertRow, DashboardCounts } from "../types";
import { Badge, Clip, DataTable, Empty, LabelBadge, Panel, SkeletonRows, type Column } from "./primitives";

const columns: Column<AlertRow>[] = [
  { key: "t", header: "Received", render: (a) => <span className="mono t-dim">{stamp(a.received_at)}</span> },
  { key: "id", header: "Alert ID", render: (a) => <Clip mono width={170}>{a.alert_id}</Clip> },
  { key: "sym", header: "Symbol", render: (a) => <b className="mono">{text(a.symbol)}</b> },
  { key: "act", header: "Action", render: (a) => <span className="mono">{upper(a.action)}</span> },
  { key: "strat", header: "Strategy", render: (a) => <Clip width={110}>{a.strategy}</Clip> },
  { key: "rq", header: "Req qty", align: "right", render: (a) => <span className="mono">{qty(a.requested_qty)}</span> },
  { key: "aq", header: "Acc qty", align: "right", render: (a) => <span className="mono">{qty(a.accepted_qty)}</span> },
  { key: "val", header: "Validation", render: (a) => <span className="mono">{upper(a.validation_result)}</span> },
  {
    key: "code",
    header: "Response",
    render: (a) => (
      <span className="mono" title={a.response_code ?? undefined}>
        {a.http_status ?? "—"} <Clip mono width={150}>{a.response_code}</Clip>
      </span>
    ),
  },
  { key: "st", header: "Status", render: (a) => <LabelBadge label={alertLabel(a)} /> },
  { key: "why", header: "Rejection reason", render: (a) => <Clip width={240}>{a.rejection_reason}</Clip> },
  {
    key: "dup",
    header: "Dups",
    align: "right",
    render: (a) => {
      const d = duplicateLabel(a);
      return d ? <Badge tone="dup" title={a.last_duplicate_at ? `Last duplicate ${stamp(a.last_duplicate_at)}` : undefined}>{d.text}</Badge> : <span className="t-dim mono">0</span>;
    },
  },
];

export function AlertsPanel({ rows, counts, loading }: { rows: AlertRow[] | null; counts: DashboardCounts | null; loading: boolean }) {
  const c = counts?.alerts;
  return (
    <Panel
      title="Recent alerts"
      meta="TradingView → D1"
      right={
        c ? (
          <span className="tp-counts mono">
            {c.total} total · <span className="t-ok">{c.dry_run} dry-run</span> · <span className="t-bad">{c.rejected} rejected</span> ·{" "}
            <span className="t-dup">{c.duplicates} dup</span>
          </span>
        ) : null
      }
    >
      {rows === null ? (
        loading ? <SkeletonRows /> : <Empty>No data</Empty>
      ) : (
        <DataTable
          label="Recent alerts"
          columns={columns}
          rows={rows}
          rowKey={(a) => a.id}
          rowClass={alertRowClass}
          empty={<Empty>No alerts recorded in D1 yet</Empty>}
        />
      )}
    </Panel>
  );
}

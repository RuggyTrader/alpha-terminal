import { riskChecks, riskLabel } from "../classify";
import { money, price, qty, stamp, text, upper } from "../fmt";
import type { RiskRow } from "../types";
import { Clip, DataTable, Empty, LabelBadge, Panel, SkeletonRows, type Column } from "./primitives";

const columns: Column<RiskRow>[] = [
  { key: "t", header: "Decided", render: (r) => <span className="mono t-dim">{stamp(r.decided_at)}</span> },
  { key: "sym", header: "Symbol", render: (r) => <b className="mono">{text(r.symbol)}</b> },
  { key: "act", header: "Action", render: (r) => <span className="mono">{upper(r.action)}</span> },
  { key: "res", header: "Result", render: (r) => <LabelBadge label={riskLabel(r)} /> },
  { key: "code", header: "Code", render: (r) => <Clip mono width={150}>{r.code}</Clip> },
  { key: "why", header: "Reason", render: (r) => <Clip width={240}>{r.reason}</Clip> },
  { key: "side", header: "Side", render: (r) => <span className="mono">{upper(r.side)}</span> },
  { key: "q", header: "Final qty", align: "right", render: (r) => <span className="mono">{qty(r.final_qty)}</span> },
  { key: "px", header: "Ref price", align: "right", render: (r) => <span className="mono" title={r.reference_price_time ?? undefined}>{price(r.reference_price)}</span> },
  { key: "n", header: "Est. notional", align: "right", render: (r) => <span className="mono">{money(r.estimated_notional)}</span> },
];

function Checks({ r }: { r: RiskRow }) {
  const checks = riskChecks(r);
  if (checks.length === 0) return <Empty>No individual checks were stored for this decision.</Empty>;
  return (
    <ul className="tr-checks">
      {checks.map((c, i) => (
        <li key={`${c.check}-${i}`} className={c.passed ? "pass" : "fail"}>
          <span className="tr-mark" aria-label={c.passed ? "passed" : "failed"}>{c.passed ? "✓" : "✗"}</span>
          <span className="tr-name mono">{c.check}</span>
          <span className="tr-detail">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function RiskPanel({ rows, loading }: { rows: RiskRow[] | null; loading: boolean }) {
  return (
    <Panel title="Risk decisions" meta="PAPER risk engine · click a row for checks">
      {rows === null ? (
        loading ? <SkeletonRows /> : <Empty>No data</Empty>
      ) : (
        <DataTable
          label="Risk decisions"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          rowClass={(r) => (r.approved ? "row-ok" : "row-bad")}
          expand={(r) => <Checks r={r} />}
          empty={<Empty>No risk decisions recorded yet</Empty>}
        />
      )}
    </Panel>
  );
}

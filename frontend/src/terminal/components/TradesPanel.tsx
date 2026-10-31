import { percent, price, qty, signedMoney, stamp, text, tone, upper } from "../fmt";
import type { DashboardCounts, TradeRow } from "../types";
import { Badge, Clip, DataTable, Empty, Panel, SkeletonRows, type Column } from "./primitives";

const columns: Column<TradeRow>[] = [
  { key: "sym", header: "Symbol", render: (t) => <b className="mono">{t.symbol}</b> },
  { key: "dir", header: "Direction", render: (t) => <span className="mono">{upper(t.direction)}</span> },
  { key: "strat", header: "Strategy", render: (t) => <Clip width={110}>{t.strategy}</Clip> },
  { key: "st", header: "Status", render: (t) => <Badge tone={t.status === "OPEN" ? "info" : "muted"}>{text(t.status)}</Badge> },
  { key: "eq", header: "Entry qty", align: "right", render: (t) => <span className="mono">{qty(t.entry_qty)}</span> },
  { key: "ep", header: "Entry avg", align: "right", render: (t) => <span className="mono">{price(t.entry_avg_price)}</span> },
  {
    key: "exit",
    header: "Exit",
    align: "right",
    render: (t) => (
      <span className="mono">
        {qty(t.exit_qty)} @ {price(t.exit_avg_price)}
      </span>
    ),
  },
  { key: "pnl", header: "Realized P&L", align: "right", render: (t) => <span className={`mono t-${tone(t.realized_pnl)}`}>{signedMoney(t.realized_pnl)}</span> },
  { key: "ret", header: "Return", align: "right", render: (t) => <span className={`mono t-${tone(t.return_pct)}`}>{percent(t.return_pct)}</span> },
  { key: "o", header: "Opened", render: (t) => <span className="mono t-dim">{stamp(t.opened_at)}</span> },
  { key: "c", header: "Closed", render: (t) => <span className="mono t-dim">{stamp(t.closed_at)}</span> },
];

export function TradesPanel({ rows, counts, loading }: { rows: TradeRow[] | null; counts: DashboardCounts | null; loading: boolean }) {
  const c = counts?.trades;
  return (
    <Panel
      title="Trades"
      meta="D1 ledger"
      right={c && c.total > 0 ? <span className="tp-counts mono">{c.open} open · {c.closed} closed · realized <span className={`t-${tone(c.realized_pnl)}`}>{signedMoney(c.realized_pnl)}</span></span> : null}
    >
      {rows === null ? (
        loading ? <SkeletonRows rows={2} /> : <Empty>No data</Empty>
      ) : (
        <DataTable
          label="Trades"
          columns={columns}
          rows={rows}
          rowKey={(t) => t.id}
          empty={<Empty>No trades recorded in D1</Empty>}
        />
      )}
    </Panel>
  );
}

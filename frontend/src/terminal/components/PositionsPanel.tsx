import { fractionPct, money, price, qty, signedMoney, tone, upper } from "../fmt";
import type { BrokerSnapshot, PaperPosition } from "../types";
import { Badge, DataTable, Empty, Panel, SkeletonRows, type Column } from "./primitives";

const columns: Column<PaperPosition>[] = [
  { key: "symbol", header: "Symbol", render: (p) => <b className="mono">{p.symbol}</b> },
  { key: "side", header: "Side", render: (p) => <Badge tone={p.side === "long" ? "ok" : "bad"}>{upper(p.side)}</Badge> },
  { key: "qty", header: "Qty", align: "right", render: (p) => <span className="mono">{qty(p.qty)}</span> },
  { key: "avg", header: "Avg entry", align: "right", render: (p) => <span className="mono">{price(p.avg_entry_price)}</span> },
  { key: "cur", header: "Current", align: "right", render: (p) => <span className="mono">{price(p.current_price)}</span> },
  { key: "mv", header: "Market value", align: "right", render: (p) => <span className="mono">{money(p.market_value)}</span> },
  {
    key: "upl",
    header: "Unrealized P&L",
    align: "right",
    render: (p) => <span className={`mono t-${tone(p.unrealized_pl)}`}>{signedMoney(p.unrealized_pl)}</span>,
  },
  {
    key: "uplpc",
    header: "Unrealized %",
    align: "right",
    render: (p) => <span className={`mono t-${tone(p.unrealized_plpc)}`}>{fractionPct(p.unrealized_plpc)}</span>,
  },
  {
    key: "today",
    header: "Today",
    align: "right",
    render: (p) => <span className={`mono t-${tone(p.change_today)}`}>{fractionPct(p.change_today)}</span>,
  },
];

export function PositionsPanel({ broker, loading }: { broker: BrokerSnapshot | null; loading: boolean }) {
  const err = broker?.errors.find((e) => e.source === "positions");
  const rows = broker?.positions ?? [];
  return (
    <Panel title="PAPER positions" meta={broker && !err ? `${rows.length} open` : undefined}>
      {!broker && loading ? (
        <SkeletonRows rows={2} />
      ) : !broker ? (
        <Empty>No data</Empty>
      ) : err ? (
        <Empty tone="warn">
          PAPER positions unavailable: {err.code} — {err.message}
        </Empty>
      ) : (
        <DataTable
          label="PAPER positions"
          columns={columns}
          rows={rows}
          rowKey={(p) => p.symbol}
          empty={<Empty>No open PAPER positions</Empty>}
        />
      )}
    </Panel>
  );
}

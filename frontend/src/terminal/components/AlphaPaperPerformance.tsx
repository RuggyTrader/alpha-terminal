import { NA, signedMoney, tone } from "../fmt";
import { AnimatedNumber, useFlash } from "../motion";
import type { AlphaPaperSection } from "../types";
import { SectionHeader, StatusBadge } from "./ui";

function Stat({ id, k, v }: { id: string; k: string; v: number | null }) {
  const flash = useFlash(v);
  return (
    <div className={`ov ${flash}`}>
      <span className="ov-k">{k}</span>
      {v === null ? (
        <span className="ov-v na">{NA}</span>
      ) : (
        <span className="ov-v">
          <AnimatedNumber id={id} value={v} format={signedMoney} className={`t-${tone(v)}`} />
        </span>
      )}
    </div>
  );
}

/** ALPHA PAPER ledger performance. Simulated; kept apart from the Alpaca PAPER account equity. */
export function AlphaPaperPerformance({ paper }: { paper: AlphaPaperSection }) {
  const p = paper.performance;
  return (
    <section className="card overview ap-perf" aria-label="ALPHA PAPER performance">
      <SectionHeader
        title="ALPHA PAPER performance"
        sub="Simulated ledger · not broker equity"
        right={p.marks_stale ? <StatusBadge tone="warn">STALE MARKS</StatusBadge> : null}
      />
      <div className="ov-grid">
        <Stat id="ap-realized" k="Realized P&L" v={p.realized_pnl} />
        <Stat id="ap-unrealized" k="Unrealized P&L" v={p.unrealized_pnl} />
        <Stat id="ap-total" k="Total P&L" v={p.total_pnl} />
        <div className="ov">
          <span className="ov-k">Open positions</span>
          <span className="ov-v">{p.open_positions}</span>
        </div>
      </div>
    </section>
  );
}

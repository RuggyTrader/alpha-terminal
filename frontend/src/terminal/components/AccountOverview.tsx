import { money, when } from "../fmt";
import type { BrokerSnapshot } from "../types";
import { SectionHeader } from "./ui";

/** Horizontal overview card. Complements the hero instead of repeating it. */
export function AccountOverview({ broker }: { broker: BrokerSnapshot | null }) {
  const a = broker?.account ?? null;
  const posErr = broker?.errors.some((e) => e.source === "positions");
  const clk = broker?.clock ?? null;
  const items: [string, string, string?][] = [
    ["Long exposure", a ? money(a.long_market_value) : "N/A"],
    ["Open positions", broker && !posErr ? String(broker.positions.length) : "N/A"],
    clk
      ? clk.is_open
        ? ["Market closes", when(clk.next_close), "open"]
        : ["Market opens", when(clk.next_open), "closed"]
      : ["Market", "N/A"],
    ["Account", a ? (a.status || "N/A") : "N/A", a?.status === "ACTIVE" ? "ok" : undefined],
  ];
  return (
    <section className="card overview" aria-label="Account overview">
      <SectionHeader title="Account overview" right={<span className="muted-s">Alpaca PAPER</span>} />
      <div className="ov-grid">
        {items.map(([k, v, flag]) => (
          <div key={k} className="ov">
            <span className="ov-k">{k}</span>
            <span className={`ov-v ${v === "N/A" ? "na" : ""} ${flag === "ok" ? "t-pos" : ""}`}>{v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

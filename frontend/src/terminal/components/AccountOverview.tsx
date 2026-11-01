import { money, when } from "../fmt";
import { useFlash } from "../motion";
import type { BrokerSnapshot } from "../types";
import { SectionHeader } from "./ui";

function Item({ k, v, raw, flag, loading }: { k: string; v: string; raw: unknown; flag?: string; loading: boolean }) {
  const flash = useFlash(raw);
  return (
    <div className={`ov ${flash}`}>
      <span className="ov-k">{k}</span>
      {loading ? (
        <i className="ov-skel" aria-hidden />
      ) : (
        <span key={v} className={`ov-v m-crossfade ${v === "N/A" ? "na" : ""} ${flag === "ok" ? "t-pos" : ""}`}>{v}</span>
      )}
    </div>
  );
}

/** Horizontal overview card. Complements the hero instead of repeating it. */
export function AccountOverview({ broker, loading = false }: { broker: BrokerSnapshot | null; loading?: boolean }) {
  const a = broker?.account ?? null;
  const posErr = broker?.errors.some((e) => e.source === "positions");
  const clk = broker?.clock ?? null;
  const posCount = broker && !posErr ? broker.positions.length : null;
  return (
    <section className="card overview" aria-label="Account overview">
      <SectionHeader title="Account overview" right={<span className="muted-s">Alpaca PAPER</span>} />
      <div className="ov-grid">
        <Item k="Long exposure" v={a ? money(a.long_market_value) : "N/A"} raw={a ? a.long_market_value : null} loading={loading} />
        <Item k="Broker positions" v={posCount === null ? "N/A" : String(posCount)} raw={posCount} loading={loading} />
        {clk ? (
          <Item k={clk.is_open ? "Market closes" : "Market opens"} v={when(clk.is_open ? clk.next_close : clk.next_open)} raw={clk.is_open} loading={loading} />
        ) : (
          <Item k="Market" v="N/A" raw={null} loading={loading} />
        )}
        <Item k="Account" v={a ? a.status || "N/A" : "N/A"} raw={a ? a.status : null} flag={a?.status === "ACTIVE" ? "ok" : undefined} loading={loading} />
      </div>
    </section>
  );
}

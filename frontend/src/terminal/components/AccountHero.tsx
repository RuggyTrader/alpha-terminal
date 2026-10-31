import { HeroOrb } from "../../components/icons";
import { CountUpValue } from "../../components/motion";
import { clock, money, pct, signedMoney, todayPct, tone } from "../fmt";
import type { FeedState } from "../poller";

/** Shrink the headline so the full value always fits the hero column. */
export function heroSize(text: string): string {
  const n = text.length;
  if (n <= 8) return "hv-xl";
  if (n <= 10) return "hv-l";
  if (n <= 12) return "hv-m";
  return "hv-s";
}

function HeroStatus({ state }: { state: FeedState }) {
  const clk = state.data?.broker.clock ?? null;
  if (state.status === "stale") return <span className="hs hs-warn"><i />STALE · {clock(state.lastSuccessAt)}</span>;
  if (state.status === "error") return <span className="hs hs-bad"><i />OFFLINE</span>;
  if (!clk) return <span className="hs hs-muted"><i />MARKET N/A</span>;
  return clk.is_open ? <span className="hs hs-ok"><i />MARKET OPEN</span> : <span className="hs hs-muted"><i />MARKET CLOSED</span>;
}

export function AccountHero({ state }: { state: FeedState }) {
  const broker = state.data?.broker ?? null;
  const a = broker?.account ?? null;
  const err = broker?.errors.find((e) => e.source === "account");
  const loading = state.status === "loading" && !state.data;
  const equityText = a ? money(a.equity) : "";
  const pnlPct = a ? todayPct(a.todays_pnl, a.last_equity) : null;

  return (
    <section className={`hero ${state.status === "stale" ? "is-stale" : ""}`} aria-label="PAPER account">
      <HeroOrb />
      <div className="hero-top">
        <div>
          <div className="hero-title">ALPHA TERMINAL</div>
          <span className="hero-badge">PAPER DESK</span>
        </div>
        <HeroStatus state={state} />
      </div>

      <div className="hero-main">
        <div className="hero-label">PAPER EQUITY</div>
        {loading ? (
          <div className="hero-skel" aria-label="Loading equity" />
        ) : a ? (
          <CountUpValue id="hero-equity" value={a.equity} format={money} className={`hero-value ${heroSize(equityText)}`} />
        ) : (
          <div className="hero-value hv-s na">N/A</div>
        )}

        <div className="hero-label hero-label-2">TODAY&apos;S P&amp;L</div>
        {loading ? (
          <div className="hero-skel hero-skel-sm" />
        ) : a ? (
          <div className="hero-pnl">
            <CountUpValue id="hero-today" value={a.todays_pnl} format={signedMoney} className={`t-${tone(a.todays_pnl)}`} />
            {pnlPct !== null ? <span className={`hero-pct t-${tone(pnlPct)}`}>{pct(pnlPct)}</span> : null}
          </div>
        ) : (
          <div className="hero-pnl na">N/A</div>
        )}
        {!a && broker && err ? <div className="hero-err">{err.code === "BROKER_NOT_CONFIGURED" ? "Alpaca PAPER not configured" : "Alpaca PAPER unavailable"}</div> : null}
      </div>

      <div className="hero-strip">
        {[
          ["BUYING POWER", a?.buying_power],
          ["CASH", a?.cash],
          ["PORTFOLIO", a?.portfolio_value],
        ].map(([k, v]) => (
          <div key={k as string}>
            <span>{k as string}</span>
            <b>{loading ? <i className="strip-skel" /> : a ? money(v as number) : "N/A"}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

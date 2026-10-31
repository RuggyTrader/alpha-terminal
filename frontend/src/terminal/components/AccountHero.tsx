import { clock, money, pct, signedMoney, todayPct, tone } from "../fmt";
import { AnimatedNumber, useFlash } from "../motion";
import type { FeedState } from "../poller";
import { AlphaGlobe } from "./AlphaGlobe";

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
  const [cls, text] =
    state.status === "stale" ? ["hs-warn", `STALE · ${clock(state.lastSuccessAt)}`]
      : state.status === "error" ? ["hs-bad", "OFFLINE"]
      : !clk ? ["hs-muted", "MARKET N/A"]
      : clk.is_open ? ["hs-ok", "MARKET OPEN"]
      : ["hs-muted", "MARKET CLOSED"];
  // Keyed by text so a real state change crossfades instead of snapping.
  return (
    <span key={text} className={`hs ${cls} m-crossfade`}>
      <i />
      {text}
    </span>
  );
}

function StripValue({ label, value, loading, has }: { label: string; value: number | undefined; loading: boolean; has: boolean }) {
  const flash = useFlash(has ? value : null);
  return (
    <div>
      <span>{label}</span>
      <b className={flash}>{loading ? <i className="strip-skel" /> : has && value !== undefined ? money(value) : "N/A"}</b>
    </div>
  );
}

export function AccountHero({ state, reconnected = false }: { state: FeedState; reconnected?: boolean }) {
  const broker = state.data?.broker ?? null;
  const a = broker?.account ?? null;
  const err = broker?.errors.find((e) => e.source === "account");
  const loading = state.status === "loading" && !state.data;
  const equityText = a ? money(a.equity) : "";
  const pnlPct = a ? todayPct(a.todays_pnl, a.last_equity) : null;
  const equityFlash = useFlash(a ? a.equity : null);
  const pnlFlash = useFlash(a ? a.todays_pnl : null);

  return (
    <section className={`hero ${state.status === "stale" ? "is-stale" : ""}`} aria-label="PAPER account">
      <AlphaGlobe
        className="hero-globe"
        refreshKey={a ? `${a.equity}|${a.todays_pnl}` : undefined}
        tiltKey={broker?.clock ? broker.clock.is_open : undefined}
        reconnected={reconnected}
      />
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
          <div className={`hero-value-wrap ${equityFlash}`}>
            <AnimatedNumber id="hero-equity" value={a.equity} format={money} className={`hero-value ${heroSize(equityText)}`} />
          </div>
        ) : (
          <div className="hero-value hv-s na m-fade">N/A</div>
        )}

        <div className="hero-label hero-label-2">TODAY&apos;S P&amp;L</div>
        {loading ? (
          <div className="hero-skel hero-skel-sm" />
        ) : a ? (
          <div className={`hero-pnl ${pnlFlash}`}>
            <AnimatedNumber id="hero-today" value={a.todays_pnl} format={signedMoney} className={`t-${tone(a.todays_pnl)}`} />
            {pnlPct !== null ? <span className={`hero-pct t-${tone(pnlPct)}`}>{pct(pnlPct)}</span> : null}
          </div>
        ) : (
          <div className="hero-pnl na m-fade">N/A</div>
        )}
        {!a && broker && err ? (
          <div className="hero-err m-fade">{err.code === "BROKER_NOT_CONFIGURED" ? "Alpaca PAPER not configured" : "Alpaca PAPER unavailable"}</div>
        ) : null}
      </div>

      <div className="hero-strip">
        <StripValue label="BUYING POWER" value={a?.buying_power} loading={loading} has={!!a} />
        <StripValue label="CASH" value={a?.cash} loading={loading} has={!!a} />
        <StripValue label="PORTFOLIO" value={a?.portfolio_value} loading={loading} has={!!a} />
      </div>
    </section>
  );
}

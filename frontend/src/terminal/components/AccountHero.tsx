import { Link } from "react-router-dom";
import { clock, NA, pct, signedMoney, tone } from "../fmt";
import { lifetimeMetrics } from "../performance";
import { AnimatedNumber, useFlash } from "../motion";
import type { FeedState } from "../poller";
import type { VerifiedState } from "../useVerified";
import { AlphaGlobe } from "./AlphaGlobe";

/** Shrink the headline so the full value always fits the hero column. */
export function heroSize(text: string): string {
  const n = text.length;
  if (n <= 8) return "hv-xl";
  if (n <= 10) return "hv-l";
  if (n <= 12) return "hv-m";
  return "hv-s";
}

const BOT_TEXT = { ONLINE: "ONLINE", STALE: "STALE", OFFLINE: "OFFLINE", NOT_RUNNING: "NOT RUNNING" } as const;
const BOT_CLS = { ONLINE: "hs-ok", STALE: "hs-warn", OFFLINE: "hs-bad", NOT_RUNNING: "hs-muted" } as const;

/** The engine's real reported state; the feed's own failure takes precedence. */
function HeroStatus({ state }: { state: FeedState }) {
  const bot = state.data?.bot ?? null;
  const [cls, text] =
    state.status === "stale" ? ["hs-warn", `STALE · ${clock(state.lastSuccessAt)}`]
      : state.status === "error" ? ["hs-bad", "OFFLINE"]
      : !state.data ? ["hs-muted", "CONNECTING"]
      : !bot ? ["hs-muted", "ENGINE N/A"]
      : [BOT_CLS[bot.state] ?? "hs-muted", `ENGINE ${BOT_TEXT[bot.state] ?? bot.state}`];
  return (
    <span key={text} className={`hs ${cls} m-crossfade`}>
      <i />
      {text}
    </span>
  );
}

function Strip({ k, v, t }: { k: string; v: string; t?: string }) {
  const flash = useFlash(v);
  return (
    <div>
      <span>{k}</span>
      <b className={`${flash} ${t ? `t-hero-${t}` : ""}`}>{v}</b>
    </div>
  );
}

/** Headline: verified PAPER results only (closed ALPHA PAPER ledger trades). */
/** A non-funded scope for the hero (Strategy Mirror or one bot), computed by the Home performance selector from the
 *  SAME data it shows. When set, every hero figure belongs to that scope; funded figures are not shown beside it. */
export interface HeroScope { label: string; value: number | null; strip: { k: string; v: string; t?: string }[]; note?: string | null; link: { to: string; text: string } }

export function AccountHero({ state, verified, reconnected = false, scope = null }: { state: FeedState; verified: VerifiedState; reconnected?: boolean; now?: number; scope?: HeroScope | null }) {
  const d = state.data;
  const funded = d?.portfolio?.active ? d.portfolio.totals.net_funding_usd : null;
  const m = lifetimeMetrics(verified.data, funded);
  const loading = (state.status === "loading" && !d) || (verified.status === "loading" && !!d);
  const pnlText = m ? signedMoney(m.totalPnl) : "";
  const flash = useFlash(m ? m.totalPnl : null);

  return (
    <section className={`hero ${state.status === "stale" ? "is-stale" : ""}`} aria-label="Verified PAPER results">
      <AlphaGlobe className="hero-globe" refreshKey={m ? `${m.totalPnl}|${m.trades}` : undefined} tiltKey={d?.bot?.state} reconnected={reconnected} />
      <div className="hero-top">
        <div>
          <div className="hero-title">ALPHA TERMINAL</div>
          <span className="hero-badge">PAPER DESK</span>
          <div><HeroStatus state={state} /></div>
        </div>
      </div>

      <div className="hero-main">
        <div className="hero-label">{scope ? scope.label : "FUNDED PAPER · VERIFIED P&L"}</div>
        {scope ? (
          <div className="hero-value-wrap">
            <span className={`hero-value ${heroSize(scope.value === null ? NA : signedMoney(scope.value))} ${scope.value === null ? "na" : `t-hero-${tone(scope.value)}`}`}>{scope.value === null ? NA : signedMoney(scope.value)}</span>
            {scope.note ? <div className="hero-note">{scope.note}</div> : null}
          </div>
        ) : loading ? (
          <div className="hero-skel" aria-label="Loading verified P&L" />
        ) : m ? (
          <div className={`hero-value-wrap ${flash}`}>
            <AnimatedNumber id="hero-verified" value={m.totalPnl} format={signedMoney} className={`hero-value ${heroSize(pnlText)} t-hero-${tone(m.totalPnl)}`} />
          </div>
        ) : (
          <div className="hero-value hv-s na m-fade">{NA}</div>
        )}
        {scope ? null : (<>
        <div className="hero-label hero-label-2">TOTAL RETURN</div>
        <div className="hero-pnl">
          {m && m.returnPct !== null ? <span className={`t-hero-${tone(m.returnPct)}`}>{pct(m.returnPct)}</span> : <span className="na">{NA}</span>}
          {m && m.returnPct === null && !loading ? <span className="hero-note">no PAPER capital funded</span> : null}
        </div></>)}
        {!scope && !loading && !m ? (
          <div className="hero-err m-fade">{verified.status === "unsupported" ? "Verified history not provided by this backend yet" : verified.error ?? "Complete funded PAPER totals unavailable"}</div>
        ) : null}
      </div>

      {verified.stale && !scope ? <p className="hero-note" role="status">STALE PERFORMANCE · last verified totals retained</p> : null}
      <div className="hero-strip">
        {scope ? scope.strip.map((x) => <Strip key={x.k} k={x.k} v={x.v} t={x.t} />) : (<>
          {/* Return is shown once, above; the strip carries the other headline figures. */}
          <Strip k="CLOSED TRADES" v={m ? String(m.trades) : NA} />
          <Strip k="WIN RATE" v={m && m.winRate !== null ? `${m.winRate.toFixed(1)}%` : NA} />
          <Strip k="PROFIT FACTOR" v={m && m.profitFactor !== null ? m.profitFactor.toFixed(2) : NA} />
        </>)}
      </div>
      <Link to={scope ? scope.link.to : "/performance"} className="hero-link m-press">{scope ? scope.link.text : "Verified performance →"}</Link>
    </section>
  );
}

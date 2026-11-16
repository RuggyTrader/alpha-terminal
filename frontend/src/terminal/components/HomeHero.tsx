// Home hero: the original α globe (left) talking through an attached speech bubble, and the verified funded PAPER
// headline (right). Every figure comes from the same sources as before (lifetimeMetrics over the verified trade set);
// the bubble's lines come from companion.ts (records only). Tapping the globe opens the read-only ALPHA Assistant.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { NA, pct, signedMoney, tone } from "../fmt";
import { lifetimeMetrics } from "../performance";
import { AnimatedNumber, prefersReducedMotion, useFlash } from "../motion";
import type { FeedState } from "../poller";
import type { VerifiedState } from "../useVerified";
import { useFleet } from "../fleetStore";
import { insights, nextInsight, type Insight } from "../companion";
import type { ClosedCard } from "../recentClosed";
import { AlphaGlobe } from "./AlphaGlobe";
import { HeroStatus, heroSize } from "./AccountHero";
import { openAssistant } from "./Assistant";
import { usePrefs } from "../prefs";

export const BUBBLE_MS = 8_000;

/** Picks the globe's current line: rotates every BUBBLE_MS through the ranked lines (with a per-line cooldown), and
 *  switches at once when a more important line appears. */
export function useCompanionLine(list: Insight[]): Insight | null {
  const shown = useRef(new Map<string, number>());
  const [cur, setCur] = useState<Insight | null>(null);
  const top = list[0]?.priority ?? 9;
  const sig = list.map((x) => x.key).join("|");
  useEffect(() => {
    const pick = () => {
      const n = nextInsight(list, shown.current, Date.now());
      if (n) shown.current.set(n.key, Date.now());
      setCur((c) => (c && n && c.key === n.key ? c : n));
    };
    // keep the current line if it is still valid and nothing more important arrived
    setCur((c) => (c && list.some((x) => x.key === c.key) && c.priority <= top ? list.find((x) => x.key === c.key)! : c));
    if (!cur || !list.some((x) => x.key === cur.key) || top < cur.priority) pick();
    const t = window.setInterval(pick, BUBBLE_MS);
    return () => window.clearInterval(t);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return cur;
}

function Strip({ k, v }: { k: string; v: string }) {
  const flash = useFlash(v);
  return (
    <div>
      <span>{k}</span>
      <b className={flash}>{v}</b>
    </div>
  );
}

export function HomeHero({ state, verified, reconnected, closed }: { state: FeedState; verified: VerifiedState; reconnected: boolean; closed: ClosedCard[] }) {
  const d = state.data;
  const funded = d?.portfolio?.active ? d.portfolio.totals.net_funding_usd : null;
  const m = lifetimeMetrics(verified.data, funded);
  const loading = (state.status === "loading" && !d) || (verified.status === "loading" && !!d);
  const { fleet, stale: fleetStale } = useFleet();
  const feedStatus = state.status === "loading" ? "loading" : state.status === "stale" ? "stale" : state.status === "error" ? "error" : "ok";
  // a minute clock so "just closed" and staleness age honestly without re-rendering every second
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t); }, []);
  const list = useMemo(() => insights({ feedStatus, feedAt: state.lastSuccessAt, fleet, fleetStale, metrics: m, closed, now }),
    [feedStatus, state.lastSuccessAt, fleet, fleetStale, m?.totalPnl, m?.trades, closed, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const line = useCompanionLine(list);
  const { companion } = usePrefs();
  const pnlText = m ? signedMoney(m.totalPnl) : "";
  // a brief mood reaction (green for a profitable close, red for a loss, amber for a system issue) on a NEW line only
  const [mood, setMood] = useState<string>("");
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!line || line.key === lastKey.current) return;
    const first = lastKey.current === null;
    lastKey.current = line.key;
    if (first || prefersReducedMotion() || line.mood === "calm") return;
    setMood(`is-${line.mood}`);
    const t = window.setTimeout(() => setMood(""), 1600);
    return () => window.clearTimeout(t);
  }, [line]);

  return (
    <section className={`hh ${state.status === "stale" ? "is-stale" : ""} ${companion === "off" ? "no-bubble" : ""}`} aria-label="Verified PAPER results">
      <div className="hh-left">
        {companion === "on" ? (
          <div className="hh-bubble" role="status" aria-live="polite" aria-atomic="true">
            {line ? <p key={line.key} className={`hh-say hh-say-${line.mood}`}>{line.text}</p> : <p className="hh-say">…</p>}
          </div>
        ) : null}
        <button type="button" className={`hh-globe ${mood}`} onClick={openAssistant} aria-label="Ask ALPHA about your portfolio">
          <AlphaGlobe refreshKey={m ? `${m.totalPnl}|${m.trades}` : undefined} tiltKey={d?.bot?.state} reconnected={reconnected} />
        </button>
      </div>
      <div className="hh-right">
        <div className="hh-id">
          <span className="hero-title">ALPHA TERMINAL</span>
          <span className="hero-badge">PAPER DESK</span>
        </div>
        <HeroStatus state={state} />
        <div className="hero-label">VERIFIED PAPER P&amp;L</div>
        {loading ? (
          <div className="hero-skel" aria-label="Loading verified P&L" />
        ) : m ? (
          <AnimatedNumber id="hero-verified" value={m.totalPnl} format={signedMoney} className={`hero-value ${heroSize(pnlText)} t-hero-${tone(m.totalPnl)}`} />
        ) : (
          <div className="hero-value hv-s na">{NA}</div>
        )}
        <div className="hh-ret">
          <span className="hero-label">TOTAL RETURN</span>
          {m && m.returnPct !== null ? <b className={`t-hero-${tone(m.returnPct)}`}>{pct(m.returnPct)}</b> : <b className="na">{NA}</b>}
        </div>
        {m && m.returnPct === null && !loading ? <div className="hero-note">no PAPER capital funded</div> : null}
        {!loading && !m ? <div className="hero-err">{verified.status === "unsupported" ? "Verified history not provided by this backend yet" : verified.error ?? "Funded PAPER totals unavailable"}</div> : null}
        {verified.stale ? <div className="hero-note" role="status">STALE · last verified totals</div> : null}
      </div>
      <div className="hh-strip">
        <Strip k="CLOSED TRADES" v={m ? String(m.trades) : NA} />
        <Strip k="WIN RATE" v={m && m.winRate !== null ? `${m.winRate.toFixed(1)}%` : NA} />
        <Strip k="PROFIT FACTOR" v={m && m.profitFactor !== null ? m.profitFactor.toFixed(2) : NA} />
        <Link to="/trades?view=performance" className="hh-link m-press">Performance →</Link>
      </div>
    </section>
  );
}

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BotChips, BotPerformanceView } from "../components/BotTradesView";
import { tradeFilter } from "../botTrades";
import { useFundedVerified } from "../fundedTrades";
import { ValuationNotice } from "../components/ValuationNotice";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { costMoney, NA, money, pct, signedMoney, tone, when } from "../fmt";
import type { VerifiedTrade } from "../types";
import { computeMetrics, completeFundedHistory, lifetimeMetrics, MIN_CURVE_TRADES, profitFactorNote, RANGES, type CurvePoint, type Metrics, type Range } from "../performance";
import { useDash } from "../store";
import { useVerified } from "../useVerified";

/** Equity curve of cumulative verified realized P&L. Drawn only from real closes; no interpolation. */
export function EquityCurve({ points }: { points: CurvePoint[] }) {
  const W = 340, H = 150, P = 8;
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const ys = points.map((p) => p.equity);
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  const span = hi - lo || 1;
  const x = (t: number) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = (v: number) => P + (1 - (v - lo) / span) * (H - 2 * P);
  // Equity only changes at a close: draw steps, not slopes between trades.
  let d = `M${x(points[0].t).toFixed(1)},${y(points[0].equity).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) d += ` H${x(points[i].t).toFixed(1)} V${y(points[i].equity).toFixed(1)}`;
  const last = points[points.length - 1].equity;
  return (
    <figure className="curve" aria-label="Verified equity curve">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} className="curve-zero" />
        <path d={d} className={`curve-line m-draw ${last < 0 ? "is-neg" : ""}`} pathLength={1} />
      </svg>
      <figcaption>
        <span>{when(new Date(t0).toISOString())}</span>
        <span>high {signedMoney(hi)} · low {signedMoney(lo)}</span>
        <span>{when(new Date(t1).toISOString())}</span>
      </figcaption>
    </figure>
  );
}

function Metric({ k, v, t, note }: { k: string; v: string; t?: string; note?: string | null }) {
  return (
    <div className="pm">
      <span className="pm-k">{k}</span>
      <b className={`pm-v ${t ? `t-${t}` : ""} ${v === NA ? "na" : ""}`}>{v}</b>
      {note ? <i className="pm-n">{note}</i> : null}
    </div>
  );
}

export function MetricsGrid({ m, balance }: { m: Metrics; balance: number | null }) {
  return (
    <div className="pm-grid">
      <Metric k="TOTAL P&L" v={signedMoney(m.totalPnl)} t={m.trades ? tone(m.totalPnl) : undefined} />
      <Metric k="PORTFOLIO RETURN" v={m.returnPct === null ? NA : pct(m.returnPct)} t={m.returnPct === null ? undefined : tone(m.returnPct)} note={m.returnPct === null ? "no PAPER capital funded" : "of funded PAPER capital"} />
      <Metric k="ACCOUNT EQUITY" v={balance === null ? NA : money(balance)} note={balance === null ? "unavailable" : "cash + collateral + recorded UPL − shortfall"} />
      <Metric k="CLOSED TRADES" v={String(m.trades)} />
      <Metric k="WIN RATE" v={m.winRate === null ? NA : `${m.winRate.toFixed(1)}%`} note={m.trades ? `${m.wins} won · ${m.losses} lost${m.trades - m.wins - m.losses ? ` · ${m.trades - m.wins - m.losses} flat` : ""}` : "no closed trades"} />
      <Metric k="PROFIT FACTOR" v={m.profitFactor === null ? NA : m.profitFactor.toFixed(2)} note={profitFactorNote(m)} />
      <Metric k="EXPECTANCY" v={m.expectancy === null ? NA : signedMoney(m.expectancy)} t={m.expectancy === null ? undefined : tone(m.expectancy)} note={m.trades ? "average per closed trade" : null} />
      <Metric k="MAX DRAWDOWN" v={m.maxDrawdown === null ? NA : money(m.maxDrawdown)} t={m.maxDrawdown ? "neg" : undefined} note={m.trades ? "of cumulative realized P&L" : null} />
    </div>
  );
}

/** Gross, simulated costs and net over the trades in range. Trades closed before cost accounting have no cost record. */
export function costTotals(trades: VerifiedTrade[]) {
  const costed = trades.filter((t) => t.cost_profile !== null && t.cost_profile !== undefined);
  const sum = (f: (t: VerifiedTrade) => number) => Math.round(costed.reduce((s, t) => s + f(t), 0) * 1e6) / 1e6;
  return {
    costed: costed.length,
    uncosted: trades.length - costed.length,
    gross: sum((t) => Number(t.gross_pnl ?? 0)),
    fees: sum((t) => Number(t.fees_usd ?? 0)),
    slippage: sum((t) => Number(t.slippage_usd ?? 0)),
    net: sum((t) => t.realized_pnl),
    profiles: [...new Set(costed.map((t) => t.cost_profile as string))],
  };
}

export function CostBreakdown({ trades }: { trades: VerifiedTrade[] }) {
  const c = costTotals(trades);
  if (c.costed === 0) return null;
  return (
    <section className="card dark-card" aria-label="Execution costs">
      <SectionHeader title="Execution costs" sub={`Simulated · ${c.profiles.join(", ")}`} />
      <div className="card list-card">
        <div className="li"><span>Gross P&amp;L (before costs)</span><b className={`t-${tone(c.gross)}`}>{signedMoney(c.gross)}</b></div>
        <div className="li"><span>Simulated slippage</span><b className="t-neg">{costMoney(c.slippage)}</b></div>
        <div className="li"><span>Simulated fees</span><b className="t-neg">{costMoney(c.fees)}</b></div>
        <div className="li"><span>Net P&amp;L</span><b className={`t-${tone(c.net)}`}>{signedMoney(c.net)}</b></div>
      </div>
      <p className="proof-note">
        {c.costed} trade{c.costed === 1 ? "" : "s"} with simulated costs.
        {c.uncosted > 0 ? ` ${c.uncosted} older trade${c.uncosted === 1 ? "" : "s"} closed before cost accounting count at gross and are not included above.` : ""}
        {" "}Costs are estimates applied to Kraken prices, not exchange executions.
      </p>
    </section>
  );
}

export function PerformancePage({ now = Date.now() }: { now?: number }) {
  const { state } = useDash();
  const v = useFundedVerified(useVerified());
  const [range, setRange] = useState<Range>("ALL");
  const [params] = useSearchParams();
  const botFilter = tradeFilter(params).bot;
  const d = state.data;
  const funded = d?.portfolio?.active ? d.portfolio.totals.net_funding_usd : null;
  const balance = d?.portfolio?.active ? d.portfolio.totals.equity_usd ?? null : null;
  const m = lifetimeMetrics(v.data, funded);
  const history = v.data ? computeMetrics(v.data.trades, range, now, funded) : null;
  const complete = completeFundedHistory(v.data);
  const byId = new Map(v.data?.trades.map(t => [t.id, t]) ?? []);
  const shown = (history?.curve ?? []).flatMap(p => p.tradeId === null ? [] : byId.has(p.tradeId) ? [byId.get(p.tradeId)!] : []);
  return <div className="page-narrow m-stagger">
    <div className="page-head"><Link to="/" className="back-link m-press">← Home</Link><h1 className="page-title">Verified performance</h1>
      <p className="page-sub">Funded PAPER · simulated, not broker money · Mirror is separate</p></div>
    <BotChips base="/performance" active={botFilter} />
    {botFilter ? <BotPerformanceView bot={botFilter} /> : <>
      {v.stale ? <p className="sizing-note t-warn" role="status">STALE PERFORMANCE · last successful lifetime totals retained. {v.error}</p> : null}
      {v.status === "loading" && !m ? <SkeletonCards count={2} tall /> : !m ?
        <EmptyState title="Complete lifetime performance unavailable" tone="warn">{v.error ?? "This backend must provide complete lifetime aggregates. A limited trade list is not used as a substitute."}</EmptyState> : <>
        <section className="card dark-card" aria-label="Verified metrics">
          <SectionHeader title="Lifetime funded PAPER" sub="Complete ledger aggregate · independent of the trade list" right={<StatusBadge tone="ok">VERIFIED PAPER</StatusBadge>} />
          <MetricsGrid m={m} balance={balance} />
          <div className="sizing-grid"><div><span>Lifetime gross P&amp;L</span><b>{signedMoney(v.data!.lifetime!.gross_usd)}</b></div>
            <div><span>Lifetime recorded fees</span><b>{costMoney(v.data!.lifetime!.fees_usd)}</b></div></div>
          <p className="sizing-note">Closed-trade drawdown excludes intratrade unrealized losses. Transfers to MAIN are already counted in trading profit.</p>
          {d?.portfolio ? <ValuationNotice portfolio={d.portfolio} paper={d.paper} feedStale={state.status === "stale" || state.status === "error"} /> : null}
        </section>
        <section className="card dark-card" aria-label="Equity curve">
          <SectionHeader title="Funded trade history" sub="Range controls apply to history only; lifetime headlines above always cover all closed trades." />
          <div className="seg" role="tablist" aria-label="History range" style={{ ["--i" as string]: RANGES.indexOf(range), ["--n" as string]: RANGES.length }}>
            <span className="seg-pill" aria-hidden />{RANGES.map(r => <button key={r} type="button" role="tab" aria-selected={range === r} className={`m-press${range === r ? " on" : ""}`} onClick={() => setRange(r)}>{r}</button>)}
          </div>
          {!complete ? <div className="curve-empty"><b>COMPLETE FUNDED CURVE UNAVAILABLE</b><span>{v.data?.history_error ?? "Only a limited set of trade rows is available. It cannot represent the lifetime equity curve."}</span></div>
            : history && history.curve.length - 1 >= MIN_CURVE_TRADES ? <EquityCurve points={history.curve} /> :
              <div className="curve-empty"><b>NOT ENOUGH VERIFIED TRADING HISTORY</b><span>A curve needs at least {MIN_CURVE_TRADES} closed trades in this range.</span></div>}
        </section>
        {complete ? <CostBreakdown trades={shown} /> : null}
        <section aria-label="Verified trades"><SectionHeader title="Loaded trade history" sub={`${shown.length} loaded rows in ${range}; see Trades for bot filters and older records`} />
          {shown.length ? <div className="card list-card">{shown.slice().reverse().slice(0, 50).map(t => <Link key={t.proof_url ?? t.id} to={t.proof_url ?? `/trades/${t.id}`} className="li li-link m-press">
            <span><b>{t.symbol}</b> · {t.strategy} · {when(t.closed_at)}</span><b className={`t-${tone(t.realized_pnl)}`}>{signedMoney(t.realized_pnl)}</b></Link>)}</div>
            : <EmptyState title="No loaded closed trades">Lifetime totals above remain independent of the loaded history.</EmptyState>}
        </section>
        <section className="card note-card" aria-label="What is excluded"><b>Evidence and scope</b><p>{v.data!.verification}</p>
          <p>Strategy Mirror, engine simulations, open trades and internal profit transfers are excluded from lifetime closed-trade profit.</p>
          {v.data!.excluded_closed_trades > 0 ? <p>{v.data!.excluded_closed_trades} closed trade(s) from other sources are excluded.</p> : null}
          {v.data!.truncated ? <p className="t-warn">Trade history is limited; lifetime metrics above remain complete.</p> : null}
        </section>
      </>}
    </>}
  </div>;
}

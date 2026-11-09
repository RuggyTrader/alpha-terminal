import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { costMoney, NA, money, pct, signedMoney, tone, when } from "../fmt";
import type { VerifiedTrade } from "../types";
import { computeMetrics, MIN_CURVE_TRADES, profitFactorNote, RANGES, type CurvePoint, type Metrics, type Range } from "../performance";
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
      <Metric k="TOTAL P&L" v={m.trades ? signedMoney(m.totalPnl) : NA} t={m.trades ? tone(m.totalPnl) : undefined} />
      <Metric k="PORTFOLIO RETURN" v={m.returnPct === null ? NA : pct(m.returnPct)} t={m.returnPct === null ? undefined : tone(m.returnPct)} note={m.returnPct === null ? "no PAPER capital funded" : "of funded PAPER capital"} />
      <Metric k="VERIFIED BALANCE" v={balance === null ? NA : money(balance)} note={balance === null ? "not funded" : "funding + realized ledger P&L"} />
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
  const v = useVerified();
  const [range, setRange] = useState<Range>("ALL");
  const d = state.data;
  const funded = d?.portfolio?.active ? d.portfolio.totals.net_funding_usd : null;
  const balance = d?.portfolio?.active ? d.portfolio.totals.book_balance_usd : null;
  const m = v.data ? computeMetrics(v.data.trades, range, now, funded) : null;
  const idx = RANGES.indexOf(range);
  const engineSim = d?.bot?.status?.trades ?? null;

  return (
    <div className="page-narrow m-stagger">
      <div className="page-head">
        <Link to="/" className="back-link m-press">← Home</Link>
        <h1 className="page-title">Verified performance</h1>
        <p className="page-sub">Closed ALPHA PAPER ledger trades only · simulated, not broker money</p>
      </div>

      <div className="seg" role="tablist" style={{ ["--i" as string]: idx, ["--n" as string]: RANGES.length }}>
        <span className="seg-pill" aria-hidden />
        {RANGES.map((r) => (
          <button key={r} type="button" role="tab" className={`m-press${range === r ? " on" : ""}`} aria-selected={range === r} onClick={() => setRange(r)}>{r}</button>
        ))}
      </div>

      {v.status === "loading" ? <SkeletonCards count={2} tall />
        : v.status === "unsupported" ? (
          <EmptyState title="Verified performance is not available from this backend yet" tone="warn">
            The deployed Worker does not provide the verified trade history. Nothing is estimated in its place.
          </EmptyState>
        ) : v.status === "error" || !m ? (
          <EmptyState title="Verified performance could not be loaded" tone="bad">{v.error ?? "Unknown error"}</EmptyState>
        ) : (
          <>
            <section className="card dark-card" aria-label="Verified metrics">
              <SectionHeader title={range === "ALL" ? "All verified trades" : `Last ${range}`} right={<StatusBadge tone="ok">VERIFIED PAPER</StatusBadge>} />
              <MetricsGrid m={m} balance={range === "ALL" ? balance : null} />
            </section>

            <CostBreakdown trades={m.curve.filter((p) => p.tradeId !== null).map((p) => v.data!.trades.find((x) => x.id === p.tradeId)!)} />

            <section className="card dark-card" aria-label="Equity curve">
              <SectionHeader title="Equity curve" sub="Cumulative verified realized P&L (net of simulated costs) at each close" />
              {m.curve.length - 1 >= MIN_CURVE_TRADES ? <EquityCurve points={m.curve} /> : (
                <div className="curve-empty">
                  <b>NOT ENOUGH VERIFIED TRADING HISTORY</b>
                  <span>{m.trades === 0 ? "No closed ALPHA PAPER trades in this range." : `${m.trades} closed trade in this range; a curve needs at least ${MIN_CURVE_TRADES}.`}</span>
                </div>
              )}
            </section>

            <section aria-label="Verified trades">
              <SectionHeader title="Verified trades" right={<span className="count">{m.trades}</span>} />
              {m.trades === 0 ? <EmptyState title="No verified trades yet">A trade counts once the ALPHA PAPER ledger fully closes a position.</EmptyState> : (
                <div className="card list-card">
                  {m.curve.filter((p) => p.tradeId !== null).slice().reverse().slice(0, 50).map((p) => {
                    const t = v.data!.trades.find((x) => x.id === p.tradeId)!;
                    return (
                      <Link key={t.id} to={`/trades/${t.id}`} className="li li-link m-press">
                        <span><b>{t.symbol}</b> · {when(t.closed_at)}</span>
                        <b className={`t-${tone(t.realized_pnl)}`}>{signedMoney(t.realized_pnl)}</b>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="card note-card" aria-label="What is excluded">
              <b>What is not counted</b>
              <p>
                {v.data!.verification}
                {v.data!.excluded_closed_trades > 0 ? ` ${v.data!.excluded_closed_trades} closed trade(s) from other sources are excluded.` : ""}
                {engineSim && (engineSim.closed ?? 0) > 0
                  ? ` The engine's own simulation (${engineSim.closed} trades, ${signedMoney(engineSim.net_pnl ?? 0)}) replays history inside the engine and never reached the ledger, so it is not verified.`
                  : ""}
              </p>
              {v.data!.truncated ? <p className="t-warn">Only the oldest 5,000 verified trades were returned.</p> : null}
            </section>
          </>
        )}
    </div>
  );
}

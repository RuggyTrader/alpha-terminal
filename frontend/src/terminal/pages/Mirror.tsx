// Strategy Mirror pages. Every figure here is HYPOTHETICAL (margin 0, unlimited buying power) and is shown apart from
// the funded ALPHA PAPER ledger: the three categories (live, catch-up, historical) are never added together, and no
// mirror number is ever added to a funded total. Nothing is estimated in place of missing data.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { money, NA, price, qty as fmtQty, signedMoney, stamp, tone, when } from "../fmt";
import {
  CATEGORY_INFO, fetchMirror, fetchMirrorProof, fetchMirrorTrades, MIRROR_CATEGORIES, RESULT_LABEL,
  type MirrorCategory, type MirrorMetrics, type MirrorProof, type MirrorSummary, type MirrorTrade,
} from "../mirror";
import { EquityCurve } from "./Performance";

const HEALTH_TONE = { OK: "ok", DEGRADED: "warn", STALE: "warn", DIVERGED: "bad", NOT_ACTIVE: "muted" } as const;
const pf = (v: number | null) => (v === null ? NA : v.toFixed(2));
const lev = (v: number | null) => (v === null ? NA : `${v.toFixed(1)}×`);

function Metric({ k, v, t, note }: { k: string; v: string; t?: string; note?: string | null }) {
  return (
    <div className="pm">
      <span className="pm-k">{k}</span>
      <b className={`pm-v ${t ? `t-${t}` : ""} ${v === NA ? "na" : ""}`}>{v}</b>
      {note ? <i className="pm-n">{note}</i> : null}
    </div>
  );
}

export function HypotheticalBanner({ label, disclosure }: { label: string; disclosure: string }) {
  return (
    <section className="card mirror-banner" aria-label="Hypothetical results">
      <b>{label}</b>
      <p>{disclosure}</p>
      <p>Never added to funded ALPHA PAPER balances or results.</p>
    </section>
  );
}

function HealthCard({ s }: { s: MirrorSummary }) {
  const a = s.account;
  return (
    <section className="card dark-card" aria-label="Mirror health">
      <SectionHeader title="Mirror health and reconciliation" right={<StatusBadge tone={HEALTH_TONE[s.health.state]}>{s.health.state.replace("_", " ")}</StatusBadge>} />
      <div className="card list-card">
        <div className="li"><span>Activated (live observation since)</span><b>{a?.activated_at ? stamp(a.activated_at) : "not yet"}</b></div>
        <div className="li"><span>Last report from the engine</span><b>{a?.last_seen_at ? when(a.last_seen_at) : NA}</b></div>
        <div className="li"><span>Last candle processed</span><b>{a?.last_candle_time ? `${stamp(a.last_candle_time)} · ${price(a.last_candle_close)}` : NA}</b></div>
        <div className="li"><span>Records stored in order</span><b>{s.health.last_contiguous_seq ?? NA}{s.health.max_seq_seen !== undefined && s.health.max_seq_seen !== s.health.last_contiguous_seq ? ` of ${s.health.max_seq_seen}` : ""}</b></div>
        <div className="li"><span>Journal = trade list</span><b className={s.reconciliation?.ok ? "t-ok" : "t-bad"}>{s.reconciliation ? (s.reconciliation.ok ? "Reconciled" : "Mismatch") : NA}</b></div>
        <div className="li"><span>Engine release · inputs</span><b className="mirror-wrap">{a ? `${a.engine_release ?? "development"} · ${a.inputs_hash}` : NA}</b></div>
      </div>
      {s.health.issues.length ? <ul className="mirror-issues">{s.health.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
    </section>
  );
}

export function CategoryView({ c, m, baseline }: { c: MirrorCategory; m: MirrorMetrics; baseline: number }) {
  const info = CATEGORY_INFO[c];
  if (m.trades === 0) {
    return (
      <EmptyState title={`No completed ${info.short.toLowerCase()} trades`}>
        {info.explain} Nothing is shown in their place.
      </EmptyState>
    );
  }
  const r = m.risk;
  const points = [{ t: Date.parse(m.first_trade_at ?? m.curve[0].t), equity: 0, tradeId: null }, ...m.curve.map((p) => ({ t: Date.parse(p.t), equity: p.equity - baseline, tradeId: null }))];
  return (
    <>
      <section className="card dark-card" aria-label={`${info.title} metrics`}>
        <SectionHeader title={info.title} sub={info.explain} right={<StatusBadge tone="warn">HYPOTHETICAL</StatusBadge>} />
        <div className="pm-grid">
          <Metric k="GROSS P&L" v={signedMoney(m.gross_pnl)} t={tone(m.gross_pnl)} note="TradingView-style, 0% commission" />
          <Metric k="MODELLED NET P&L" v={signedMoney(m.net_modelled_pnl)} t={tone(m.net_modelled_pnl)} note="after estimated costs (comparison)" />
          <Metric k="COMPLETED TRADES" v={String(m.trades)} note={`${m.longs} long · ${m.shorts} short`} />
          <Metric k="WIN RATE" v={m.win_rate_pct === null ? NA : `${m.win_rate_pct.toFixed(1)}%`} note={`${m.wins} won · ${m.losses} lost${m.flat ? ` · ${m.flat} flat` : ""}`} />
          <Metric k="PROFIT FACTOR" v={pf(m.profit_factor)} note={m.profit_factor === null ? "no losing trade" : "gross profit ÷ gross loss"} />
          <Metric k="MAX DRAWDOWN" v={money(m.max_drawdown)} t={m.max_drawdown ? "neg" : undefined} note="closed-trade equity, gross" />
        </div>
      </section>

      <section className="card dark-card" aria-label="Long and short">
        <SectionHeader title="LONG and SHORT" sub="Both directions, as the original strategy trades them" />
        <div className="card list-card">
          {(["long", "short"] as const).map((k) => (
            <div className="li" key={k}>
              <span>{k.toUpperCase()} · {m[k].trades} trades · {m[k].wins} won</span>
              <b className={`t-${tone(m[k].gross)}`}>{signedMoney(m[k].gross)} <i className="muted-s">net {signedMoney(m[k].net_modelled)}</i></b>
            </div>
          ))}
        </div>
      </section>

      <section className="card dark-card" aria-label="Hypothetical equity curve">
        <SectionHeader title="Hypothetical equity curve" sub={`Cumulative gross P&L on a ${money(baseline)} reporting baseline, at each close`} />
        {points.length >= 3 ? <EquityCurve points={points} /> : <div className="curve-empty"><b>NOT ENOUGH COMPLETED TRADES</b><span>A curve needs at least 2 closes.</span></div>}
        {r.negative_equity ? (
          <p className="mirror-warn" role="alert">Negative hypothetical equity: the {money(baseline)} baseline went below zero first at {stamp(r.first_negative_at)} (low {money(r.min_equity)}). Not capped, not hidden.</p>
        ) : null}
      </section>

      <section className="card dark-card" aria-label="Margin and capital">
        <SectionHeader title="Margin and capital" sub="Margin 0: unlimited buying power. Shown so the leverage is visible." />
        <div className="card list-card">
          <div className="li"><span>Fixed stop risk per trade</span><b>{r.fixed_risk_usd === null ? NA : money(r.fixed_risk_usd)}</b></div>
          <div className="li"><span>Position notional (median · largest)</span><b>{r.median_notional_usd === null ? NA : money(r.median_notional_usd)} · {money(r.max_notional_usd)}</b></div>
          <div className="li"><span>Largest implied leverage on the baseline</span><b>{lev(r.max_implied_leverage)}</b></div>
          {Object.entries(r.margin_required_usd).map(([l, v]) => <div className="li" key={l}><span>Margin needed for the largest position at {l}</span><b>{money(v)}</b></div>)}
          <div className="li"><span>Lowest hypothetical equity</span><b className={r.negative_equity ? "t-bad" : ""}>{money(r.min_equity)}</b></div>
          {Object.entries(r.liquidation_risk_trades).map(([l, n]) => <div className="li" key={l}><span>Trades whose loss ≥ initial margin at {l}</span><b className={n ? "t-warn" : ""}>{n}</b></div>)}
        </div>
        <p className="proof-note">{r.liquidation_model}</p>
      </section>

      <section className="card dark-card" aria-label="Cost comparison">
        <SectionHeader title="Cost-model comparison" sub="Estimates only; the gross baseline above stays fee-free" />
        <div className="card list-card">
          <div className="li"><span>Gross P&amp;L</span><b className={`t-${tone(m.gross_pnl)}`}>{signedMoney(m.gross_pnl)}</b></div>
          <div className="li"><span>Estimated fees</span><b className="t-neg">{money(-m.est_fees)}</b></div>
          <div className="li"><span>Estimated slippage</span><b className="t-neg">{money(-m.est_slippage)}</b></div>
          <div className="li"><span>Estimated net P&amp;L</span><b className={`t-${tone(m.net_modelled_pnl)}`}>{signedMoney(m.net_modelled_pnl)}</b></div>
        </div>
      </section>
    </>
  );
}

function TradeRow({ t }: { t: MirrorTrade }) {
  return (
    <Link className="li mirror-trade m-press" to={`/mirror/trade/${encodeURIComponent(t.trade_id)}`}>
      <span>
        <b>{t.side}</b> {t.qty.toFixed(2)} · {price(t.entry_price)} → {price(t.exit_price)}
        <i className="muted-s"> {RESULT_LABEL[t.result] ?? t.result} · {stamp(t.exit_time)}</i>
      </span>
      <b className={`t-${tone(t.gross_pnl)}`}>{signedMoney(t.gross_pnl)}</b>
    </Link>
  );
}

export function MirrorView({ s, category, onCategory, trades }: { s: MirrorSummary; category: MirrorCategory; onCategory: (c: MirrorCategory) => void; trades: MirrorTrade[] | null }) {
  const idx = MIRROR_CATEGORIES.indexOf(category);
  const p = s.open_position;
  return (
    <>
      <HypotheticalBanner label={s.label} disclosure={s.disclosure} />
      <HealthCard s={s} />
      {!s.categories || !s.account ? (
        <EmptyState title="The Strategy Mirror has not reported yet">It starts when the engine runs with ENGINE_MIRROR=on. No trades are shown until then.</EmptyState>
      ) : (
        <>
          <div className="seg" role="tablist" style={{ ["--i" as string]: idx, ["--n" as string]: MIRROR_CATEGORIES.length }}>
            <span className="seg-pill" aria-hidden />
            {MIRROR_CATEGORIES.map((c) => (
              <button key={c} type="button" role="tab" className={`m-press${category === c ? " on" : ""}`} aria-selected={category === c} onClick={() => onCategory(c)}>
                {CATEGORY_INFO[c].short} · {s.categories![c].trades}
              </button>
            ))}
          </div>
          <p className="mirror-sep">Each category is measured on its own. They are never added together, and never added to funded PAPER results.</p>
          <CategoryView c={category} m={s.categories[category]} baseline={s.account.reporting_equity_usd} />

          <section className="card dark-card" aria-label="Open hypothetical position">
            <SectionHeader title="Open hypothetical position" right={p ? <StatusBadge tone="warn">HYPOTHETICAL</StatusBadge> : null} />
            {!p ? <p className="proof-note">No open hypothetical position.</p> : (
              <div className="card list-card">
                <div className="li"><span>{p.side} {p.qty === null ? NA : fmtQty(p.qty)} since {stamp(p.entry_time)}</span><b>{price(p.entry_price)}</b></div>
                <div className="li"><span>Stop (initial · current) · TP2</span><b>{price(p.initial_stop)} · {price(p.current_stop)} · {price(p.tp2)}</b></div>
                <div className="li"><span>Notional</span><b>{p.notional_usd === null ? NA : money(p.notional_usd)}</b></div>
                <div className="li"><span>Unrealized at the last close</span><b className={p.unrealized_at_last_close === null ? "" : `t-${tone(p.unrealized_at_last_close)}`}>{p.unrealized_at_last_close === null ? NA : signedMoney(p.unrealized_at_last_close)}</b></div>
              </div>
            )}
          </section>

          <section className="card dark-card" aria-label="Trades">
            <SectionHeader title={`${CATEGORY_INFO[category].short} trades`} sub="Newest first · tap for proof and provenance" />
            {trades === null ? <SkeletonCards count={2} /> : trades.length === 0 ? <p className="proof-note">None in this category.</p> : (
              <div className="card list-card">{trades.map((t) => <TradeRow key={t.trade_id} t={t} />)}</div>
            )}
          </section>

          {s.interruptions.length ? (
            <section className="card dark-card" aria-label="Interrupted positions">
              <SectionHeader title="Interrupted hypothetical positions" sub="A data gap forced a fresh warm-up: no exit and no P&L were invented" />
              <div className="card list-card">
                {s.interruptions.map((i) => <div className="li" key={i.seq}><span>{i.side} {i.qty === undefined ? "" : fmtQty(i.qty)} from {stamp(i.entry_time)}</span><b className="mirror-wrap">{i.reason}</b></div>)}
              </div>
            </section>
          ) : null}

          {s.cost_model ? <p className="proof-note">Cost comparison: {s.cost_model.name}. {s.cost_model.note} {s.cost_model.caveat ?? ""}</p> : null}
        </>
      )}
    </>
  );
}

function errText(e: unknown): string {
  return e instanceof ApiError ? `${e.code}: ${e.message}` : String(e);
}

export function MirrorPage() {
  const [s, setS] = useState<{ status: "loading" | "ok" | "unsupported" | "error"; data: MirrorSummary | null; error: string | null }>({ status: "loading", data: null, error: null });
  const [category, setCategory] = useState<MirrorCategory>("live");
  const [trades, setTrades] = useState<MirrorTrade[] | null>(null);

  useEffect(() => {
    let live = true;
    fetchMirror()
      .then((data) => { if (live) setS({ status: "ok", data, error: null }); })
      .catch((e: unknown) => { if (live) setS({ status: e instanceof ApiError && e.status === 404 ? "unsupported" : "error", data: null, error: errText(e) }); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (s.status !== "ok" || !s.data?.account) return;
    let live = true;
    setTrades(null);
    fetchMirrorTrades(category).then((r) => { if (live) setTrades(r.trades); }).catch(() => { if (live) setTrades([]); });
    return () => { live = false; };
  }, [category, s.status, s.data?.account]);

  return (
    <div className="page-narrow m-stagger mirror-page">
      <div className="page-head">
        <Link to="/engine" className="back-link m-press">← Engine</Link>
        <h1 className="page-title">Strategy Mirror</h1>
        <p className="page-sub">The original strategy, both directions, fixed $10 risk · hypothetical fills, not orders</p>
      </div>
      {s.status === "loading" ? <SkeletonCards count={3} tall />
        : s.status === "unsupported" ? <EmptyState title="The Strategy Mirror is not available from this backend yet" tone="warn">The deployed Worker does not provide it. Nothing is estimated in its place.</EmptyState>
          : s.status === "error" || !s.data ? <EmptyState title="The Strategy Mirror could not be loaded" tone="bad">{s.error}</EmptyState>
            : <MirrorView s={s.data} category={category} onCategory={setCategory} trades={trades} />}
    </div>
  );
}

const CHECK_LABEL: Record<keyof MirrorProof["checks"], string> = {
  gross_equals_price_move: "Gross P&L = (exit − entry) × quantity",
  journal_matches: "Equity journal entry equals the trade's gross P&L",
  net_equals_gross_minus_costs: "Net = gross − estimated fees − estimated slippage",
};

export function MirrorProofView({ p }: { p: MirrorProof }) {
  const t = p.trade;
  const k = p.candles;
  return (
    <>
      <HypotheticalBanner label={p.label} disclosure={p.disclosure} />
      <section className="card dark-card" aria-label="Hypothetical trade">
        <SectionHeader title={`${t.side} ${fmtQty(t.qty)} SOL`} sub={CATEGORY_INFO[t.classification].title} right={<StatusBadge tone="warn">HYPOTHETICAL</StatusBadge>} />
        <div className="card list-card">
          <div className="li"><span>Entry · {stamp(t.entry_time)}</span><b>{price(t.entry_price)}</b></div>
          <div className="li"><span>Exit · {stamp(t.exit_time)} · {RESULT_LABEL[t.result] ?? t.result}</span><b>{price(t.exit_price)}</b></div>
          <div className="li"><span>Initial stop · TP2</span><b>{price(t.stop_price)} · {price(t.tp2_price)}</b></div>
          <div className="li"><span>Fixed risk · notional</span><b>{t.risk_usd === null ? NA : money(t.risk_usd)} · {money(t.notional_usd)}</b></div>
          <div className="li"><span>Gross P&amp;L (TradingView-style)</span><b className={`t-${tone(t.gross_pnl)}`}>{signedMoney(t.gross_pnl)}</b></div>
          <div className="li"><span>Estimated fees · slippage ({String(t.cost_profile ?? "")})</span><b className="t-neg">{money(-t.est_fees)} · {money(-t.est_slippage)}</b></div>
          <div className="li"><span>Modelled net P&amp;L</span><b className={`t-${tone(t.net_modelled_pnl)}`}>{signedMoney(t.net_modelled_pnl)}</b></div>
          <div className="li"><span>Kraken price when received (comparison only)</span><b>{t.reference_price === null ? "not recorded (not live)" : price(t.reference_price)}</b></div>
        </div>
      </section>
      <section className="card dark-card" aria-label="Candles">
        <SectionHeader title="Source candles" sub="Kraken SOLUSD 5m, completed candles the strategy filled on" />
        <div className="card list-card">
          {([["Entry candle", k.entry], ["Exit candle", k.exit]] as const).map(([n, c]) => (
            <div className="li" key={n}><span>{n} · {c ? stamp(c.t) : NA}</span><b className="mirror-wrap">{c ? `O ${price(c.o)} H ${price(c.h)} L ${price(c.l)} C ${price(c.c)}` : "not recorded"}</b></div>
          ))}
        </div>
      </section>
      <section className="card dark-card" aria-label="Provenance">
        <SectionHeader title="Provenance and checks" />
        <div className="card list-card">
          <div className="li"><span>Trade id · sequence</span><b className="mirror-wrap">{t.trade_id} · {t.seq}</b></div>
          <div className="li"><span>Account · inputs hash</span><b className="mirror-wrap">{p.account?.account_id ?? NA}</b></div>
          <div className="li"><span>Engine release</span><b>{String(t.engine_release ?? "development")}</b></div>
          <div className="li"><span>Processed by the engine</span><b>{stamp(t.processed_at)}{t.exit_late ? " (late)" : ""}</b></div>
          <div className="li"><span>Maker/taker (inferred from order types)</span><b>{String(t.entry_liquidity)} / {String(t.exit_liquidity)}</b></div>
          {(Object.keys(CHECK_LABEL) as (keyof MirrorProof["checks"])[]).map((c) => (
            <div className="li" key={c}><span>{CHECK_LABEL[c]}</span><b className={p.checks[c] ? "t-ok" : "t-bad"}>{p.checks[c] ? "Verified" : "FAILED"}</b></div>
          ))}
        </div>
      </section>
    </>
  );
}

export function MirrorTradePage() {
  const { id = "" } = useParams();
  const [s, setS] = useState<{ status: "loading" | "ok" | "error"; p: MirrorProof | null; error: string | null }>({ status: "loading", p: null, error: null });
  useEffect(() => {
    let live = true;
    fetchMirrorProof(id).then((p) => { if (live) setS({ status: "ok", p, error: null }); }).catch((e: unknown) => { if (live) setS({ status: "error", p: null, error: errText(e) }); });
    return () => { live = false; };
  }, [id]);
  return (
    <div className="page-narrow m-stagger mirror-page">
      <div className="page-head">
        <Link to="/mirror" className="back-link m-press">← Strategy Mirror</Link>
        <h1 className="page-title">Mirror trade proof</h1>
      </div>
      {s.status === "loading" ? <SkeletonCards count={2} tall /> : s.status === "error" || !s.p ? <EmptyState title="Trade proof could not be loaded" tone="bad">{s.error}</EmptyState> : <MirrorProofView p={s.p} />}
    </div>
  );
}

/** Small entry point on the Engine page. */
export function MirrorLinkCard() {
  return (
    <Link className="card mirror-link m-press" to="/mirror">
      <span><b>Strategy Mirror</b><i>The original strategy's hypothetical trades, LONG and SHORT · margin 0 · kept apart from funded PAPER</i></span>
      <b aria-hidden>→</b>
    </Link>
  );
}

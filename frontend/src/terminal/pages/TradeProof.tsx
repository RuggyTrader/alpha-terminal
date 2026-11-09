import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { fetchTradeProof } from "../api";
import { marketType, riskChecks } from "../classify";
import { Code, EmptyState, KV, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { NA, num, percent, price, qty, signedMoney, stamp, text, tone, upper } from "../fmt";
import type { ProofFill, TradeProof } from "../types";

type Load = { status: "loading" } | { status: "ok"; proof: TradeProof } | { status: "error"; code: string; message: string };

/** P&L recomputed from the recorded fills (long only: sells − buys) and compared with the stored result. */
export function pnlFromFills(fills: ProofFill[]): { buys: number; sells: number; qtyIn: number; qtyOut: number; pnl: number } | null {
  if (fills.length === 0) return null;
  let buys = 0, sells = 0, qtyIn = 0, qtyOut = 0;
  for (const f of fills) {
    if (f.side === "buy") { buys += f.qty * f.price; qtyIn += f.qty; } else { sells += f.qty * f.price; qtyOut += f.qty; }
  }
  return { buys, sells, qtyIn, qtyOut, pnl: Math.round((sells - buys) * 1e8) / 1e8 };
}

export function ProofView({ proof }: { proof: TradeProof }) {
  const t = proof.trade;
  const calc = pnlFromFills(proof.fills);
  const recorded = num(t.realized_pnl);
  const closed = t.status === "CLOSED";
  const matches = calc !== null && recorded !== null && closed && Math.abs(calc.qtyIn - calc.qtyOut) < 1e-8 && Math.abs(calc.pnl - recorded) < 0.01;
  const mt = marketType(t.symbol);
  return (
    <>
      <section className="card dark-card proof-head" aria-label="Trade summary">
        <div className="proof-top">
          <div>
            <div className="proof-sym">{t.symbol}</div>
            <div className="proof-tags">
              {mt ? <StatusBadge tone="muted">{mt}</StatusBadge> : null}
              <StatusBadge tone="muted">{upper(t.direction)}</StatusBadge>
              {t.strategy ? <StatusBadge tone="warn">{t.strategy}</StatusBadge> : null}
            </div>
          </div>
          <div className="proof-pnl">
            <b className={`t-${tone(t.realized_pnl)}`}>{signedMoney(t.realized_pnl)}</b>
            <span className={`t-${tone(t.return_pct)}`}>{percent(t.return_pct)}</span>
          </div>
        </div>
        <div className="proof-route">
          {price(t.entry_avg_price)} → {closed ? price(t.exit_avg_price) : "open"} · {qty(t.entry_qty)} units
        </div>
        <div className="proof-badge">
          {proof.verified ? <StatusBadge tone="ok">✓ VERIFIED PAPER</StatusBadge> : <StatusBadge tone="warn">NOT VERIFIED</StatusBadge>}
          <span>{proof.verification}</span>
        </div>
      </section>

      <section aria-label="P&L calculation">
        <SectionHeader title="P&L calculation" sub="Recomputed here from the recorded fills" />
        {calc === null ? (
          <EmptyState title="No recorded fills">This trade has no ALPHA PAPER fills, so its P&L cannot be checked.</EmptyState>
        ) : (
          <div className="card list-card">
            <div className="li"><span>Bought</span><b>{qty(calc.qtyIn)} for {price(calc.buys)}</b></div>
            <div className="li"><span>Sold</span><b>{qty(calc.qtyOut)} for {price(calc.sells)}</b></div>
            <div className="li"><span>Sold − bought</span><b className={`t-${tone(calc.pnl)}`}>{signedMoney(calc.pnl)}</b></div>
            <div className="li"><span>Recorded P&L</span><b className={`t-${tone(recorded)}`}>{signedMoney(recorded)}</b></div>
            <div className="li"><span>Return on cost</span><b>{percent(t.return_pct)}</b></div>
            <div className="li"><span>Check</span>
              {matches ? <StatusBadge tone="ok">MATCHES</StatusBadge> : closed ? <StatusBadge tone="bad">DOES NOT MATCH</StatusBadge> : <StatusBadge tone="muted">POSITION OPEN</StatusBadge>}
            </div>
            <p className="proof-note">No fees or slippage are added: each fill is the recorded market reference price at that moment.</p>
          </div>
        )}
      </section>

      <section aria-label="Simulated fills">
        <SectionHeader title="Simulated fills" sub="Market observation used for each fill" right={<span className="count">{proof.fills.length}</span>} />
        {proof.fills.length === 0 ? <EmptyState title="No fills recorded" /> : proof.fills.map((f) => (
          <div key={f.id} className="card proof-card">
            <div className="proof-row"><b>{f.kind}</b><StatusBadge tone={f.side === "buy" ? "ok" : "bad"}>{f.side.toUpperCase()}</StatusBadge></div>
            <KV rows={[
              ["Quantity", qty(f.qty)],
              ["Price", price(f.price)],
              ["Price source", text(f.price_source)],
              ["Price observed", <span key="pa" className="mono-s">{stamp(f.price_at)}</span>],
              ["Filled", <span key="fa" className="mono-s">{stamp(f.filled_at)}</span>],
              ["Realized on this fill", signedMoney(f.realized_pnl)],
              ["Position after", `${qty(f.position_qty_after)} @ ${price(f.avg_entry_after)}`],
              ["Intent id", <Code key="c">{f.client_order_id}</Code>],
            ]} />
          </div>
        ))}
      </section>

      <section aria-label="Strategy decisions">
        <SectionHeader title="Strategy decisions" sub="Signals received from the engine" right={<span className="count">{proof.alerts.length}</span>} />
        {proof.alerts.length === 0 ? <EmptyState title="No signals recorded" /> : proof.alerts.map((a) => (
          <div key={a.alert_id} className="card proof-card">
            <div className="proof-row"><b>{upper(a.action)}</b><span className="muted-s">{text(a.strategy)}</span></div>
            <KV rows={[
              ["Received", <span key="r" className="mono-s">{stamp(a.received_at)}</span>],
              ["Requested qty", qty(a.requested_qty)],
              ["Accepted qty", qty(a.accepted_qty)],
              ["Outcome", text(a.response_code)],
              ...(a.rejection_reason ? [["Reason", a.rejection_reason] as [string, string]] : []),
              ["Signal id", <Code key="id">{a.alert_id}</Code>],
            ]} />
          </div>
        ))}
      </section>

      <section aria-label="Risk decisions">
        <SectionHeader title="Risk decisions" right={<span className="count">{proof.risk_decisions.length}</span>} />
        {proof.risk_decisions.length === 0 ? <EmptyState title="No risk decisions recorded" /> : proof.risk_decisions.map((r) => (
          <div key={r.id} className="card proof-card">
            <div className="proof-row"><b>{r.approved ? "APPROVED" : "REJECTED"}</b><span className="muted-s">{r.code}</span></div>
            <KV rows={[
              ["Decided", <span key="d" className="mono-s">{stamp(r.decided_at)}</span>],
              ["Reference price", price(r.reference_price)],
              ["Price time", <span key="p" className="mono-s">{stamp(r.reference_price_time)}</span>],
              ["Quantity", qty(r.final_qty)],
              ["Notional", price(r.estimated_notional)],
              ["Reason", r.reason || NA],
            ]} />
            <ul className="checks">
              {riskChecks(r).map((c) => (
                <li key={c.check} className={c.passed ? "ok" : "bad"}><b>{c.passed ? "✓" : "✗"} {c.check}</b><span>{c.detail}</span></li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section aria-label="Dry-run intents">
        <SectionHeader title="Dry-run order intents" sub={<StatusBadge tone="warn">NO BROKER ORDER SUBMITTED</StatusBadge>} />
        {proof.orders.length === 0 ? <EmptyState title="No intents recorded" /> : (
          <div className="card list-card">
            {proof.orders.map((o) => (
              <div key={o.id} className="li li-wrap"><span>{o.side.toUpperCase()} {qty(o.qty)} · {o.status}</span><Code>{o.client_order_id}</Code></div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export function TradeProofPage() {
  const { id } = useParams();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    let live = true;
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) { setLoad({ status: "error", code: "INVALID_ID", message: "Not a trade id" }); return; }
    fetchTradeProof(n)
      .then((proof) => live && setLoad({ status: "ok", proof }))
      .catch((e: unknown) => live && setLoad({ status: "error", code: e instanceof ApiError ? e.code : "ERROR", message: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, [id]);

  return (
    <div className="page-narrow m-stagger">
      <div className="page-head">
        <Link to="/trades" className="back-link m-press">← Trades</Link>
        <h1 className="page-title">Trade proof</h1>
        <p className="page-sub">Execution evidence recorded by the Worker</p>
      </div>
      {load.status === "loading" ? <SkeletonCards count={3} tall />
        : load.status === "error" ? (
          <EmptyState
            title={/route not found/i.test(load.message) ? "Trade proof is not available from this backend yet" : load.code === "NOT_FOUND" ? "Trade not found" : "Trade proof could not be loaded"}
            tone={load.code === "NOT_FOUND" ? "muted" : "bad"}
          >
            {load.code}: {load.message}
          </EmptyState>
        ) : <ProofView proof={load.proof} />}
    </div>
  );
}

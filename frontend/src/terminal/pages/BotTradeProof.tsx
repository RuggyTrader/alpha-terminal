// One bot trade's proof (GET /api/dashboard/bot-trade?id=): the orders the bot's engine sent, the simulated fills with
// their price source and fee, every wallet movement (cost/collateral, fees, release, P&L, transfer to MAIN), the events
// it produced, and the Worker's arithmetic checks recomputed from those rows. PAPER only; no broker order exists.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchBotTradeProof, type BotTradeProof } from "../botTrades";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { money, NA, signedMoney, stamp, tone } from "../fmt";

const v = (x: number | null | undefined) => (x === null || x === undefined ? NA : String(x));

export function BotTradeProofView({ p }: { p: BotTradeProof }) {
  const pos = p.position;
  return (
    <>
      <section className="card dark-card" aria-label="Trade">
        <SectionHeader title={`${p.bot?.name ?? pos.bot_id} · ${pos.side} ${pos.qty} ${String(pos.symbol)}`}
          sub={`${p.bot?.bot_id ?? pos.bot_id} · ${p.bot?.profile ?? ""} · config ${p.bot?.inputs_hash ?? NA}`}
          right={<StatusBadge tone={p.all_checks_ok ? "ok" : "bad"}>{p.all_checks_ok ? "CHECKS PASS" : "CHECK FAILED"}</StatusBadge>} />
        <div className="sizing-grid">
          <div><span>Status</span><b>{pos.status}</b></div>
          <div><span>Entry · exit</span><b>{pos.entry_price} · {v(pos.exit_price)}</b></div>
          <div><span>Opened · closed</span><b>{stamp(pos.opened_at)} · {pos.closed_at ? stamp(pos.closed_at) : NA}</b></div>
          <div><span>Strategy stop · target</span><b>{v(pos.stop)} · {v(pos.tp)}</b></div>
          <div><span>{pos.side === "SHORT" ? "Collateral (simulated short)" : "Cost reserved"}</span><b>{pos.collateral_usd === null ? NA : money(pos.collateral_usd)}</b></div>
          <div><span>Fees (entry + exit)</span><b>{money((pos.entry_fee_usd ?? 0) + (pos.exit_fee_usd ?? 0))}</b></div>
          <div><span>Gross P&amp;L</span><b className={pos.gross_usd === null ? "" : `t-${tone(pos.gross_usd)}`}>{pos.gross_usd === null ? NA : signedMoney(pos.gross_usd)}</b></div>
          <div><span>Net P&amp;L</span><b className={pos.net_usd === null ? "" : `t-${tone(pos.net_usd)}`}>{pos.net_usd === null ? NA : signedMoney(pos.net_usd)}</b></div>
          <div><span>Transferred to MAIN</span><b>{pos.swept_usd === null ? NA : money(pos.swept_usd)}</b></div>
          {pos.shortfall_usd ? <div><span>Shortfall</span><b className="t-bad">{money(pos.shortfall_usd)}</b></div> : null}
        </div>
        <p className="sizing-note">{p.labels.mode} · fee model {p.labels.fee_model}{p.labels.short_model ? ` · ${p.labels.short_model}` : ""}</p>
      </section>

      <section className="card list-card" aria-label="Checks">
        <SectionHeader title="Arithmetic checks" sub="Recomputed by the Worker from this trade's own rows" />
        {p.checks.map((c) => <div key={c.name} className="li"><span>{c.name} · {c.detail}</span><StatusBadge tone={c.ok ? "ok" : "bad"}>{c.ok ? "OK" : "MISMATCH"}</StatusBadge></div>)}
      </section>

      <section className="card list-card" aria-label="Orders">
        <SectionHeader title="Orders from the bot's engine" />
        {p.orders.map((o) => (
          <div key={o.order_id} className="li">
            <span><b>{o.action}</b> · {o.order_id} · {stamp(o.received_at)}{o.engine_payload ? ` · requested qty ${v(o.engine_payload.qty)} · stop ${v(o.engine_payload.stop)} · target ${v(o.engine_payload.tp)} · risk ${o.engine_payload.risk_usd === null ? NA : money(o.engine_payload.risk_usd)}` : ""}{o.message ? ` · ${o.message}` : ""}</span>
            <StatusBadge tone={o.status === "ACCEPTED" ? "ok" : "bad"}>{o.status === "ACCEPTED" ? "ACCEPTED" : "REJECTED"}</StatusBadge>
          </div>
        ))}
      </section>

      <section className="card list-card" aria-label="Fills">
        <SectionHeader title="Simulated fills" />
        {p.fills.map((f) => (
          <div key={f.fill_id} className="li"><span><b>{f.kind}</b> {f.side} {f.qty} @ {f.price} ({f.price_source}, {stamp(f.price_at)}) · notional {money(f.notional_usd)}</span><b>fee {money(f.fee_usd)}</b></div>
        ))}
      </section>

      <section className="card list-card" aria-label="Wallet movements">
        <SectionHeader title="Wallet movements" sub="Every ledger entry this trade made" />
        {p.wallet_entries.map((e) => (
          <div key={e.entry_key} className="li"><span><b>{e.kind}</b> · {e.wallet}{e.note ? ` · ${e.note}` : ""}</span><b className="proof-amt"><span>{signedMoney(e.available_change_usd)}</span>{e.reserved_change_usd ? <span className="sub">reserved {signedMoney(e.reserved_change_usd)}</span> : null}</b></div>
        ))}
      </section>

      {p.events.length ? (
        <section className="card list-card" aria-label="Events">
          <SectionHeader title="Notifications and activity" />
          {p.events.map((e, i) => <div key={i} className="li"><span>{e.kind}</span><span>{stamp(e.occurred_at)}</span></div>)}
        </section>
      ) : null}
    </>
  );
}

export function BotTradeProofPage() {
  const { id = "" } = useParams();
  const [p, setP] = useState<BotTradeProof | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setP(undefined); setErr(null);
    fetchBotTradeProof(id).then((x) => { if (live) setP(x); }).catch((e) => { if (live) setErr(String((e as Error).message)); });
    return () => { live = false; };
  }, [id]);
  return (
    <div className="page-narrow m-stagger">
      <div className="page-head">
        <Link to={p?.position ? `/trades?bot=${p.position.bot_id}` : "/trades"} className="back-link m-press">← Trades</Link>
        <h1 className="page-title">Trade proof</h1>
        <p className="page-sub">{id}</p>
      </div>
      {err ? <EmptyState title="Proof unavailable" tone="bad">{err}</EmptyState> : p === undefined ? <SkeletonCards count={3} /> : p === null ? (
        <EmptyState title="No bot trade with this id">Nothing is shown in its place.</EmptyState>
      ) : <BotTradeProofView p={p} />}
    </div>
  );
}

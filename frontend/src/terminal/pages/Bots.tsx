// Bots page: one card per registered bot (read-only). Every number is the bot's own: its PAPER positions, reservation
// and realized results from the ledger, its latest engine report, and, separately labelled, its hypothetical Strategy
// Mirror. Start/stop and entry-pause controls are not part of this release (docs/MULTI-BOT-ARCHITECTURE.md stage F2).

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { money, NA, price, qty as fmtQty, signedMoney, stamp, tone } from "../fmt";
import { botState, fetchBots, pipelineLine, STATE_TONE, type Bot, type Fleet } from "../bots";

const pct = (v: number | null) => (v === null ? NA : `${(v * 100).toFixed(0)}%`);
const pf = (v: number | null) => (v === null ? NA : v.toFixed(2));

export function BotCard({ b, nowMs }: { b: Bot; nowMs: number }) {
  const state = botState(b, nowMs);
  const e = b.engine;
  return (
    <section className="card bot-card" aria-label={`${b.name} ${b.symbol} ${b.timeframe}`}>
      <div className="bot-h">
        <span className="bot-ic" aria-hidden="true">α</span>
        <div>
          <b>{b.name}</b>
          <span className="bot-sub">{b.symbol} · {b.timeframe}{b.profile ? ` · ${b.profile}` : ""}</span>
        </div>
        <StatusBadge tone={STATE_TONE[state]} dot>{state.replace("_", " ")}</StatusBadge>
      </div>
      {b.status === "PROPOSED" ? <p className="sizing-note">Proposed configuration. Not approved and not running; no activity is shown for it.</p> : null}
      <div className="sizing-grid">
        <div><span>Latest candle</span><b>{e?.last_candle_time ? stamp(e.last_candle_time) : NA}</b></div>
        <div><span>Activity</span><b>{b.status === "ACTIVE" ? e?.status_text ?? NA : NA}</b></div>
        <div><span>Open PAPER trades</span><b>{b.open_positions.length}</b></div>
        <div><span>Reserved capital</span><b>{money(b.reserved_usd)}</b></div>
        <div><span>Allocation</span><b>{b.allocation_cap_usd === null ? `Shared ${b.wallet} wallet` : `Cap ${money(b.allocation_cap_usd)}`}</b></div>
        <div><span>Risk</span><b>{b.risk_pct}% · max {money(b.max_risk_usd)}</b></div>
        <div><span>Realized PAPER P&amp;L</span><b className={`t-${tone(b.paper.realized_net_usd)}`}>{signedMoney(b.paper.realized_net_usd)}</b></div>
        <div><span>Trades · win rate · PF</span><b>{b.paper.trades} · {pct(b.paper.win_rate)} · {pf(b.paper.profit_factor)}</b></div>
        <div><span>Max drawdown</span><b>{money(b.paper.max_drawdown_usd)}</b></div>
        <div><span>Ledger check</span><b>{e?.ledger_check?.status ?? NA}</b></div>
      </div>
      {b.open_positions.map((p) => (
        <p key={p.id} className="sizing-note">
          LONG {fmtQty(p.qty)} {p.symbol.replace(/USD$/, "")} @ {price(p.avg_entry_price)} · opened {stamp(p.opened_at)} · {p.open_alert_id}
        </p>
      ))}
      {b.mirror.length ? (
        <div className="bot-mirror" aria-label="Hypothetical Strategy Mirror">
          <b>Strategy Mirror (hypothetical)</b>
          {b.mirror.map((m) => (
            <p key={m.account_id} className="sizing-note">{m.trades} trades · gross {signedMoney(m.gross)} · never added to PAPER results</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function BotsPage() {
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    const load = () => fetchBots().then((f) => { if (live) { setFleet(f); setError(null); setNow(Date.now()); } }).catch((e) => { if (live) setError(String(e?.message ?? e)); });
    load();
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30_000);
    return () => { live = false; clearInterval(id); };
  }, []);
  return (
    <div className="page-narrow m-stagger bots-page">
      <SectionHeader title="Bots" sub={<>Independent strategy instances, one market and timeframe each. <Link className="link" to="/engine">Engine →</Link></>} />
      {error ? <EmptyState title="Bots unavailable" tone="bad">{error}</EmptyState> : null}
      {!fleet && !error ? <SkeletonCards count={2} /> : null}
      {fleet && !fleet.available ? <EmptyState title="No bot registry yet">The ledger has no bot registry (migration 0007 is not applied).</EmptyState> : null}
      {fleet?.available ? (
        <>
          <section className="card" aria-label="Pipeline by bot">
            {fleet.bots.filter((b) => b.status === "ACTIVE").map((b) => <p key={b.bot_id} className="sizing-note">{pipelineLine(b, now)}</p>)}
          </section>
          {fleet.bots.map((b) => <BotCard key={b.bot_id} b={b} nowMs={now} />)}
          <p className="sizing-note">Read-only. Start, stop and pause controls are not available in this release.</p>
        </>
      ) : null}
    </div>
  );
}

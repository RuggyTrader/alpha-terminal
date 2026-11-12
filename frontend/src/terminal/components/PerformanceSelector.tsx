// Home performance selector: ONE dataset at a time, each clearly labelled, never added together.
//   Funded PAPER     closed ALPHA PAPER ledger trades (the same verified metrics as the hero and Performance page)
//   Strategy Mirror  hypothetical TradingView-reference trades, per market, live / catch-up / historical kept apart
//   Bot              one bot's own funded PAPER figures (and its mirror, separately)
// Mirror and bot data are fetched only when their tab is opened. No trades → counts are 0 and rates are N/A.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { NA, signedMoney, money } from "../fmt";
import { computeMetrics } from "../performance";
import { fetchMirrorOverview, type MirrorOverview } from "../mirror";
import { fetchBots, type Fleet } from "../bots";
import type { VerifiedState } from "../useVerified";

export type PerfView = "funded" | "mirror" | "bot";
const rate = (v: number | null) => (v === null ? NA : `${v.toFixed(0)}%`);

export function FundedView({ verified, now }: { verified: VerifiedState; now: number }) {
  const m = verified.data ? computeMetrics(verified.data.trades, "ALL", now, null) : null;
  if (!m) return <p className="sizing-note">Loading funded PAPER results…</p>;
  return (
    <div className="sizing-grid" aria-label="Funded PAPER performance">
      <div><span>Net P&amp;L (closed trades)</span><b>{signedMoney(m.totalPnl)}</b></div>
      <div><span>Closed trades</span><b>{m.trades}</b></div>
      <div><span>Win rate</span><b>{rate(m.winRate)}</b></div>
      <div><span>Profit factor</span><b>{m.profitFactor === null ? NA : m.profitFactor.toFixed(2)}</b></div>
      {m.trades === 0 ? <p className="sizing-note">No funded PAPER trade has closed yet. Strategy Mirror trades are hypothetical and are not counted here.</p> : null}
    </div>
  );
}

export function MirrorView({ overview }: { overview: MirrorOverview | null }) {
  if (!overview) return <p className="sizing-note">Loading Strategy Mirror…</p>;
  return (
    <div aria-label="Strategy Mirror performance">
      <p className="sizing-note"><b>Hypothetical</b> (TradingView reference: $10 risk, unlimited buying power, no fees). Never added to funded PAPER.</p>
      {overview.markets.map((mk) => (
        <div key={mk.account_id} className="pm-market">
          <b>{mk.symbol} {mk.timeframe}</b>
          {(["live", "catch_up", "historical"] as const).map((c) => {
            const t = mk.categories[c];
            return t.trades ? (
              <p key={c} className="sizing-note">{c.replace("_", "-")}: {t.trades} trades ({t.longs} long / {t.shorts} short) · gross {signedMoney(t.gross_pnl)} · modelled net after costs {signedMoney(t.net_modelled_pnl)} · win rate {rate((t.wins / t.trades) * 100)}</p>
            ) : null;
          })}
        </div>
      ))}
      <Link className="link" to="/mirror">Strategy Mirror details →</Link>
    </div>
  );
}

export function BotView({ fleet, botId }: { fleet: Fleet | null; botId: string }) {
  const b = fleet?.bots.find((x) => x.bot_id === botId);
  if (!fleet) return <p className="sizing-note">Loading bots…</p>;
  if (!b) return <p className="sizing-note">No bot selected.</p>;
  return (
    <div className="sizing-grid" aria-label={`${b.name} performance`}>
      <div><span>Net P&amp;L (funded)</span><b>{signedMoney(b.paper.net_usd)}</b></div>
      <div><span>Gross · fees</span><b>{signedMoney(b.paper.gross_usd)} · {money(b.paper.fees_usd)}</b></div>
      <div><span>Closed trades</span><b>{b.paper.trades} ({b.paper.long_trades} L / {b.paper.short_trades} S)</b></div>
      <div><span>Win rate · PF</span><b>{rate(b.paper.win_rate === null ? null : b.paper.win_rate * 100)} · {b.paper.profit_factor === null ? NA : b.paper.profit_factor.toFixed(2)}</b></div>
      <div><span>Transferred to MAIN</span><b>{money(b.funding.profit_swept_to_main_usd)}</b></div>
      {b.mirror[0] ? <div><span>Mirror (hypothetical)</span><b>{b.mirror[0].trades} trades · {signedMoney(b.mirror[0].gross)}</b></div> : null}
    </div>
  );
}

export function PerformanceSelector({ verified, now = Date.now() }: { verified: VerifiedState; now?: number }) {
  const [view, setView] = useState<PerfView>("funded");
  const [overview, setOverview] = useState<MirrorOverview | null>(null);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [botId, setBotId] = useState("");
  useEffect(() => {
    if (view === "mirror" && !overview) fetchMirrorOverview().then(setOverview).catch(() => setOverview({ label: "", disclosure: "", note: "", markets: [] }));
    if (view === "bot" && !fleet) fetchBots().then((f) => { setFleet(f); setBotId((id) => id || (f.bots.find((b) => b.status === "ACTIVE")?.bot_id ?? "")); }).catch(() => setFleet({ available: false, groups: [], bots: [] }));
  }, [view, overview, fleet]);
  return (
    <section className="card hp-card" aria-label="Performance">
      <div className="perf-tabs" role="tablist">
        {(["funded", "mirror", "bot"] as const).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} className={`perf-tab ${view === v ? "is-on" : ""}`} onClick={() => setView(v)}>
            {v === "funded" ? "Funded PAPER" : v === "mirror" ? "Strategy Mirror" : "By bot"}
          </button>
        ))}
      </div>
      {view === "bot" && fleet?.available ? (
        <select className="input" value={botId} onChange={(e) => setBotId(e.target.value)} aria-label="Bot">
          {fleet.bots.filter((b) => b.status !== "DISABLED").map((b) => <option key={b.bot_id} value={b.bot_id}>{b.name} · {b.symbol} {b.timeframe}</option>)}
        </select>
      ) : null}
      {view === "funded" ? <FundedView verified={verified} now={now} /> : view === "mirror" ? <MirrorView overview={overview} /> : <BotView fleet={fleet} botId={botId} />}
      <Link className="link" to="/performance">Full performance →</Link>
    </section>
  );
}

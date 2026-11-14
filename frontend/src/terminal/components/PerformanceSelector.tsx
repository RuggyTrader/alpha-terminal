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
import type { Fleet } from "../bots";
import { useFleet } from "../fleetStore";
import type { VerifiedState } from "../useVerified";
import type { HeroScope } from "./AccountHero";

export type PerfView = "funded" | "mirror" | "bot";
const rate = (v: number | null) => (v === null ? NA : `${v.toFixed(0)}%`);

export function FundedView({ verified, now }: { verified: VerifiedState; now: number }) {
  const m = verified.data ? computeMetrics(verified.data.trades, "ALL", now, null) : null;
  if (!m) return <p className="sizing-note">{verified.status === "error" ? verified.error ?? "Funded PAPER results unavailable." : verified.status === "unsupported" ? "Verified history not provided by this backend yet." : "Loading funded PAPER results…"}</p>;
  return (
    <div className="sizing-grid" aria-label="Funded PAPER performance">
      {/* Net P&L, closed trades, win rate and profit factor are in the hero above (same scope): not repeated here. */}
      <div><span>Wins · losses</span><b>{m.trades ? `${m.wins} · ${m.losses}` : NA}</b></div>
      <div><span>Average per trade (net)</span><b>{m.expectancy === null ? NA : signedMoney(m.expectancy)}</b></div>
      <div><span>Max drawdown (closed)</span><b>{m.maxDrawdown === null ? NA : money(m.maxDrawdown)}</b></div>
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

/** The hero's figures for a non-funded scope, from the same records the selector shows (never mixed with funded). */
export function scopeHero(view: PerfView, overview: MirrorOverview | null, fleet: Fleet | null, botId: string): HeroScope | null {
  if (view === "mirror") {
    if (!overview) return { label: "STRATEGY MIRROR · HYPOTHETICAL GROSS", value: null, strip: [], note: "Loading…", link: { to: "/mirror", text: "Strategy Mirror →" } };
    const all = overview.markets.flatMap((mk) => (["live", "catch_up"] as const).map((c) => mk.categories[c]));
    const sum = (f: (t: (typeof all)[number]) => number) => all.reduce((s, t) => s + (t ? f(t) : 0), 0);
    const trades = sum((t) => t.trades), wins = sum((t) => t.wins);
    return { label: "STRATEGY MIRROR · HYPOTHETICAL GROSS", value: trades ? sum((t) => t.gross_pnl) : null,
      strip: [{ k: "MODELLED NET", v: trades ? signedMoney(sum((t) => t.net_modelled_pnl)) : NA }, { k: "TRADES", v: String(trades) }, { k: "WIN RATE", v: trades ? `${((wins / trades) * 100).toFixed(1)}%` : NA }],
      note: "Hypothetical: TradingView reference, $10 risk, unlimited buying power, no fees. Never added to funded PAPER.", link: { to: "/mirror", text: "Strategy Mirror →" } };
  }
  if (view === "bot") {
    const b = fleet?.bots.find((x) => x.bot_id === botId) ?? null;
    if (!b) return { label: "BY BOT", value: null, strip: [], note: fleet && !fleet.available ? "No bot registry on this backend yet." : "Choose a bot.", link: { to: "/bots", text: "Bots →" } };
    return { label: `${b.name} · ${b.symbol} ${b.timeframe} · FUNDED NET P&L`, value: b.paper.trades ? b.paper.net_usd : null,
      strip: [{ k: "CLOSED TRADES", v: String(b.paper.trades) }, { k: "WIN RATE", v: b.paper.win_rate === null ? NA : `${(b.paper.win_rate * 100).toFixed(1)}%` }, { k: "FEES", v: money(b.paper.fees_usd) }],
      note: b.paper.trades ? null : "NOT YET OBSERVED: no closed trade for this bot.", link: { to: `/performance?bot=${b.bot_id}`, text: `${b.name} performance →` } };
  }
  return null;
}

export function PerformanceSelector({ verified, now = Date.now(), view: cView, onView, onScope }: { verified: VerifiedState; now?: number; view?: PerfView; onView?: (v: PerfView) => void; onScope?: (s: HeroScope | null) => void }) {
  const [own, setOwn] = useState<PerfView>("funded");
  const view = cView ?? own;
  const setView = (v: PerfView) => { setOwn(v); onView?.(v); };
  const [overview, setOverview] = useState<MirrorOverview | null>(null);
  const shared = useFleet();
  const fleet: Fleet | null = shared.fleet ?? (shared.error ? { available: false, groups: [], bots: [] } : null);
  const [picked, setBotId] = useState("");
  const botId = picked || (fleet?.bots.find((b) => b.status === "ACTIVE")?.bot_id ?? "");
  useEffect(() => {
    if (view === "mirror" && !overview) fetchMirrorOverview().then(setOverview).catch(() => setOverview({ label: "", disclosure: "", note: "", markets: [] }));
  }, [view, overview]);
  useEffect(() => { onScope?.(scopeHero(view, overview, fleet, botId)); }, [view, overview, fleet, botId]); // eslint-disable-line react-hooks/exhaustive-deps
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

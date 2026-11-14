// The trade card (progressive disclosure): collapsed = what happened at a glance; expanded = result, why it entered,
// why it exited, the original plan, and actions (chart, full proof, ask ALPHA). Engine ids, payloads and fee
// arithmetic live on the proof page. Every figure is the ledger's; explanations come only from recorded fields.

import { Link } from "react-router-dom";
import { costMoney, money, NA, signedMoney, stamp, tone } from "../fmt";
import { askAlpha } from "../askAlpha";
import { explainEntry, explainExit, hypotheticalFees, planFigures, type TradeView } from "../tradeStory";
import { Expandable, StatusBadge } from "./ui";

const GLYPH: Record<string, string> = { SOLUSD: "◎", BTCUSD: "₿", ETHUSD: "Ξ" };
const px = (v: number | null) => (v === null ? NA : v >= 1000 ? v.toFixed(1) : v.toFixed(2));

export function duration(a: string | null, b: string | null): string | null {
  const s = Date.parse(String(a)), e = Date.parse(String(b));
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  const m = Math.round((e - s) / 60_000);
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

export function TradeStoryCard({ v, defaultOpen = false }: { v: TradeView; defaultOpen?: boolean }) {
  const closed = v.status === "CLOSED";
  const entryWhy = explainEntry(v), exitWhy = explainExit(v);
  const f = planFigures(v);
  const pl = v.story?.plan ?? null;
  const ex = v.story?.exit ?? null;
  const feeFree = v.ledger === "legacy" && (v.costProfile === null || v.costProfile === "none");
  const hypo = feeFree && closed ? hypotheticalFees(v) : null;
  const value = v.qty !== null && v.entry !== null ? v.qty * v.entry : null;
  const dur = duration(v.openedAt, v.closedAt);
  return (
    <Expandable
      tone={closed ? (tone(v.net) === "neg" ? "bad" : tone(v.net) === "pos" ? "ok" : "muted") : "info"}
      className="tcard"
      defaultOpen={defaultOpen}
      head={
        <div className="tc-head">
          <span className="tc-coin" aria-hidden="true">{GLYPH[v.symbol] ?? "α"}</span>
          <div className="tc-main">
            <div className="tc-l1"><b>{v.symbol}</b><span className="tc-bot">{v.botLabel}{v.timeframe ? ` · ${v.timeframe}` : ""}</span>
              <span className={`tc-side ${v.side === "LONG" ? "is-long" : "is-short"}`}>{v.side}</span>{!closed ? <StatusBadge tone="info">OPEN</StatusBadge> : null}
              {v.source === "UNVERIFIED SOURCE" ? <StatusBadge tone="warn">UNVERIFIED SOURCE</StatusBadge> : null}</div>
            <div className="tc-l2">{px(v.entry)} → {closed ? px(v.exit) : "open"}<span className="tc-time">{closed ? (dur ?? "") : stamp(v.openedAt)}</span></div>
          </div>
          <div className="tc-pnl"><b className={v.net === null ? "" : `t-${tone(v.net)}`}>{v.net === null ? "open" : signedMoney(v.net)}</b>
            {v.returnPct !== null ? <span className={`t-${tone(v.returnPct)}`}>{v.returnPct >= 0 ? "+" : ""}{v.returnPct.toFixed(2)}%</span> : null}</div>
        </div>
      }
    >
      <section className="tc-sec" aria-label="Trade result">
        <h4>Trade result</h4>
        <div className="tc-grid">
          <div><span>Position value</span><b>{value === null ? NA : money(value)}</b></div>
          <div><span>Quantity</span><b>{v.qty ?? NA}</b></div>
          <div><span>Entry</span><b>{px(v.entry)}</b></div>
          <div><span>{closed ? "Exit" : "Exit"}</span><b>{closed ? px(v.exit) : "open"}</b></div>
          <div><span>Gross P&amp;L</span><b className={v.gross === null ? "" : `t-${tone(v.gross)}`}>{v.gross === null ? NA : signedMoney(v.gross)}</b></div>
          <div><span>Fees</span><b>{v.fees === null ? "not modelled" : costMoney(v.fees)}</b>{feeFree ? <i>{v.costProfile === null ? "closed before cost accounting" : `fee-free legacy record (cost profile “${v.costProfile}”)`}</i> : null}</div>
          {v.slippage !== null ? <div><span>Slippage</span><b>{costMoney(v.slippage)}</b></div> : null}
          <div><span>Net P&amp;L</span><b className={v.net === null ? "" : `t-${tone(v.net)}`}>{v.net === null ? NA : signedMoney(v.net)}</b></div>
          <div><span>Held</span><b>{dur ?? (closed ? NA : "open")}</b></div>
        </div>
        {hypo ? <p className="tc-note">For comparison only (not charged): at the Ndax-equivalent 0.20% per fill this trade would have paid {money(hypo.fees)} in fees, net {hypo.net === null ? NA : signedMoney(hypo.net)}.</p> : null}
        {v.swept ? <p className="tc-note">{money(v.swept)} of net profit was transferred to MAIN.</p> : null}
        <p className="tc-note">{v.source === "VERIFIED PAPER" ? "✓ VERIFIED PAPER · closed by the ALPHA PAPER ledger · simulated, not broker-executed" : v.source === "ALPHA PAPER" ? "ALPHA PAPER · simulated, not broker-executed" : "Not an ALPHA PAPER ledger trade: excluded from verified performance"}</p>
      </section>
      <section className="tc-sec" aria-label="Why the bot entered">
        <h4>Why the bot entered</h4>
        <p>{entryWhy ?? "Not recorded for this trade: the engine release that placed it did not send its strategy plan. Nothing is reconstructed here; see the proof page for the evidence that exists."}</p>
      </section>
      <section className="tc-sec" aria-label="Why the bot exited">
        <h4>{closed ? "Why the bot exited" : "Position management"}</h4>
        <p>{closed ? (exitWhy ?? "Not recorded for this trade: the engine release that closed it did not send its exit reason.") : "The position is open and managed by its bot (stop, break-even and trailing rules)."}</p>
      </section>
      {pl ? (
        <section className="tc-sec" aria-label="Original trade plan">
          <h4>Original plan</h4>
          <div className="tc-grid">
            <div><span>Planned entry</span><b>{px(pl.planned_entry)}</b></div>
            <div><span>Actual entry</span><b>{px(v.entry)}</b>{f.fillGap ? <i>{f.fillGap > 0 ? "+" : ""}{f.fillGap.toFixed(v.entry !== null && v.entry >= 1000 ? 1 : 2)} vs plan: the PAPER ledger fills at the Kraken price when the signal arrives</i> : null}</div>
            <div><span>Initial stop</span><b>{px(pl.initial_stop)}</b></div>
            <div><span>{closed ? "Stop at exit" : "Current stop"}</span><b>{px(ex?.stop_at_exit ?? pl.initial_stop)}</b></div>
            <div><span>Target (TP2)</span><b>{px(pl.tp2)}</b></div>
            <div><span>Risk · reward</span><b>{f.risk === null ? NA : money(f.risk)} · {f.reward === null ? NA : money(f.reward)}</b>{f.rr ? <i>{f.rr.toFixed(2)} : 1 at this quantity</i> : null}</div>
          </div>
          <p className="tc-note">The planned entry is the strategy's limit level. The PAPER ledger records the fill at the Kraken reference price when the order arrives; it is not an exchange limit order.</p>
        </section>
      ) : null}
      <div className="tc-actions">
        {v.chartUrl ? <Link className="btn" to={v.chartUrl}>View chart</Link> : null}
        <Link className="btn btn-ghost" to={v.proofUrl}>Full trade proof</Link>
        <button className="btn btn-ghost" type="button" onClick={() => askAlpha({ trade: v, question: "What was the point of this trade?" })}>Ask ALPHA about this trade</button>
      </div>
    </Expandable>
  );
}

/** The story at the top of a proof page: why it entered, why it exited, and "Ask ALPHA" for this exact trade. */
export function StorySummary({ v }: { v: TradeView }) {
  const entry = explainEntry(v), exit = explainExit(v);
  return (
    <section className="card tc-story" aria-label="What happened">
      <div className="tc-sec"><h4>Why the bot entered</h4><p>{entry ?? "Not recorded for this trade (the engine release that placed it did not send its strategy plan)."}</p></div>
      <div className="tc-sec"><h4>{v.status === "CLOSED" ? "Why the bot exited" : "Position management"}</h4>
        <p>{v.status === "CLOSED" ? exit ?? "Not recorded for this trade (the engine release that closed it did not send its exit reason)." : "Open, managed by its bot."}</p></div>
      {v.story?.missing?.length ? <p className="tc-note">Missing evidence: {v.story.missing.join("; ")}.</p> : null}
      <div className="tc-actions">
        {v.chartUrl ? <Link className="btn" to={v.chartUrl}>View chart</Link> : null}
        <button className="btn btn-ghost" type="button" onClick={() => askAlpha({ trade: v, question: "What was the point of this trade?" })}>Ask ALPHA about this trade</button>
      </div>
    </section>
  );
}

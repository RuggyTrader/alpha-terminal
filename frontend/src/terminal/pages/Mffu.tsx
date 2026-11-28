// Research · MFFU. Every number on this page is SIMULATED (virtual MFFU research accounts replayed on history).
// Nothing here is an MFFU account, nothing is added to funded PAPER results, and external execution stays DISABLED.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { NA, money, signedMoney } from "../fmt";
import { fetchMffuSnapshot, type MffuAccount, type MffuRun, type MffuSnapshot } from "../mffu";

const pct = (v: number | null | undefined) => (v === null || v === undefined ? NA : `${v.toFixed(1)}%`);
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? NA : v.toFixed(d));
const show = (v: unknown) => (v === null || v === undefined ? "none" : typeof v === "object" ? JSON.stringify(v) : String(v));
const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "muted"> = { ACTIVE: "ok", PASSED: "ok", PAUSED_DLL: "warn", ENDED: "muted", BREACHED: "bad", INACTIVE: "bad", PROMOTED_TO_LIVE: "ok" };

function Metric({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div className="pm">
      <span className="pm-k">{k}</span>
      <b className={`pm-v ${v === NA ? "na" : ""}`}>{v}</b>
      {note ? <i className="pm-n">{note}</i> : null}
    </div>
  );
}

export function SimulatedBanner({ s }: { s: MffuSnapshot }) {
  return (
    <section className="card mirror-banner" aria-label="Simulated results">
      <b>SIMULATED · NOT AN MFFU ACCOUNT · NOT APPROVED BY MFFU</b>
      <p>{s.label}</p>
      <p>{s.demo ? "DEMO DATA: pipeline demonstration on a sample file. These figures are not evidence of anything." : s.data}</p>
      <p>Never added to funded ALPHA PAPER balances or results.</p>
    </section>
  );
}

function AccountCard({ a }: { a: MffuAccount }) {
  return (
    <section className="card dark-card" aria-label="Simulated account">
      <SectionHeader title="Virtual account (end of replay)" sub={`${a.account_id} · ${a.stage.replace("_", " ")}`}
        right={<StatusBadge tone={STATUS_TONE[a.status] ?? "muted"}>{a.status.replace(/_/g, " ")}</StatusBadge>} />
      <div className="pm-grid">
        <Metric k="SIMULATED EQUITY (P&L)" v={signedMoney(a.equity_simulated)} />
        <Metric k="PROFIT TARGET PROGRESS" v={a.profit_target ? pct(a.target_progress_pct) : NA} note={a.profit_target ? `target ${money(a.profit_target)}` : "no target on this stage"} />
        <Metric k="REMAINING DRAWDOWN" v={money(a.remaining_drawdown)} note={`minimum balance ${signedMoney(a.minimum_balance)}`} />
        <Metric k="DAILY LOSS ALLOWANCE" v={a.daily_loss_limit ? money(a.daily_loss_limit) : NA} note={a.daily_allowance_note} />
        <Metric k="CONSISTENCY" v={a.consistency.rule === null ? "no rule" : a.consistency.ok ? "MET" : "NOT MET"}
          note={a.consistency.rule === null ? undefined : `best day ${money(a.consistency.best_day)} vs ${Math.round(a.consistency.rule * 100)}% of ${money(a.consistency.total)}`} />
        <Metric k="TRADING DAYS" v={String(a.trading_days)} note={a.min_trading_days ? `minimum ${a.min_trading_days}` : undefined} />
      </div>
      <div className="card list-card">
        <div className="li"><span>Status reason</span><b>{a.reason || NA}</b></div>
        {Object.entries(a.configuration).map(([k, v]) => <div className="li" key={k}><span>{k.replace(/_/g, " ")}</span><b>{show(v)}</b></div>)}
        <div className="li"><span>Choices made for unresolved rules</span><b>{Object.keys(a.choices).length ? show(a.choices) : "none"}</b></div>
        <div className="li"><span>Rules still unresolved on this stage</span><b>{a.unresolved.length ? a.unresolved.join(", ") : "none"}</b></div>
      </div>
      <SectionHeader title="Rule violations" />
      {a.violations.length ? (
        <div className="card list-card">{a.violations.map((e, i) => <div className="li" key={i}><span>{e.t}</span><b>{e.kind.replace(/_/g, " ")}</b></div>)}</div>
      ) : <EmptyState title="No simulated violations on this account" />}
    </section>
  );
}

function ResultRow({ r }: { r: MffuRun }) {
  const fails = Object.entries(r.failure_reasons).map(([k, v]) => `${k} ×${v}`).join("; ");
  return (
    <div className="card list-card" data-run={r.run}>
      <div className="li"><span><b>{r.plan}</b> · {r.scenario}</span><b>{r.passed}/{r.attempts} passed · {r.breached} breached · {r.open_at_end} open</b></div>
      <div className="li"><span>Pass rate (completed attempts)</span><b>{pct(r.pass_rate_pct)}</b></div>
      <div className="li"><span>Median trading days to pass</span><b>{r.median_trading_days_to_pass ?? NA}</b></div>
      <div className="li"><span>Net P&L, all simulated accounts</span><b className={r.net_pnl < 0 ? "t-neg" : "t-pos"}>{signedMoney(r.net_pnl)}</b></div>
      <div className="li"><span>Profit factor · win rate · expectancy</span><b>{num(r.profit_factor, 3)} · {pct(r.win_rate_pct)} · {r.expectancy === null ? NA : signedMoney(r.expectancy)}</b></div>
      <div className="li"><span>Worst attempt drawdown</span><b>{money(r.worst_drawdown)}</b></div>
      <div className="li"><span>Costs (commission · slippage)</span><b>{money(r.commissions)} · {money(r.slippage)}</b></div>
      <div className="li"><span>Simulated payouts (trader share)</span><b>{money(r.payouts_trader_share)}</b></div>
      <div className="li"><span>Failure reasons</span><b>{fails || "none"}</b></div>
      <div className="li"><span>Orders refused by the compliance gate</span><b>{Object.entries(r.refusals).map(([k, v]) => `${k} ×${v}`).join("; ") || "none"}</b></div>
    </div>
  );
}

export function MffuView({ s }: { s: MffuSnapshot }) {
  const a = "account_id" in s.account ? (s.account as MffuAccount) : null;
  return (
    <div className="page-narrow mirror-page m-stagger">
      <h1 className="page-title">Research · MFFU (simulated)</h1>
      <SimulatedBanner s={s} />
      <section className="card dark-card" aria-label="Integration readiness">
        <SectionHeader title="Integration readiness" right={<StatusBadge tone="bad">EXTERNAL EXECUTION {s.external_execution}</StatusBadge>} />
        <div className="card list-card">
          <div className="li"><span>MFFU approval of ALPHA TERMINAL automation</span><b>{s.integration.mffu_automation_approval}</b></div>
          <div className="li"><span>Supported API route</span><b>{s.integration.supported_api_route}</b></div>
          <div className="li"><span>Owner authorization</span><b>{s.integration.owner_authorization}</b></div>
          <div className="li"><span>Platform selected</span><b>{s.integration.selected ?? "none (candidates: " + s.integration.candidates.join(", ") + ")"}</b></div>
          <div className="li"><span>Adapters available</span><b>local mock and paper simulation only</b></div>
        </div>
      </section>
      <section className="card" aria-label="Run details">
        <div className="card list-card">
          <div className="li"><span>Strategy</span><b>{s.strategy}</b></div>
          <div className="li"><span>Period</span><b>{s.period}</b></div>
          <div className="li"><span>T1 news calendar</span><b>{s.news_calendar}</b></div>
          <div className="li"><span>Snapshot generated</span><b>{s.generatedAt}</b></div>
        </div>
      </section>
      {a ? <AccountCard a={a} /> : <EmptyState title="No simulated account in this snapshot" />}
      <SectionHeader title="Historical evaluation results" sub="Every attempt counted, including failures. A historical simulated pass does not guarantee a real one." />
      {s.results.length ? s.results.map((r) => <ResultRow key={r.run} r={r} />) : <EmptyState title="No runs in this snapshot" />}
      <SectionHeader title="Virtual account plans" sub="Values with their source status: DOCUMENTED, ASSUMPTION or UNRESOLVED." />
      {s.plans.map((p) => (
        <div className="card list-card" key={p.plan}>
          <div className="li"><span><b>{p.plan}</b></span><b>stages read: {p.stages_documented.join(", ").replace(/_/g, " ")}</b></div>
          {Object.entries(p.evaluation).map(([k, v]) => (
            <div className="li" key={k}><span>{k.replace(/_/g, " ")}</span><b>{show(v.value)} <i className="muted-s">{v.status}</i></b></div>
          ))}
        </div>
      ))}
      <SectionHeader title="Unresolved and contradictory rules" />
      <div className="card list-card">
        {s.contradictions.map((c) => <div className="li" key={c.id}><span>{c.id} · {c.topic}</span><b>{c.detail}</b></div>)}
        {s.not_stated.map((n, i) => <div className="li" key={`n${i}`}><span>Not stated</span><b>{n}</b></div>)}
      </div>
      <SectionHeader title="Sources" sub={`Retrieved ${s.retrieved}. MFFU rules change; re-verify before relying on them.`} />
      <div className="card list-card">
        {s.sources.map((x) => <div className="li" key={x.id}><span>{x.id} · {x.page_date}</span><a className="link" href={x.url} target="_blank" rel="noreferrer noopener">{x.title}</a></div>)}
      </div>
      <Link to="/settings" className="back-link m-press">← Settings</Link>
    </div>
  );
}

export function MffuPage() {
  const [snap, setSnap] = useState<MffuSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchMffuSnapshot().then((s) => live && setSnap(s)).catch((e: unknown) => live && setErr(e instanceof Error ? e.message : "Snapshot unavailable"));
    return () => { live = false; };
  }, []);
  if (snap) return <MffuView s={snap} />;
  return (
    <div className="page-narrow m-stagger">
      <h1 className="page-title">Research · MFFU (simulated)</h1>
      {err ? <EmptyState title="MFFU research snapshot unavailable" tone="warn">{err}. External execution remains DISABLED.</EmptyState> : <SkeletonCards count={3} />}
    </div>
  );
}

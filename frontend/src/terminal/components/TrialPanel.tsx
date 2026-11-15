// The forward PAPER trial of Candidate B (BTC daily 50-day trend, long only): a SEPARATE research account. Its numbers
// are never added to the portfolio above; the panel says so and shows them on their own, next to their benchmarks.
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { newRequestId } from "../api";
import { NA, money, signedMoney, tone } from "../fmt";
import { backendErrorMessage } from "../tradeStory";
import { SectionHeader, StatusBadge } from "./ui";

export interface TrialReport {
  available: boolean; label?: string;
  account?: { status: "PROPOSED" | "ACTIVE" | "STOPPED"; activated_at: string | null; last_run_at: string | null; last_error: string | null };
  equity?: { start_usd: number; equity_usd: number; net_usd: number; cash_usd: number; marked_at_close: number | null };
  trades?: { completed: number; gross_usd: number | null; fees_usd: number | null; net_usd: number | null; win_rate: number | null; profit_factor: number | null; avg_net_usd: number | null;
    avg_net_ci95: [number, number] | null; avg_hold_days: number | null; longest_losing_streak: number; evidence: string };
  open_position?: { opened_at: string; qty: number; entry: number; stop: number; initial_stop: number; risk_at_entry_usd: number | null; open_risk_usd: number | null } | null;
  drawdown?: { max_usd: number | null; max_pct: number | null };
  time_in_cash_pct?: number | null;
  benchmarks?: { buy_and_hold_btc: { net_usd: number | null } | null; research: { label: string; periods: { name: string; net_usd: number; trades: number; profit_factor: number }[] } };
  execution?: { orders: string; stops: string; slippage_pct: number; fee_pct_per_fill: number };
}

export const fetchTrial = () => api.get<{ ok: boolean; data?: TrialReport }>("/api/dashboard/trial");
export const activateTrial = (passphrase: string) => api.post<{ ok: boolean; status?: string; note?: string; code?: string; message?: string }>("/api/paper/trial-activate", { request_id: newRequestId(), passphrase });

const pct = (v: number | null | undefined) => (v === null || v === undefined ? NA : `${Math.round(v * 100)}%`);

export function TrialView({ t, onActivated }: { t: TrialReport; onActivated?: () => void }) {
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  if (!t.available || !t.account || !t.equity || !t.trades) return null;
  const a = t.account, e = t.equity, tr = t.trades, p = t.open_position;
  return (
    <section className="card" aria-label="Forward PAPER trial">
      <SectionHeader title="Forward trial · BTC 50-day trend" sub={t.label} right={<StatusBadge tone={a.status === "ACTIVE" ? "ok" : "muted"} dot>{a.status === "ACTIVE" ? "Running" : a.status === "PROPOSED" ? "Not started" : "Stopped"}</StatusBadge>} />
      {a.status === "PROPOSED" ? (
        <div className="bot-alloc-preview">
          <p className="sizing-note">A separate $100 research account (not your portfolio). Daily BTC candles; long only; 2 % risk per trade; 3 x ATR protective and trailing stop; 0.20 % fee and 0.05 % slippage per fill. Settings are frozen. Starts at the first daily close after activation.</p>
          <div className="bot-alloc">
            <input className="input" type="password" autoComplete="current-password" placeholder="Passphrase" aria-label="Passphrase" value={pass} onChange={(ev) => setPass(ev.target.value)} />
            <button className="btn btn-primary" disabled={!pass} onClick={async () => {
              try { const r = await activateTrial(pass); setMsg(r.ok ? "Started. The first decision is made at the next daily close (00:00 UTC)." : backendErrorMessage(r)); if (r.ok) { setPass(""); onActivated?.(); } }
              catch (err) { setMsg(backendErrorMessage(err)); }
            }}>Start the trial</button>
          </div>
          {msg ? <p className="sizing-note" role="status">{msg}</p> : null}
        </div>
      ) : (
        <>
          <div className="sizing-grid bot-key">
            <div><span>Equity (started at {money(e.start_usd)})</span><b>{money(e.equity_usd)}</b></div>
            <div><span>Net P&amp;L</span><b className={`t-${tone(e.net_usd)}`}>{signedMoney(e.net_usd)}</b></div>
            <div><span>Completed trades</span><b>{tr.completed}</b></div>
          </div>
          <div className="sizing-grid">
            <div><span>Gross · fees</span><b>{signedMoney(tr.gross_usd ?? 0)} · {money(tr.fees_usd ?? 0)}</b></div>
            <div><span>Win rate · profit factor</span><b>{pct(tr.win_rate)} · {tr.profit_factor ?? NA}</b></div>
            <div><span>Average net per trade</span><b>{tr.avg_net_usd === null ? NA : signedMoney(tr.avg_net_usd)}{tr.avg_net_ci95 ? ` (95 %: ${signedMoney(tr.avg_net_ci95[0])} to ${signedMoney(tr.avg_net_ci95[1])})` : ""}</b></div>
            <div><span>Max drawdown</span><b>{t.drawdown?.max_pct === null || t.drawdown?.max_pct === undefined ? NA : `${t.drawdown.max_pct}%`}</b></div>
            <div><span>Average hold · longest losing streak</span><b>{tr.avg_hold_days === null ? NA : `${tr.avg_hold_days} days`} · {tr.longest_losing_streak}</b></div>
            <div><span>Time in cash</span><b>{t.time_in_cash_pct === null || t.time_in_cash_pct === undefined ? NA : `${t.time_in_cash_pct}%`}</b></div>
          </div>
          {p ? <p className="sizing-note">Open LONG {p.qty} BTC @ {money(p.entry)} · stop {money(p.stop)} (initial {money(p.initial_stop)}) · risk at entry {money(p.risk_at_entry_usd ?? 0)}{p.open_risk_usd !== null ? ` · open risk ${money(p.open_risk_usd)}` : ""}</p>
            : <p className="sizing-note">In cash. Trades are rare by design (about one a month).</p>}
          <p className="sizing-note">{tr.evidence}. Compare: cash {signedMoney(0)} · buy and hold BTC since the start {t.benchmarks?.buy_and_hold_btc?.net_usd === null || !t.benchmarks?.buy_and_hold_btc ? NA : signedMoney(t.benchmarks.buy_and_hold_btc.net_usd)}.</p>
          {a.last_error ? <p className="sizing-note t-warn">Last run problem: {a.last_error}</p> : null}
        </>
      )}
      {t.benchmarks?.research ? (
        <details className="bot-details"><summary>Historical backtest of the same rule (not forward results)</summary>
          {t.benchmarks.research.periods.map((r) => <p key={r.name} className="sizing-note">{r.name}: {signedMoney(r.net_usd)} · {r.trades} trades · PF {r.profit_factor}</p>)}
          <p className="sizing-note">{t.execution?.orders}. Stops: {t.execution?.stops}.</p>
        </details>
      ) : null}
    </section>
  );
}

export function TrialPanel() {
  const [t, setT] = useState<TrialReport | null>(null);
  const load = () => { fetchTrial().then((r) => setT(r.ok && r.data ? r.data : null)).catch(() => setT(null)); };
  useEffect(load, []);
  return t ? <TrialView t={t} onActivated={load} /> : null;
}

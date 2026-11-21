// The S3 research-only shadow test: a fully SIMULATED $100 account (BTC $50 + ETH $50), separate from every bot and the
// funded PAPER portfolio. Read-only report, plus the existing one-time owner activation (passphrase) for this account.
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { newRequestId } from "../api";
import { NA, money, signedMoney, tone } from "../fmt";
import { backendErrorMessage } from "../tradeStory";
import { SectionHeader, StatusBadge } from "./ui";

export const S3_ACCOUNT = "TRIAL-S3-SHADOW";

export interface S3Report {
  available: boolean; label?: string;
  account?: { status: "PROPOSED" | "ACTIVE" | "STOPPED"; activated_at: string | null; last_run_at: string | null; last_error: string | null; last_daily_t: number | null };
  alerts?: { drawdown_levels_pct: number[]; note: string };
  equity?: { start_usd: number; equity_usd: number | null; net_usd: number | null; max_drawdown_pct: number | null; current_drawdown_pct: number | null; days: number };
  latest_signals?: { asset: string; day_t: number; close: number; sma: number | null; target: number | null; actual_weight: number }[];
  orders?: { filled: number; skipped_below_minimum: number; missed_after_outage: number; pending: number; fees_usd: number | null };
  events?: { at: string; kind: string; detail_json: string | null }[];
}

export const fetchS3 = () => api.get<{ ok: boolean; data?: S3Report }>("/api/dashboard/trial/s3");
/** The existing one-time activation (/api/paper/trial-activate), for the S3 shadow account only. */
export const activateS3 = (passphrase: string) =>
  api.post<{ ok: boolean; status?: string; note?: string; code?: string; message?: string }>("/api/paper/trial-activate", { request_id: newRequestId(), passphrase, account: S3_ACCOUNT });

const w = (v: number | null | undefined) => (v === null || v === undefined ? NA : `${Math.round(v * 100)}%`);
const day = (t: number | null | undefined) => (t ? new Date(t).toISOString().slice(0, 10) : NA);

export function S3ShadowView({ t, onActivated, activate = activateS3 }: { t: S3Report; onActivated?: () => void; activate?: typeof activateS3 }) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!t.available || !t.account) return null;
  const a = t.account, e = t.equity, o = t.orders;
  const alerts = (t.events ?? []).filter((x) => x.kind === "DRAWDOWN_ALERT");
  return (
    <section className="card" aria-label="S3 shadow test">
      <SectionHeader title="S3 shadow test · BTC + ETH" sub="A simulated $100 research account. Not part of your bots, your PAPER portfolio, its balances or its P&L. S3 is a candidate, not an approved strategy."
        right={<StatusBadge tone={a.status === "ACTIVE" ? "ok" : "muted"} dot>{a.status === "ACTIVE" ? "Running" : a.status === "PROPOSED" ? "Not started" : "Stopped"}</StatusBadge>} />
      {a.status === "PROPOSED" ? (
        <div className="bot-alloc-preview">
          <p className="sizing-note">Frozen rule: daily at the UTC close, hold BTC and ETH only above their 200-day average, sized to 40 % yearly volatility, long only, no leverage. Simulated fills with 0.20 % fee, 0.05 % slippage and Kraken's minimum order sizes. Nothing is sent to an exchange.</p>
          <p className="sizing-note">Drawdown alerts at 2 % and 30 % are for information only; they do not stop the simulation and are not risk limits for your funded PAPER trading. The first decision is made at the first daily close (00:00 UTC) after you start it.</p>
          <form className="bot-alloc" onSubmit={async (ev) => {
            ev.preventDefault();
            if (!pass || busy) return;
            setBusy(true); setMsg(null);
            try { const r = await activate(pass); setMsg(r.ok ? "S3 shadow test started. The first decision is made at the next daily close (00:00 UTC)." : backendErrorMessage(r)); if (r.ok) { setPass(""); onActivated?.(); } }
            catch (err) { setMsg(backendErrorMessage(err)); }
            finally { setBusy(false); }
          }}>
            <input className="input" type="password" autoComplete="current-password" placeholder="Passphrase" aria-label="Passphrase" value={pass} onChange={(ev) => setPass(ev.target.value)} />
            <button className="btn btn-primary" type="submit" disabled={!pass || busy}>{busy ? "Starting…" : "Activate S3 Shadow"}</button>
          </form>
          {msg ? <p className="sizing-note" role="status">{msg}</p> : null}
        </div>
      ) : (
        <>
          <div className="sizing-grid bot-key">
            <div><span>Simulated equity (started at {money(e?.start_usd ?? 100)})</span><b>{e?.equity_usd === null || e?.equity_usd === undefined ? money(100) : money(e.equity_usd)}</b></div>
            <div><span>Net</span><b className={`t-${tone(e?.net_usd ?? 0)}`}>{signedMoney(e?.net_usd ?? 0)}</b></div>
            <div><span>Max drawdown · now</span><b>{e?.max_drawdown_pct ?? 0}% · {e?.current_drawdown_pct ?? 0}%</b></div>
          </div>
          <div className="sizing-grid">
            <div><span>Days recorded</span><b>{e?.days ?? 0}</b></div>
            <div><span>Orders filled · skipped (minimum)</span><b>{o?.filled ?? 0} · {o?.skipped_below_minimum ?? 0}</b></div>
            <div><span>Fees (simulated)</span><b>{money(o?.fees_usd ?? 0)}</b></div>
            <div><span>Last daily close processed</span><b>{day(a.last_daily_t)}</b></div>
          </div>
          {(t.latest_signals ?? []).map((s) => (
            <p key={s.asset} className="sizing-note">{s.asset} {day(s.day_t)}: close {money(s.close)} vs 200-day {s.sma === null ? NA : money(s.sma)} · target {w(s.target)} · held {w(s.actual_weight)}</p>
          ))}
          {!(t.latest_signals ?? []).length ? <p className="sizing-note">Waiting for the first daily close (00:00 UTC).</p> : null}
          {alerts.length ? <p className="sizing-note t-warn">{alerts.length} drawdown alert{alerts.length > 1 ? "s" : ""} recorded (information only; the simulation continues).</p> : null}
          {a.last_error ? <p className="sizing-note t-warn">Last run problem: {a.last_error}</p> : null}
        </>
      )}
    </section>
  );
}

export function S3ShadowPanel() {
  const [t, setT] = useState<S3Report | null>(null);
  const load = () => { fetchS3().then((r) => setT(r.ok && r.data ? r.data : null)).catch(() => setT(null)); };
  useEffect(load, []);
  return t ? <S3ShadowView t={t} onActivated={load} /> : null;
}

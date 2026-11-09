import { NA, price, qty, signedMoney, tone, when } from "../fmt";
import type { EngineBot } from "../types";
import { SectionHeader, StatusBadge } from "./ui";

const TONE = { ONLINE: "ok", STALE: "warn", OFFLINE: "bad", NOT_RUNNING: "muted" } as const;

function ago(s: number | null): string {
  if (s === null) return NA;
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** The local / VPS OTE engine (no TradingView). Liveness is judged by the Worker from the heartbeat's age. */
export function EngineBotCard({ bot }: { bot: EngineBot }) {
  const s = bot.status;
  const state = bot.state;
  const p = s?.position ?? null;
  return (
    <section className="card overview bot-card" aria-label="OTE engine">
      <SectionHeader
        title="OTE engine · Kraken"
        sub={s ? `${s.symbol ?? NA} · ${s.timeframe ?? NA} · PAPER simulation${s.profile && s.profile !== "default" ? ` · ${s.profile} profile ($${s.risk_usd ?? NA} risk)` : ""}` : "Automated PAPER engine"}
        right={<StatusBadge tone={TONE[state] ?? "muted"} dot>{state === "NOT_RUNNING" ? "NOT RUNNING" : state}</StatusBadge>}
      />
      {!s ? (
        <p className="muted-s">The engine has not reported yet.</p>
      ) : (
        <>
          <div className="ov-grid">
            <div className="ov"><span className="ov-k">Status</span><span className="ov-v">{s.status_text || NA}</span></div>
            <div className="ov"><span className="ov-k">Last heard</span><span className={`ov-v ${state === "ONLINE" ? "" : "t-warn"}`}>{ago(bot.age_seconds)}</span></div>
            <div className="ov"><span className="ov-k">Last candle</span><span className="ov-v">{when(s.last_candle_time)} · {price(s.last_candle_close)}</span></div>
            <div className="ov">
              <span className="ov-k">Engine simulation · not verified</span>
              <span className="ov-v">{s.trades?.closed ?? 0} · <b className="t-muted">{signedMoney(s.trades?.net_pnl ?? 0)}</b></span>
            </div>
          </div>
          {p ? (
            <p className="bot-pos">
              <b>{p.side}</b> {qty(p.qty)} @ {price(p.entry)} · SL {price(p.stop)} · TP2 {price(p.tp2)} ·{" "}
              <b className={`t-${tone(p.unrealized_at_last_close ?? 0)}`}>{signedMoney(p.unrealized_at_last_close)}</b> at last close
            </p>
          ) : null}
          {p?.ledger ? (
            <p className={`bot-note ${p.ledger.status === "MIRRORED" ? "" : "t-warn"}`}>
              {p.ledger.status === "MIRRORED" ? "Also open in the ALPHA PAPER ledger (checked against the ledger)."
                : p.ledger.status === "PENDING" ? `Not in the ALPHA PAPER ledger yet: ${p.ledger.reason ?? "waiting to sync"}.`
                : p.ledger.status === "UNVERIFIED" ? `Accepted, but not verified against the ledger: ${p.ledger.reason ?? NA}.`
                : p.ledger.status === "DIVERGED" ? `Does not match the ALPHA PAPER ledger: ${p.ledger.reason ?? NA}.`
                : `Engine-only position, not in the ALPHA PAPER ledger: ${p.ledger.reason ?? NA}.`}
            </p>
          ) : null}
          {s.ledger_check?.status === "DIVERGED" && !(p?.ledger?.status === "DIVERGED") ? (
            <p className="bot-note t-warn">Reconciliation warning: {s.ledger_check.issues[0] ?? "engine and ledger differ"}</p>
          ) : null}
          {s.last_rejection ? (
            <p className="bot-note">Last refused signal: {s.last_rejection.action} {s.last_rejection.status} ({s.last_rejection.code}){s.last_rejection.reason ? ` · ${s.last_rejection.reason}` : ""}</p>
          ) : null}
          {(s.outbox?.pending ?? 0) > 0 ? <p className="bot-note t-warn">{s.outbox?.pending} signal(s) waiting to sync</p> : null}
          {s.last_error ? <p className="bot-note t-warn">{s.last_error.where}: {s.last_error.message}</p> : null}
          <p className="bot-note">Engine simulation: trades the engine replayed on its own (including warm-up history) with its own fills. They never reached the ALPHA PAPER ledger, so they are not verified and not counted in Verified P&amp;L.</p>
        </>
      )}
    </section>
  );
}

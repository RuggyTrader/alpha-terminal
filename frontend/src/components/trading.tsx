import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { strategyColor, tradeTone, type StrategyStat } from "../lib/derive";
import { compactMoney, money, NA, num, pct, price, qty, signedMoney, time, tone } from "../lib/format";
import { useData } from "../store/DataProvider";
import type { ActivityEvent, Position, Summary, TradeRow } from "../types/api";
import { HeroOrb, Mark } from "./icons";
import { CountUpValue, useFlip } from "./motion";
import { Badge, ConfirmSheet, EmptyState, StaleNote } from "./ui";

// ------------------------------------------------------------------ symbol icon
const ICON_BG = ["#F2661B", "#3A6FF2", "#14A35B", "#8B5CF6", "#E5A50A", "#E0457B", "#0EA5B7", "#475569"];
export function SymbolIcon({ symbol, size = 18 }: { symbol: string; size?: number }) {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span className="sym-icon" style={{ width: size, height: size, background: ICON_BG[h % ICON_BG.length], fontSize: size * 0.5 }}>
      {symbol.slice(0, 1)}
    </span>
  );
}

// ------------------------------------------------------------------ hero
function pnlSize(text: string): number {
  const n = text.length;
  if (n <= 7) return 44;
  if (n <= 9) return 40;
  if (n <= 11) return 34;
  if (n <= 13) return 29;
  return 25;
}

export function HeroPnL({ summary, error, updatedAt, loading }: {
  summary: Summary | null; error: ApiError | null; updatedAt: number | null; loading: boolean;
}) {
  const a = summary?.account;
  const acctOk = !!a?.available;
  const verified = acctOk ? num(a?.verified_pnl) : null;
  const stale = !!error && !!summary;

  let status: { label: string; cls: string };
  if (error && !summary) status = { label: "CONNECTION ERROR", cls: "red" };
  else if (stale) status = { label: "STALE DATA", cls: "orange" };
  else if (!summary) status = { label: "CONNECTING", cls: "gray" };
  else if (!acctOk) status = { label: a?.error === "NOT CONFIGURED" ? "ALPACA NOT CONFIGURED" : "ALPACA UNAVAILABLE", cls: "red" };
  else status = { label: "DATA CONNECTED", cls: "green" };

  const winRate = num(summary?.win_rate_pct);
  const sizeText = verified === null ? NA : signedMoney(verified);
  return (
    <section className={`hero${stale ? " is-stale" : ""}`}>
      <HeroOrb />
      <span className={`hero-status ${status.cls}`}><span className="dot" />{status.label}</span>
      <div className="hero-main">
        <div className="hero-title">Alpha Terminal</div>
        <span className="hero-badge">PAPER DESK</span>
        <div className="hero-label">PAPER P&amp;L</div>
        {loading && !summary ? <span className="skeleton dark" style={{ height: 40, width: 150, borderRadius: 10 }} /> : (
          <span className="hero-pnl-wrap" style={{ fontSize: pnlSize(sizeText) }}>
            <CountUpValue id="hero-pnl" value={verified} format={signedMoney} className={`hero-pnl ${tone(verified)}`} />
          </span>
        )}
        <div className="hero-sub mono">
          TODAY <CountUpValue id="hero-today" value={acctOk ? num(a?.todays_pnl) : null} format={signedMoney}
            className={tone(acctOk ? num(a?.todays_pnl) : null)} />
        </div>
        <div className="hero-pillrow">
          <span className={`hero-pill ${tone(acctOk ? num(a?.account_return_pct) : null)}`}>
            <CountUpValue id="hero-ret" value={acctOk ? num(a?.account_return_pct) : null} format={(n) => pct(n)} />
          </span>
          <span className="hero-pill-text">
            {summary ? (
              <>
                <CountUpValue id="hero-closed" value={summary.closed_trades} format={(n) => String(Math.round(n))} /> closed ·{" "}
                {winRate === null ? "win N/A" : <><CountUpValue id="hero-win" value={winRate} format={(n) => `${n.toFixed(0)}%`} /> win</>} ·{" "}
                {summary.open_positions === null ? "N/A" : summary.open_positions} open
              </>
            ) : "—"}
          </span>
        </div>
      </div>
      <div className="hero-strip">
        <div><span>EQUITY</span><CountUpValue id="hero-eq" value={acctOk ? num(a?.equity) : null} format={compactMoney} /></div>
        <div><span>BUYING POWER</span><CountUpValue id="hero-bp" value={acctOk ? num(a?.buying_power) : null} format={compactMoney} /></div>
        <div><span>OPEN EXPOSURE</span><CountUpValue id="hero-exp" value={num(summary?.open_exposure)} format={compactMoney} /></div>
      </div>
      {stale && <StaleNote error={error} updatedAt={updatedAt} />}
    </section>
  );
}

// ------------------------------------------------------------------ strategy performance
export function StrategyPerformance({ stats, capped }: { stats: StrategyStat[]; capped: boolean }) {
  const closed = stats.filter((s) => s.closed > 0);
  const total = closed.reduce((n, s) => n + s.closed, 0);
  return (
    <section className="panel strat">
      <div className="panel-head">
        <b>Strategy performance</b>
        <span>{stats.length ? `${stats.length} ${stats.length === 1 ? "strategy" : "strategies"}` : "no strategies yet"}</span>
      </div>
      <div className="strat-bar">
        {total === 0 ? <span className="strat-empty" /> : closed.map((s) => (
          <span key={s.name} style={{ flexGrow: s.closed, background: s.color }} title={`${s.name}: ${s.closed} closed`} />
        ))}
      </div>
      {total === 0 ? (
        <div className="strat-legend"><span className="muted">INSUFFICIENT DATA — no closed PAPER trades yet</span></div>
      ) : (
        <div className="strat-legend">
          {closed.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />{s.name}{" "}
              <b className={`mono ${tone(s.realized)}`}>{compactMoney(s.realized, true)}</b>
              <em> {Math.round((s.wins / s.closed) * 100)}%</em>
            </span>
          ))}
        </div>
      )}
      {capped && <div className="muted tiny">Based on the latest 500 trades.</div>}
    </section>
  );
}

// ------------------------------------------------------------------ trade tiles
export function TradeTile({ t, color, fresh }: { t: TradeRow; color: string; fresh: boolean }) {
  const nav = useNavigate();
  const kind = tradeTone(t);
  return (
    <button className={`tile tile-${kind}${fresh ? " fresh" : ""}`} data-flip={`t${t.id}`} onClick={() => nav(`/trades/${t.id}`)}
      style={{ ["--accent" as string]: color }}>
      <span className="tile-top"><SymbolIcon symbol={t.symbol} /><b>{t.symbol}</b></span>
      {kind === "open" ? (
        <span className="tile-bottom"><span className="tile-pct open">OPEN</span><span className="tile-usd">{qty(t.open_qty)} sh</span></span>
      ) : (
        <span className="tile-bottom">
          <span className={`tile-pct ${tone(num(t.return_pct))}`}>{pct(t.return_pct)}</span>
          <span className={`tile-usd ${kind === "loss" ? "neg" : ""}`}>{compactMoney(num(t.realized_pnl), true)}</span>
        </span>
      )}
    </button>
  );
}

export function TradeGrid({ trades, stats, limit = 9 }: { trades: TradeRow[]; stats: StrategyStat[]; limit?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = trades.slice(0, limit);
  const fresh = useFlip(ref, shown.map((t) => `${t.id}:${t.status}`).join(","));
  return (
    <div className="tile-grid" ref={ref}>
      {shown.map((t) => <TradeTile key={t.id} t={t} color={strategyColor(stats, t.strategy)} fresh={fresh.has(`t${t.id}`)} />)}
    </div>
  );
}

// ------------------------------------------------------------------ positions
export function PositionRow({ p }: { p: Position }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { refresh } = useData();
  const unavailable = p.current.status === "UNAVAILABLE";
  return (
    <div className={`prow${open ? " open" : ""}`}>
      <button className="prow-main" onClick={() => setOpen((o) => !o)}>
        <SymbolIcon symbol={p.symbol} size={30} />
        <span className="prow-id">
          <b>{p.symbol} <span className="paper-tag">PAPER POSITION</span></b>
          <span>{p.direction} · {qty(p.qty)} SHARES{p.strategy ? ` · ${p.strategy}` : ""}</span>
        </span>
        <span className="prow-pnl">
          <b className={tone(num(p.unrealized_pnl))}>{signedMoney(p.unrealized_pnl)}</b>
          <span className={tone(num(p.unrealized_pct))}>{pct(p.unrealized_pct)}</span>
        </span>
      </button>
      <div className="prow-grid">
        <div><span>ENTRY</span><b>{price(p.avg_entry_price)}</b></div>
        <div><span>CURRENT</span><b className={unavailable ? "muted" : ""}>{unavailable ? NA : price(p.current.price)}</b></div>
        <div><span>MKT VALUE</span><b>{money(p.market_value)}</b></div>
      </div>
      {(unavailable || p.current.status === "STALE" || !p.tracked_by_terminal) && (
        <div className="prow-tags">
          {unavailable && <Badge tone="red">MARKET DATA UNAVAILABLE</Badge>}
          {p.current.status === "STALE" && <Badge tone="orange">STALE · {time(p.current.as_of)}</Badge>}
          {!p.tracked_by_terminal && <Badge>NOT FULLY TRACKED</Badge>}
        </div>
      )}
      {open && (
        <div className="prow-more">
          <div className="kv"><span>Cost basis</span><b>{money(p.cost_basis)}</b></div>
          <div className="kv"><span>Opened</span><b>{p.opened_at ? new Date(p.opened_at).toLocaleString() : "UNKNOWN"}</b></div>
          <div className="kv"><span>TradingView alert</span><b className="mono">{p.alert_id ?? "UNKNOWN"}</b></div>
          <div className="kv"><span>P&amp;L source</span><b>Alpaca PAPER</b></div>
          <button className="btn danger-outline block small" onClick={() => setConfirm(true)}>CLOSE {p.symbol} POSITION</button>
          {msg && <div className="muted tiny">{msg}</div>}
        </div>
      )}
      <ConfirmSheet open={confirm} danger title={`Close ${p.symbol}?`} confirm={`SUBMIT PAPER CLOSE`}
        body={<>Submits a PAPER market order for the {qty(p.qty_available)} available shares. This is separate from the kill switch.</>}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            const r = await api.post<{ message: string }>(`/api/positions/${encodeURIComponent(p.symbol)}/close`, { confirm: p.symbol });
            setMsg(r.message);
          } catch (e) {
            setMsg(e instanceof ApiError ? e.message : "Close failed");
          }
          await refresh("positions", "summary", "trades", "activity");
        }} />
    </div>
  );
}

// ------------------------------------------------------------------ activity
export function levelClass(e: ActivityEvent): string {
  return `lv-${e.level}`;
}

function isRoutine(e: ActivityEvent): boolean {
  return (e.category === "WEBHOOK" && e.message === "TradingView alert received")
    || (e.category === "AUTH" && (e.message === "Alert authenticated" || e.message.startsWith("Dashboard log")));
}

export function ActivityPanel({ events, fresh, state }: { events: ActivityEvent[]; fresh: Set<number>; state: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  // Routine plumbing events stay on the Activity page; the panel shows decisions and results.
  const rows = events.filter((e) => !isRoutine(e)).slice(0, 5).reverse(); // chat order: newest at the bottom
  useFlip(ref, rows.map((e) => e.id).join(","));
  return (
    <section className="panel chat">
      <div className="chat-head">
        <Mark size={26} />
        <span><b>Alpha Engine</b><em>{state ? `${state.toLowerCase()} · paper execution` : "state unavailable"}</em></span>
      </div>
      <div className="chat-body" ref={ref}>
        {rows.length === 0 ? <EmptyState small>NO ACTIVITY YET</EmptyState> : rows.map((e) => (
          <div key={e.id} data-flip={`e${e.id}`}
            className={`bubble ${levelClass(e)}${e.category === "ENGINE" ? " dark" : ""}${fresh.has(e.id) ? " enter" : ""}`}>
            {e.symbol && <b>{e.symbol} </b>}{e.message}
          </div>
        ))}
      </div>
    </section>
  );
}

export function ActivityRow({ e, fresh }: { e: ActivityEvent; fresh: boolean }) {
  const meta = useMemo(() => [
    e.action && e.symbol ? `${e.action.toUpperCase()} ${e.symbol}` : e.symbol,
    e.qty && `qty ${e.qty}`,
    e.strategy,
    e.alert_id && `alert ${e.alert_id}`,
    e.risk_result && e.risk_result !== "APPROVED" && e.risk_result,
    e.alpaca_order_id && `order ${e.alpaca_order_id}`,
    e.alpaca_status,
    e.error_detail,
  ].filter(Boolean).join(" · "), [e]);
  return (
    <div className={`arow ${levelClass(e)}${fresh ? " enter" : ""}`}>
      <span className="arow-dot" />
      <span className="arow-time mono">{time(e.ts)}</span>
      <span className="arow-main">
        <span><b className="arow-cat">{e.category}</b> {e.message}</span>
        {meta && <span className="arow-meta mono">{meta}</span>}
      </span>
    </div>
  );
}

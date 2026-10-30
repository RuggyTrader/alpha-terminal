import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TopStatus } from "../components/AppShell";
import { SymbolIcon } from "../components/trading";
import { Chips, EmptyState, ErrorState, LoadingRows, SegmentControl, StatusBadge } from "../components/ui";
import { alertStage, strategyColor, strategyStats, tradeTone } from "../lib/derive";
import { compactMoney, num, pct, price, shortDate, signedMoney, time, tone } from "../lib/format";
import { useData } from "../store/DataProvider";
import type { AlertBrief, TradeRow } from "../types/api";

type Tab = "trades" | "orders";
type TradeFilter = "all" | "open" | "closed";
type AlertFilter = "all" | "accepted" | "rejected";

function remember<T extends string>(key: string, fallback: T, allowed: T[]): T {
  try {
    const v = sessionStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, v: string) {
  try { sessionStorage.setItem(key, v); } catch { /* ignore */ }
}

export function TradesPage() {
  const { trades, alerts } = useData();
  const [tab, setTab] = useState<Tab>(() => remember("trades.tab", "trades", ["trades", "orders"]));
  const [tf, setTf] = useState<TradeFilter>("all");
  const [af, setAf] = useState<AlertFilter>("all");
  const all = trades.data?.trades ?? [];
  const stats = useMemo(() => strategyStats(all), [all]);
  const list = all.filter((t) => tf === "all" || t.status.toLowerCase() === tf);
  const alertList = (alerts.data?.alerts ?? []).filter((a) =>
    af === "all" || (af === "accepted" ? a.status === "accepted" : a.status === "rejected" || a.status === "error"));

  return (
    <div>
      <TopStatus title="Trade history" />
      <SegmentControl value={tab} onChange={(v) => { setTab(v); store("trades.tab", v); }}
        options={[{ value: "trades", label: "Trades" }, { value: "orders", label: "Alerts & orders" }]} />
      {tab === "trades" ? (
        <>
          <Chips value={tf} onChange={setTf} options={[
            { value: "all", label: "All", count: all.length },
            { value: "open", label: "Open", count: all.filter((t) => t.status === "OPEN").length },
            { value: "closed", label: "Closed", count: all.filter((t) => t.status === "CLOSED").length },
          ]} />
          <ErrorState error={trades.error} what="TRADES" />
          {trades.loading && !trades.data ? <LoadingRows rows={5} /> : list.length === 0
            ? <EmptyState>NO PAPER TRADES{tf !== "all" ? ` (${tf.toUpperCase()})` : ""}</EmptyState>
            : <div className="list">{list.map((t) => <TradeListRow key={t.id} t={t} color={strategyColor(stats, t.strategy)} />)}</div>}
        </>
      ) : (
        <>
          <Chips value={af} onChange={setAf} options={[
            { value: "all", label: "All" }, { value: "accepted", label: "Accepted" }, { value: "rejected", label: "Rejected" },
          ]} />
          <ErrorState error={alerts.error} what="ALERTS" />
          {alerts.loading && !alerts.data ? <LoadingRows rows={5} /> : alertList.length === 0
            ? <EmptyState>NO TRADINGVIEW ALERTS{af !== "all" ? ` (${af.toUpperCase()})` : ""}</EmptyState>
            : <div className="list">{alertList.map((a) => <AlertListRow key={a.id} a={a} />)}</div>}
        </>
      )}
    </div>
  );
}

function TradeListRow({ t, color }: { t: TradeRow; color: string }) {
  const nav = useNavigate();
  const kind = tradeTone(t);
  return (
    <button className="lrow" onClick={() => nav(`/trades/${t.id}`)} style={{ ["--accent" as string]: color }}>
      <span className="lrow-bar" />
      <SymbolIcon symbol={t.symbol} size={30} />
      <span className="lrow-main">
        <span className="lrow-line"><b>{t.symbol}</b>
          <b className={kind === "open" ? "orange" : tone(num(t.realized_pnl))}>{kind === "open" ? "OPEN" : signedMoney(t.realized_pnl)}</b></span>
        <span className="lrow-line sub"><span>{t.side} · {t.strategy ?? "UNSPECIFIED"}</span>
          <span className={tone(num(t.return_pct))}>{kind === "open" ? `${t.open_qty} sh` : pct(t.return_pct)}</span></span>
        <span className="lrow-line sub"><span className="mono">{price(t.entry_price)} → {t.exit_price ? price(t.exit_price) : "—"}</span>
          <span>{shortDate(t.closed_at ?? t.opened_at)} · {t.status}</span></span>
      </span>
    </button>
  );
}

function AlertListRow({ a }: { a: AlertBrief }) {
  const nav = useNavigate();
  const stage = a.status === "accepted" ? (a.order?.status ?? "accepted") : a.code ?? a.status;
  const source = alertStage(a);
  return (
    <button className="lrow" onClick={() => nav(`/alerts/${a.id}`)}>
      <SymbolIcon symbol={a.symbol ?? "?"} size={30} />
      <span className="lrow-main">
        <span className="lrow-line"><b>{a.symbol ?? "—"} <span className="muted">{(a.action ?? "?").toUpperCase()}</span></b>
          <StatusBadge status={a.status === "error" ? "ERROR" : a.status.toUpperCase()} /></span>
        <span className="lrow-line sub"><span>TradingView · {source}</span><span className="mono">{time(a.received_at)}</span></span>
        <span className="lrow-line sub">
          <span className="ellipsis">{a.status === "accepted"
            ? `${String(stage).toUpperCase()}${a.order?.filled_avg_price ? ` @ ${price(a.order.filled_avg_price)}` : ""}`
            : a.rejection_reason ?? stage}</span>
          {a.duplicate_count > 0 && <span className="orange">{a.duplicate_count} dup blocked</span>}
          {a.order?.filled_qty && Number(a.order.filled_qty) > 0 && <span>{compactMoney(Number(a.order.filled_qty) * Number(a.order.filled_avg_price ?? 0))}</span>}
        </span>
      </span>
    </button>
  );
}

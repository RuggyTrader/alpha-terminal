// The Trades / Performance filtered views (?bot=ALPHA-NN, ?signal=<id>): the bot's OWN records from the ledger, each
// linked to its trade proof. A filter that matches nothing says so; nothing is estimated. Bot chips switch the filter.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchBotTrades, type BotTradeRow, type BotTrades } from "../botTrades";
import { useFleet } from "../fleetStore";
import { money, NA, signedMoney, stamp, tone } from "../fmt";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "./ui";
import { TradeStoryCard } from "./TradeStoryCard";
import { fromBotTrade } from "../tradeStory";

/** Funded results of a set of closed bot trades (the ledger's own net figures; fees recorded per fill). */
export function botTradeSummary(rows: BotTradeRow[]) {
  const closed = rows.filter((r) => r.status === "CLOSED" && r.net_usd !== null);
  const nets = closed.map((r) => r.net_usd as number);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const won = nets.filter((x) => x > 0), lost = nets.filter((x) => x < 0);
  let eq = 0, peak = 0, dd = 0;
  for (const r of [...closed].sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)))) { eq += r.net_usd as number; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const side = (s: string) => { const c = closed.filter((r) => r.side === s); return { trades: c.length, net: sum(c.map((r) => r.net_usd as number)) }; };
  return {
    trades: closed.length, open: rows.filter((r) => r.status === "OPEN").length,
    gross: sum(closed.map((r) => r.gross_usd ?? 0)), fees: sum(closed.map((r) => r.fees_usd ?? 0)), net: sum(nets), swept: sum(closed.map((r) => r.swept_usd ?? 0)),
    winRate: closed.length ? won.length / closed.length : null, profitFactor: lost.length ? sum(won) / -sum(lost) : null, maxDrawdown: dd,
    long: side("LONG"), short: side("SHORT"),
  };
}

export function useBotTrades(filter: { bot: string | null; signal: string | null }) {
  const [data, setData] = useState<BotTrades | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    fetchBotTrades({ ...filter, limit: 200 }).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(String((e as Error).message)); });
    return () => { live = false; };
  }, [filter.bot, filter.signal]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error };
}

export function BotChips({ base, active }: { base: "/trades" | "/performance"; active: string | null }) {
  const { fleet } = useFleet();
  const bots = fleet?.available ? fleet.bots.filter((b) => b.status !== "DISABLED") : [];
  if (!bots.length) return null;
  return (
    <nav className="bot-chips" aria-label="Filter by bot">
      <Link className={`chip ${active ? "" : "on"}`} to={base}>All</Link>
      {bots.map((b) => <Link key={b.bot_id} className={`chip ${active === b.bot_id ? "on" : ""}`} to={`${base}?bot=${b.bot_id}`}>{b.name} · {b.symbol} {b.timeframe}</Link>)}
    </nav>
  );
}

export function TradeRowLink({ t }: { t: BotTradeRow }) {
  return (
    <Link to={t.proof_url} className="li li-link m-press" aria-label={`Trade proof ${t.trade_id}`}>
      <span><b>{t.bot_id}</b> · {t.symbol} {t.side} {t.qty} @ {t.entry_price}{t.exit_price !== null ? ` → ${t.exit_price}` : ""} · {t.status === "OPEN" ? "OPEN" : stamp(t.closed_at ?? t.opened_at)}</span>
      <b className={`proof-amt ${t.net_usd === null ? "" : `t-${tone(t.net_usd)}`}`}><span>{t.net_usd === null ? "open" : signedMoney(t.net_usd)}</span></b>
    </Link>
  );
}

export function BotTradesView({ filter }: { filter: { bot: string | null; signal: string | null } }) {
  const { data, error } = useBotTrades(filter);
  const label = filter.signal ? `signal ${filter.signal}` : `bot ${filter.bot}`;
  return (
    <section aria-label="Filtered records" className="m-fade">
      <SectionHeader title={`Filtered: ${label}`} sub={<Link className="link" to="/trades">Clear filter</Link>} />
      {error ? <EmptyState title="Records unavailable" tone="bad">{error}</EmptyState> : !data ? <SkeletonCards count={2} /> : !data.available ? (
        <EmptyState title="No bot registry yet">The ledger has no bot tables (migration 0007 is not applied).</EmptyState>
      ) : !data.trades.length && !data.orders.length && !data.signals.length ? (
        <EmptyState title={`Nothing recorded for ${label}`}>No trade, order or signal matches this filter.</EmptyState>
      ) : (
        <>
          {data.trades.length ? (
            <div className="tcard-list" aria-label="Trades">
              <SectionHeader title="Trades" right={<span className="count">{data.trades.length}</span>} />
              {data.trades.map((t) => <TradeStoryCard key={`${t.ledger}-${t.trade_id}`} v={fromBotTrade(t)} defaultOpen={filter.signal !== null} />)}
            </div>
          ) : null}
          {data.orders.length ? (
            <div className="card list-card" aria-label="Bot orders">
              <SectionHeader title="Orders" sub="Every order the bot's engine sent, with the ledger's decision" />
              {data.orders.map((o) => (
                <div key={o.order_id} className="li">
                  <span><b>{o.action}</b> · {o.order_id} · {stamp(o.received_at)}{o.status !== "ACCEPTED" ? ` · ${o.code}` : ""}{o.message ? ` · ${o.message}` : ""}</span>
                  <StatusBadge tone={o.status === "ACCEPTED" ? "ok" : "bad"}>{o.status === "ACCEPTED" ? "ACCEPTED" : "REJECTED"}</StatusBadge>
                </div>
              ))}
            </div>
          ) : null}
          {data.signals.length ? (
            <div className="card list-card" aria-label="Signals">
              <SectionHeader title="Signals" />
              {data.signals.map((s) => (
                <div key={s.id} className="li">
                  <span><b>{s.symbol} {s.action.toUpperCase()}</b> · {s.alert_id} · {stamp(s.received_at)}{s.rejection_reason ? ` · ${s.rejection_reason}` : ""}</span>
                  <StatusBadge tone={s.status === "dry_run" ? "ok" : s.status === "rejected" || s.status === "error" ? "bad" : "muted"}>
                    {s.status === "dry_run" ? "DRY-RUN ACCEPTED" : s.status.toUpperCase()}
                  </StatusBadge>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function BotPerformanceView({ bot }: { bot: string }) {
  const { data, error } = useBotTrades({ bot, signal: null });
  const { fleet } = useFleet();
  const b = fleet?.bots.find((x) => x.bot_id === bot) ?? null;
  if (error) return <EmptyState title="Bot performance unavailable" tone="bad">{error}</EmptyState>;
  if (!data) return <SkeletonCards count={2} tall />;
  const s = botTradeSummary(data.trades);
  const rate = (v: number | null) => (v === null ? NA : `${(v * 100).toFixed(0)}%`);
  return (
    <>
      <section className="card dark-card" aria-label={`${bot} funded performance`}>
        <SectionHeader title={b ? `${b.name} · ${b.symbol} ${b.timeframe}` : bot} right={<StatusBadge tone="ok">FUNDED PAPER</StatusBadge>} />
        <div className="pm-grid">
          <div className="pm"><span className="pm-k">NET P&amp;L</span><b className={`pm-v t-${tone(s.net)}`}>{s.trades ? signedMoney(s.net) : NA}</b><i className="pm-n">after fees</i></div>
          <div className="pm"><span className="pm-k">GROSS · FEES</span><b className="pm-v">{s.trades ? `${signedMoney(s.gross)} · ${money(s.fees)}` : NA}</b></div>
          <div className="pm"><span className="pm-k">CLOSED TRADES</span><b className="pm-v">{s.trades}</b><i className="pm-n">{s.long.trades} long · {s.short.trades} short{s.open ? ` · ${s.open} open` : ""}</i></div>
          <div className="pm"><span className="pm-k">WIN RATE · PF</span><b className="pm-v">{rate(s.winRate)} · {s.profitFactor === null ? NA : s.profitFactor.toFixed(2)}</b></div>
          <div className="pm"><span className="pm-k">MAX DRAWDOWN</span><b className="pm-v">{s.trades ? money(s.maxDrawdown) : NA}</b></div>
          <div className="pm"><span className="pm-k">TO MAIN</span><b className="pm-v">{money(s.swept)}</b><i className="pm-n">profit transfers do not make a losing bot profitable</i></div>
        </div>
        {b && s.trades && Math.abs(b.paper.net_usd - s.net) > 0.005 && data.trades.length < 200 ? (
          <p className="sizing-note t-bad">The bot summary ({signedMoney(b.paper.net_usd)}) and its trade rows ({signedMoney(s.net)}) disagree; reported, not hidden.</p>
        ) : null}
      </section>
      <section aria-label="Bot trades">
        <SectionHeader title="Trades" right={<span className="count">{data.trades.length}</span>} />
        {data.trades.length ? <div className="tcard-list">{data.trades.map((t) => <TradeStoryCard key={`${t.ledger}-${t.trade_id}`} v={fromBotTrade(t)} />)}</div>
          : <EmptyState title="NOT YET OBSERVED">{bot} has no recorded trade.</EmptyState>}
      </section>
    </>
  );
}

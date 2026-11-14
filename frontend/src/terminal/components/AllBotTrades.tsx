// The unfiltered Trades page when the bot registry exists: EVERY bot's funded PAPER records in one place, so the owner
// never has to pick a bot to discover that a trade happened.
//   Pending   each bot's live limit order (engine report in the shared fleet snapshot)
//   Open      open positions: bot-ledger rows (with their story) + legacy ALPHA-02 positions from the fleet snapshot
//   Completed closed trades from /bot-trades (bot ledger AND legacy ALPHA-02 rows, each exactly once)
//   Rejected  orders the ledger refused, and rejected legacy signals, in plain language with the original code kept
// Filters: market, timeframe, direction. Funded PAPER only: Strategy Mirror (hypothetical) trades are never listed here.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useBotTrades, type BotOrderRow, type BotTrades, type SignalRow } from "../botTrades";
import type { Bot, Fleet, OpenPosition } from "../bots";
import { useFleet } from "../fleetStore";
import { NA, stamp } from "../fmt";
import { fromBotTrade, humanReason, type TradeView } from "../tradeStory";
import { PageNote, RefreshNote } from "./BotTradesView";
import { TradeStoryCard } from "./TradeStoryCard";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "./ui";

export type AllTab = "pending" | "open" | "completed" | "rejected";
export interface AllFilter { market: string | null; timeframe: string | null; side: "LONG" | "SHORT" | null }

export interface PendingRow { bot: Bot; side: "LONG" | "SHORT"; qty: number; limit: number | null; stop: number | null; tp: number | null; placedAt: string | null }
export interface LegacyOpen { bot: Bot; p: OpenPosition }
export interface RejectedRow { key: string; botId: string | null; symbol: string; side: "LONG" | "SHORT" | null; code: string; text: string; at: string; ref: string }

const sideOfAction = (a: string): "LONG" | "SHORT" | null => (/SHORT/i.test(a) ? "SHORT" : /LONG|BUY/i.test(a) ? "LONG" : null);

/** A short plain-language headline for a refusal code; the ledger's own recorded message carries the exact figures. */
const HEADLINE: Record<string, string> = {
  INSUFFICIENT_BOT_CAPITAL: "Not enough capital in this bot's wallet",
  BELOW_MIN_QTY: "Below Kraken's minimum order size",
  BELOW_MIN_COST: "Below Kraken's minimum order value",
  BOT_ENTRIES_PAUSED: "Entries paused by the owner",
  STALE_PRICE: "Market price too old to size the order",
  NO_CAPITAL: "No PAPER capital allocated to this bot",
  SIGNAL_EXPIRED: "Signal arrived too late",
  BOT_PROFILE_MISMATCH: "Strategy settings do not match the bot's original profile",
  BOT_SHORTFALL: "Bot has an unpaid shortfall",
  CONCURRENT_ORDER: "Account changed at the same moment; nothing committed",
};
export function refusalText(code: string, message: string | null): string {
  const head = HEADLINE[code];
  if (head && message) return `${head}: ${message}`;
  return message ?? humanReason(code) ?? code;
}

/** Every record of every bot, split by stage and filtered. Pure: the same input always gives the same lists. */
export function allBotRecords(fleet: Fleet | null, data: BotTrades | null, f: AllFilter) {
  const bots = fleet?.available ? fleet.bots : [];
  const byId = new Map(bots.map((b) => [b.bot_id, b]));
  const botOk = (id: string | null, symbol?: string) => {
    const b = id ? byId.get(id) : undefined;
    const sym = b?.symbol ?? symbol ?? "";
    if (f.market && sym !== f.market) return false;
    if (f.timeframe && b?.timeframe !== f.timeframe) return false;
    return true;
  };
  const sideOk = (s: string | null) => !f.side || s === f.side;

  const pending: PendingRow[] = bots.flatMap((b) => {
    const o = b.engine?.strategy_state?.pending_order;
    return o && botOk(b.bot_id) && sideOk(o.side) ? [{ bot: b, side: o.side, qty: o.qty, limit: o.limit, stop: o.stop, tp: o.tp, placedAt: o.placed_at ?? null }] : [];
  });

  const rows = data?.available ? data.trades : [];
  const views = rows.map(fromBotTrade).filter((v) => botOk(v.botId, v.symbol) && sideOk(v.side));
  const open = views.filter((v) => v.status === "OPEN");
  const openIds = new Set(rows.filter((r) => r.status === "OPEN").map((r) => r.trade_id));
  // Open positions the trade rows do not carry (the legacy ledger writes its trade row only at the close).
  const legacyOpen: LegacyOpen[] = bots.flatMap((b) => b.open_positions.filter((p) => !openIds.has(p.trade_id) && botOk(b.bot_id) && sideOk(p.side)).map((p) => ({ bot: b, p })));
  const completed = views.filter((v) => v.status === "CLOSED");

  const rejectedOrders: RejectedRow[] = (data?.available ? data.orders : []).filter((o: BotOrderRow) => o.status !== "ACCEPTED")
    .map((o) => ({ key: `o-${o.order_id}`, botId: o.bot_id, symbol: o.symbol, side: sideOfAction(o.action), code: o.code, text: refusalText(o.code, o.message), at: o.received_at, ref: o.order_id }));
  const rejectedSignals: RejectedRow[] = (data?.available ? data.signals : []).filter((s: SignalRow) => s.status === "rejected" || s.status === "error")
    .map((s) => ({ key: `s-${s.id}`, botId: s.bot_id || null, symbol: s.symbol, side: sideOfAction(s.action), code: s.rejection_reason ?? s.response_code ?? s.status.toUpperCase(),
      text: humanReason(s.rejection_reason) ?? s.rejection_reason ?? s.status, at: s.received_at, ref: s.alert_id }));
  const rejected = [...rejectedOrders, ...rejectedSignals].filter((r) => botOk(r.botId, r.symbol) && sideOk(r.side)).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return { pending, open, legacyOpen, completed, rejected };
}

const TABS: { id: AllTab; label: string }[] = [
  { id: "pending", label: "Pending" }, { id: "open", label: "Open" }, { id: "completed", label: "Completed" }, { id: "rejected", label: "Rejected" },
];

/** One compact row of toggle chips: tapping the active chip clears that filter (no separate "All" chips). */
function FilterRow({ f, setF, markets, tfs }: { f: AllFilter; setF: (f: AllFilter) => void; markets: { v: string; label: string }[]; tfs: { v: string; label: string }[] }) {
  const chip = (on: boolean, label: string, onClick: () => void, key: string) => (
    <button key={key} type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={onClick}>{label}</button>
  );
  const any = f.market || f.timeframe || f.side;
  return (
    <div className="bot-chips" role="group" aria-label="Filter trades">
      {markets.map((m) => chip(f.market === m.v, m.label, () => setF({ ...f, market: f.market === m.v ? null : m.v }), `m-${m.v}`))}
      {tfs.map((t) => chip(f.timeframe === t.v, t.label, () => setF({ ...f, timeframe: f.timeframe === t.v ? null : t.v }), `t-${t.v}`))}
      {(["LONG", "SHORT"] as const).map((d) => chip(f.side === d, d === "LONG" ? "Long" : "Short", () => setF({ ...f, side: f.side === d ? null : d }), `d-${d}`))}
      {any ? chip(false, "Clear", () => setF({ market: null, timeframe: null, side: null }), "clear") : null}
    </div>
  );
}

export function AllBotTrades({ initial = "completed" }: { initial?: AllTab }) {
  const { fleet } = useFleet();
  const snap = useBotTrades({ bot: null, signal: null }, fleet);
  const [tab, setTab] = useState<AllTab>(initial);
  const [f, setF] = useState<AllFilter>({ market: null, timeframe: null, side: null });
  const bots = fleet?.available ? fleet.bots : [];
  const markets = [...new Set(bots.map((b) => b.symbol))].map((m) => ({ v: m, label: m.replace(/USD$/, "") }));
  const tfs = [...new Set(bots.map((b) => b.timeframe))].sort((a, b) => parseInt(a) - parseInt(b)).map((t) => ({ v: t, label: t }));
  const r = allBotRecords(fleet, snap.data, f);
  const count: Record<AllTab, number> = { pending: r.pending.length, open: r.open.length + r.legacyOpen.length, completed: r.completed.length, rejected: r.rejected.length };
  const idx = TABS.findIndex((t) => t.id === tab);
  const label = (b: Bot | undefined, id: string | null) => (b ? `${b.name} · ${b.symbol.replace(/USD$/, "")} ${b.timeframe}` : id ?? "Engine");

  return (
    <section aria-label="All bots" className="m-fade">
      <SectionHeader title="All bots" sub="Funded PAPER records of every bot · Strategy Mirror (hypothetical) is on Performance" right={<StatusBadge tone="ok">FUNDED PAPER</StatusBadge>} />
      <FilterRow f={f} setF={setF} markets={markets} tfs={tfs} />
      <div className="seg" role="tablist" style={{ ["--i" as string]: idx }}>
        <span className="seg-pill" aria-hidden />
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" className={`m-press${tab === t.id ? " on" : ""}`} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label} <span className="count">{count[t.id]}</span>
          </button>
        ))}
      </div>
      <RefreshNote fetchedAt={snap.fetchedAt} stale={snap.stale} error={snap.error} />

      {tab === "pending" ? (
        r.pending.length ? (
          <div className="card list-card" aria-label="Pending orders">
            {r.pending.map((p) => (
              <div key={p.bot.bot_id} className="li">
                <span><b>{label(p.bot, null)} · {p.side} limit {p.limit ?? NA}</b> · stop {p.stop ?? NA} · target {p.tp ?? NA} · qty {p.qty}{p.placedAt ? ` · placed ${stamp(p.placedAt)}` : ""}</span>
                <Link className="btn btn-ghost" to={`/bots/${p.bot.bot_id}/chart`}>View chart</Link>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No pending orders">No bot has a live limit order right now (from each bot's latest engine report).</EmptyState>
      ) : null}

      {tab === "open" ? (
        !snap.data && !fleet ? <SkeletonCards count={2} /> : count.open ? (
          <div className="tcard-list" aria-label="Open positions">
            {r.open.map((v: TradeView) => <TradeStoryCard key={v.key} v={v} />)}
            {r.legacyOpen.map(({ bot, p }) => (
              <div key={`lo-${p.trade_id}`} className="card list-card">
                <div className="li">
                  <span><b>{label(bot, null)} · {p.side} {p.qty} @ {p.entry_price}</b> · opened {stamp(p.opened_at)} · legacy ledger (its trade record and proof are written at the close)</span>
                  <Link className="btn btn-ghost" to={`/bots/${bot.bot_id}/chart`}>View chart</Link>
                </div>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No open positions">No bot holds a PAPER position right now.</EmptyState>
      ) : null}

      {tab === "completed" ? (
        snap.error && !snap.data ? <EmptyState title="Trades unavailable" tone="bad">{snap.error}</EmptyState>
          : !snap.data ? <SkeletonCards count={2} />
          : r.completed.length ? (
            <div className="tcard-list" aria-label="Completed trades">
              {r.completed.map((v) => <TradeStoryCard key={v.key} v={v} />)}
              <PageNote page={snap.data.page} />
            </div>
          ) : <EmptyState title="No completed trades">{f.market || f.timeframe || f.side ? "No completed trade matches these filters." : "No bot has closed a PAPER trade yet."}</EmptyState>
      ) : null}

      {tab === "rejected" ? (
        !snap.data ? <SkeletonCards count={2} /> : r.rejected.length ? (
          <div className="card list-card" aria-label="Rejected and cancelled">
            {r.rejected.map((x) => (
              <div key={x.key} className="li">
                <span><b>{label(x.botId ? bots.find((b) => b.bot_id === x.botId) : undefined, x.botId)}{x.side ? ` · ${x.side}` : ""}</b> · {x.text} · {stamp(x.at)}
                  <details><summary>Details</summary><code>{x.code}</code> · <code>{x.ref}</code></details></span>
                <StatusBadge tone="bad">REJECTED</StatusBadge>
              </div>
            ))}
          </div>
        ) : <EmptyState title="Nothing rejected">No order or signal was refused{f.market || f.timeframe || f.side ? " for these filters" : ""}.</EmptyState>
      ) : null}
    </section>
  );
}

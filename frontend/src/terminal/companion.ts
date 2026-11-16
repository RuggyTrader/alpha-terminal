// The talking globe's lines: short, DETERMINISTIC portfolio insights built only from records already on screen
// (the shared fleet snapshot, the verified lifetime metrics, the latest closed funded trades, the feed's own state).
// No language model. Every number is copied from those records; nothing is estimated or invented. When the records are
// stale or missing, the globe says so instead of sounding live. Lines are ranked:
//   1 system issues / restrictions · 2 a trade that just closed · 3 open positions (and stop moves) · 4 pending orders
//   · 5 performance summary · 6 calm scanning status.

import { engineStatus, type Bot, type Fleet } from "./bots";
import { level } from "./fmt";
import type { Metrics } from "./performance";
import type { ClosedCard } from "./recentClosed";
import { displayName } from "./botNames";

export type Mood = "calm" | "good" | "bad" | "warn";
export interface Insight { key: string; text: string; priority: 1 | 2 | 3 | 4 | 5 | 6; mood: Mood }

export interface CompanionInput {
  feedStatus: "loading" | "ok" | "stale" | "error";
  feedAt: number | null;            // last successful dashboard refresh (ms)
  fleet: Fleet | null;
  fleetStale: boolean;
  metrics: Metrics | null;          // verified lifetime metrics (funded PAPER, closed trades only)
  closed: ClosedCard[];             // newest first
  now: number;
}

const usd = (v: number) => `$${Math.abs(v).toFixed(2)}`;
const hhmm = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(11, 16) + " UTC" : "an earlier refresh");
const sideWord = (s: string) => (String(s).toUpperCase() === "SHORT" ? "short" : "long");
export const JUST_CLOSED_MS = 30 * 60_000;

export function insights(i: CompanionInput): Insight[] {
  const out: Insight[] = [];
  // 1. The feed itself: never sound live on old data.
  if (i.feedStatus === "error") out.push({ key: "feed-error", text: "I can't reach the backend right now, so I can't confirm what the bots are doing.", priority: 1, mood: "warn" });
  else if (i.feedStatus === "stale") out.push({ key: `feed-stale-${i.feedAt}`, text: `My data is from ${hhmm(i.feedAt)}. The last refresh failed; retrying.`, priority: 1, mood: "warn" });
  const bots = i.fleet?.available ? i.fleet.bots.filter((b) => b.status === "ACTIVE") : [];
  if (i.fleetStale) out.push({ key: "fleet-stale", text: "Bot status could not refresh, so what I say about the bots may be out of date.", priority: 1, mood: "warn" });
  const live = i.feedStatus === "ok" && !i.fleetStale;

  const statuses = bots.map((b) => ({ b, s: engineStatus(b, i.now) }));
  for (const { b, s } of statuses) {
    if (s.key === "OFFLINE") out.push({ key: `off-${b.bot_id}`, text: `${b.name} has not reported since ${s.detail.match(/\d\d:\d\d UTC/)?.[0] ?? "a while"}. It may be offline.`, priority: 1, mood: "bad" });
    else if (s.key === "MARKET_DATA_STALE") out.push({ key: `stale-${b.bot_id}`, text: `${b.name}'s market data is stale, so it is not scanning fresh candles.`, priority: 1, mood: "warn" });
    else if (s.key === "BACKEND_DISCONNECTED") out.push({ key: `ledger-${b.bot_id}`, text: `${b.name} could not verify its PAPER ledger.`, priority: 1, mood: "warn" });
    else if (s.key === "PAUSED") out.push({ key: `paused-${b.bot_id}`, text: `${b.name} has new entries paused. Open positions are still managed.`, priority: 1, mood: "warn" });
  }

  // 2. A funded trade that closed recently (net after fees, exactly as recorded).
  const last = i.closed[0];
  if (last && i.now - Date.parse(last.closedAt) <= JUST_CLOSED_MS) {
    const name = displayName(last.botId);
    const verb = last.net > 0 ? `closed a ${sideWord(last.side)} for +${usd(last.net)} after fees` : last.net < 0 ? `closed a ${sideWord(last.side)} at −${usd(last.net)} after fees` : `closed a ${sideWord(last.side)} at break-even after fees`;
    out.push({ key: `closed-${last.key}`, text: `${name} just ${verb}.`, priority: 2, mood: last.net > 0 ? "good" : last.net < 0 ? "bad" : "calm" });
  }

  // 3. Open positions and their recorded stop management; 4. pending limit orders (never described as filled).
  const open = bots.flatMap((b) => b.open_positions.map((p) => ({ b, p })));
  const pending = bots.filter((b) => !b.open_positions.length && b.engine?.strategy_state?.pending_order);
  if (open.length + pending.length >= 2) {
    const parts = [open.length ? `${open.length === 1 ? "One position is" : `${open.length} positions are`} open` : null,
      pending.length ? `${pending.length === 1 ? "one order is" : `${pending.length} orders are`} waiting to fill` : null].filter(Boolean);
    const t = parts.join(". ") ;
    out.push({ key: `book-${open.length}-${pending.length}`, text: `${t.charAt(0).toUpperCase()}${t.slice(1)}.`, priority: 3, mood: "calm" });
  }
  for (const { b, p } of open) {
    const st = b.engine?.strategy_state;
    if (st?.break_even_done) out.push({ key: `be-${p.trade_id}`, text: `${b.name} has moved its ${sideWord(p.side)} stop to break-even.`, priority: 3, mood: "calm" });
    else if (st?.trailing && st.current_stop !== null) out.push({ key: `trail-${p.trade_id}-${st.current_stop}`, text: `${b.name} is trailing its ${sideWord(p.side)} stop, now at ${level(st.current_stop, b.symbol)}.`, priority: 3, mood: "calm" });
    else out.push({ key: `pos-${p.trade_id}`, text: `${b.name} is managing an open ${sideWord(p.side)} from ${level(p.entry_price, b.symbol)}.`, priority: 3, mood: "calm" });
  }
  for (const b of pending) {
    const o = b.engine!.strategy_state!.pending_order!;
    out.push({ key: `pend-${b.bot_id}-${o.side}-${o.limit}`, text: o.limit === null ? `${b.name} has a ${sideWord(o.side)} order waiting.` : `${b.name} is waiting for a ${sideWord(o.side)} limit fill at ${level(o.limit, b.symbol)}.`, priority: 4, mood: "calm" });
  }

  // 5. Verified lifetime result (closed funded PAPER trades only).
  if (i.metrics && i.metrics.trades > 0) {
    const m = i.metrics;
    const dir = m.totalPnl > 0 ? `up ${usd(m.totalPnl)}` : m.totalPnl < 0 ? `down ${usd(m.totalPnl)}` : "flat";
    out.push({ key: `perf-${m.totalPnl}-${m.trades}`, text: `Your verified P&L is ${dir} across ${m.trades} closed trade${m.trades === 1 ? "" : "s"}.`, priority: 5, mood: m.totalPnl > 0 ? "good" : m.totalPnl < 0 ? "bad" : "calm" });
  } else if (i.metrics && i.metrics.trades === 0) {
    out.push({ key: "perf-none", text: "No funded trade has closed yet, so there is no verified result to report.", priority: 5, mood: "calm" });
  }

  // 6. Calm status — only when the data is live and every active bot is genuinely scanning.
  if (live && statuses.length && statuses.every(({ s }) => s.key === "SCANNING")) {
    out.push({ key: "scan-all", text: `All ${statuses.length} active bots are scanning for valid setups.`, priority: 6, mood: "calm" });
  } else if (live && statuses.length && !open.length && !pending.length && statuses.some(({ s }) => s.key === "SCANNING")) {
    out.push({ key: "scan-some", text: "No new valid entry has been detected yet.", priority: 6, mood: "calm" });
  }
  if (!out.length) out.push({ key: i.feedStatus === "loading" ? "loading" : "quiet", text: i.feedStatus === "loading" ? "Loading your PAPER desk…" : "Nothing new to report right now.", priority: 6, mood: "calm" });

  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true))).sort((a, b) => a.priority - b.priority);
}

/** Which line to show next: the most important line not shown in the last `cooldownMs`; a higher-priority line that
 *  appeared since the last pick always wins. Deterministic for the same inputs. */
export function nextInsight(list: Insight[], shownAt: Map<string, number>, now: number, cooldownMs = 90_000): Insight | null {
  if (!list.length) return null;
  const fresh = list.filter((x) => !shownAt.has(x.key) || now - (shownAt.get(x.key) ?? 0) >= cooldownMs);
  return (fresh.length ? fresh : list).slice().sort((a, b) => a.priority - b.priority || (shownAt.get(a.key) ?? 0) - (shownAt.get(b.key) ?? 0))[0];
}

/** For a quick reference in the assistant: is anything on the desk right now? */
export function deskSummary(bots: Bot[]): { open: number; pending: number } {
  return { open: bots.reduce((s, b) => s + b.open_positions.length, 0), pending: bots.filter((b) => !b.open_positions.length && b.engine?.strategy_state?.pending_order).length };
}

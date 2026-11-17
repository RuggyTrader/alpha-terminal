// ALPHA Assistant: a deterministic, READ-ONLY question answerer over the fleet's authoritative records
// (GET /api/dashboard/bots: registry, wallets, positions, ledger results, engine reports, mirror). No language model and
// no paid API. It recognises a fixed set of question types (with paraphrases) and answers ONLY from those records, with
// the evidence it used. When the records cannot support an answer it says so. It never acts: no trades, risk changes,
// transfers, restarts or live trading — those live in authenticated controls. Text typed by the user is matched, never
// executed or interpreted as instructions.

import { botPhase, botState, engineStatus, type Bot, type Fleet } from "./bots";
import { BOT_DISPLAY, displayName } from "./botNames";
import type { ClosedCard } from "./recentClosed";

export interface Evidence { label: string; value: string; link?: string }
export interface Answer { text: string; evidence: Evidence[]; known: boolean }
export const UNKNOWN = "I don't have enough verified data to answer that.";

const usd = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
const sgn = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
const MIN: Record<string, { qty: number; notional: number }> = { SOLUSD: { qty: 0.05, notional: 0.5 }, BTCUSD: { qty: 0.00006, notional: 0.5 } };

/** The bot a question is about: "ALPHA 01", "alpha-03", "sol 1m", "bitcoin 5 minute", "btc 1-minute"… */
export function findBot(q: string, bots: Bot[], context: string | null = null): Bot | null {
  const s = q.toLowerCase();
  const id = /alpha[\s-]?0?(\d{1,2})/.exec(s);
  if (id) return bots.find((b) => b.bot_id === `ALPHA-${id[1].padStart(2, "0")}`) ?? null;
  for (const [bid, d] of Object.entries(BOT_DISPLAY)) if (s.includes(d.name.toLowerCase())) return bots.find((b) => b.bot_id === bid) ?? null;
  const sym = /\b(sol|solana|solusd)\b/.test(s) ? "SOLUSD" : /\b(btc|bitcoin|xbt|btcusd)\b/.test(s) ? "BTCUSD" : null;
  const tf = /\b(1\s?-?\s?m(in(ute)?)?|one[\s-]minute)\b/.test(s) ? "1m" : /\b(5\s?-?\s?m(in(ute)?)?|five[\s-]minute)\b/.test(s) ? "5m" : null;
  if (sym && tf) return bots.find((b) => b.symbol === sym && b.timeframe === tf) ?? null;
  if (context) return bots.find((b) => b.bot_id === context) ?? null;
  return null;
}

const ev = (b: Bot): Evidence[] => [
  { label: "Bot", value: `${b.bot_id} · KRAKEN:${b.symbol} ${b.timeframe} · ${b.profile ?? "no profile"}`, link: "/bots" },
  { label: "Engine report", value: b.engine?.received_at ?? "none" },
];

const groupTotalsOf = (bots: Bot[]) => bots.reduce((t, b) => ({ net: t.net + b.paper.net_usd, gross: t.gross + b.paper.gross_usd, fees: t.fees + b.paper.fees_usd, trades: t.trades + b.paper.trades }), { net: 0, gross: 0, fees: 0, trades: 0 });

export function answer(question: string, fleet: Fleet | null, nowMs: number, context: string | null = null, extra: { closed?: ClosedCard[] } = {}): Answer {
  const q = question.trim();
  const s = q.toLowerCase();
  if (!q) return { text: "Ask about a bot, its trades, fees, capital or status.", evidence: [], known: false };
  if (!fleet || !fleet.available) return { text: UNKNOWN, evidence: [{ label: "Fleet data", value: "unavailable" }], known: false };
  if (/\b(buy|sell|place|open|close|cancel|transfer|move|allocate|set|change|pause|resume|restart|enable|disable)\b.*\b(trade|order|position|risk|money|capital|bot|live|engine)\b/.test(s) && !/\bwhy\b|\bwhat\b|\bhow much\b/.test(s)) {
    return { text: "I'm read-only: I can't place or cancel orders, change risk, move capital, restart bots or enable live trading. Use the Bots page controls for owner actions.", evidence: [], known: true };
  }
  const bots = fleet.bots.filter((b) => b.status !== "DISABLED");
  const bot = findBot(q, bots, context);
  const active = bots.filter((b) => b.status === "ACTIVE");

  // MAIN / transfers
  if (/\bmain\b/.test(s) && /balance|have|available|how much/.test(s) && !/transfer|sweep|swept|moved/.test(s)) {
    return fleet.main ? { text: `MAIN has ${usd(fleet.main.available_usd)} available (PAPER).`, evidence: [{ label: "Wallet MAIN", value: `available ${usd(fleet.main.available_usd)}`, link: "/portfolio" }, { label: "As of", value: fleet.generated_at ?? "now" }], known: true } : { text: UNKNOWN, evidence: [], known: false };
  }
  if (/transfer|swept|sweep|moved to main|sent to main/.test(s)) {
    const list = bot ? [bot] : bots;
    const total = list.reduce((a, b) => a + b.funding.profit_swept_to_main_usd, 0);
    return { text: `${bot ? bot.name : "All bots"}: ${usd(total)} of realized net profit has been transferred to MAIN.`, evidence: list.map((b) => ({ label: b.bot_id, value: `swept ${usd(b.funding.profit_swept_to_main_usd)} · net P&L ${sgn(b.paper.net_usd)}` })), known: true };
  }
  if (/allocat|capital|wallet|balance|reserved/.test(s)) {
    const list = bot ? [bot] : bots;
    return { text: list.map((b) => `${b.name}: ${usd(b.balances.available_usd)} available, ${usd(b.balances.reserved_usd)} reserved, ${usd(b.funding.allocated_usd + b.funding.transferred_in_usd)} allocated in total.`).join(" "),
      evidence: list.map((b) => ({ label: `${b.bot_id} wallet ${b.wallet}`, value: `available ${usd(b.balances.available_usd)} · reserved ${usd(b.balances.reserved_usd)}`, link: "/bots" })), known: true };
  }

  // Rankings (funded PAPER, net after fees; mirror never mixed in)
  if (/best|most|which bot|better|compare/.test(s) && /profit|money|perform|net|factor|pf|win/.test(s)) {
    const ranked = [...active].filter((b) => b.paper.trades > 0);
    if (!ranked.length) return { text: "No bot has closed a funded PAPER trade yet, so there is nothing to compare.", evidence: active.map((b) => ({ label: b.bot_id, value: `${b.paper.trades} closed trades` })), known: true };
    const byPf = /factor|pf/.test(s);
    ranked.sort((a, b) => byPf ? (b.paper.profit_factor ?? -1) - (a.paper.profit_factor ?? -1) : b.paper.net_usd - a.paper.net_usd);
    const top = ranked[0];
    return { text: byPf ? `${top.name} has the best profit factor (${top.paper.profit_factor?.toFixed(2) ?? "n/a"}) over ${top.paper.trades} trade${top.paper.trades === 1 ? "" : "s"}.` : `${top.name} has the highest net funded PAPER result: ${sgn(top.paper.net_usd)} after ${usd(top.paper.fees_usd)} of fees over ${top.paper.trades} trade${top.paper.trades === 1 ? "" : "s"}.`,
      evidence: ranked.map((b) => ({ label: b.bot_id, value: `net ${sgn(b.paper.net_usd)} · gross ${sgn(b.paper.gross_usd)} · fees ${usd(b.paper.fees_usd)} · PF ${b.paper.profit_factor?.toFixed(2) ?? "n/a"} · ${b.paper.trades} trades` })), known: true };
  }

  // Pause state: both layers, from the records (the Worker's owner flag and the engine's own reported setting).
  if (!bot && /\bpaus/.test(s)) {
    const rows = active.map((b) => ({ b, worker: b.entries_paused, engine: b.engine?.ledger_check?.entries_paused === true }));
    const paused = rows.filter((r) => r.worker || r.engine);
    if (!paused.length) return { text: "No bot has new entries paused in the records I have.", evidence: rows.map((r) => ({ label: r.b.name, value: "entries enabled (Worker and engine)" })), known: true };
    return { text: paused.map((r) => `${r.b.name}: new entries paused${r.worker && r.engine ? " (Worker and engine)" : r.engine ? " by the engine (the Worker's owner pause is not set)" : " by the Worker owner control"}; exits and stop management continue.`).join(" "),
      evidence: rows.map((r) => ({ label: r.b.name, value: `Worker pause ${r.worker ? "on" : "off"} · engine pause ${r.engine ? "on" : "off"}` })), known: true };
  }
  // Reliability: per-bot engine report age, market data, ledger reconciliation (never "online" from reachability alone).
  if (!bot && /\b(stale|reconcil|mismatch|diverg|health|reliab|outage|downtime|working properly|any problems?|issues?)\b/.test(s)) {
    const lines = active.map((b) => {
      const es = engineStatus(b, nowMs), lc = b.engine?.ledger_check;
      const ledger = lc ? `ledger check ${lc.status}${lc.issues?.length ? ` (${lc.issues[0]})` : ""}` : "no ledger check reported";
      return `${b.name}: ${es.label} (${botPhase(b, nowMs).phase}); ${ledger}; last engine report ${b.engine?.received_at ? b.engine.received_at.slice(0, 16).replace("T", " ") + " UTC" : "none"}.`;
    });
    return { text: lines.join(" "), evidence: active.map((b) => ({ label: b.name, value: engineStatus(b, nowMs).detail })), known: true };
  }
  // Fee drag over the loaded closed trades: which trades were profitable before fees but not after.
  if (!bot && /(before fees|fee drag|eaten by fees|fees? (cost|ate|took)|gross)/.test(s)) {
    const rows = extra.closed;
    if (!rows) return { text: `${UNKNOWN} The trade history has not loaded yet.`, evidence: [], known: false };
    const t = groupTotalsOf(active);
    if (!t.trades) return { text: "No funded trade has closed yet.", evidence: [], known: true };
    const flipped = rows.filter((c) => c.gross !== null && c.gross !== undefined && c.gross > 0 && c.net <= 0);
    return { text: `Across ${t.trades} closed funded trades the bots made ${sgn(t.gross)} before fees and paid ${usd(t.fees)} in fees, for ${sgn(t.net)} net.${t.gross > 0 ? ` Fees took ${((t.fees / t.gross) * 100).toFixed(0)}% of the gross result.` : ""}${flipped.length ? ` ${flipped.length} of the ${rows.length} loaded trades were profitable before fees and lost after them.` : ""}`,
      evidence: active.map((b) => ({ label: b.name, value: `gross ${sgn(b.paper.gross_usd)} · fees ${usd(b.paper.fees_usd)} · net ${sgn(b.paper.net_usd)}` })), known: true };
  }
  // Research history (backtests and research reports, never forward or live results).
  if (!bot && /(research|backtest|why.*(ote|strateg).*(fail|los|not work)|strategy (results|findings)|profitable strategy)/.test(s)) {
    return { text: "Historical research only (backtests, not PAPER or live results): every OTE / Fibonacci variant tested in rounds 1–6 failed out of sample; on independent 5m data it lost even before fees (round 6). In round 7, long-only trend (Donchian) and momentum rules were positive out of sample but concentrated in a few large trends, so they are INCONCLUSIVE, not validated. Round 8 (momentum rotation) FAILED. Round 9 (five families on 15 untouched markets, sized for the real ~$20 wallets) found no passing strategy: the regime-filtered Donchian breakout was the most robust but is INCONCLUSIVE, and about 90% of its signals are below Kraken order minimums at $20. No strategy has met the pre-registered acceptance criteria.",
      evidence: [{ label: "Round 6", value: "docs/research/round6/REPORT.md" }, { label: "Round 7", value: "docs/research/round7/REPORT.md" }, { label: "Round 9", value: "docs/research/round9/REPORT.md" }, { label: "Mission", value: "docs/research/STRATEGY-DISCOVERY-MISSION.md" }, { label: "Registry", value: "docs/research/registry/COMPARISON.md" }], known: true };
  }
  if (!bot && /\blast (update|verified|refresh)|how (old|fresh|recent)\b/.test(s)) {
    return { text: `The fleet records were generated at ${fleet.generated_at ? fleet.generated_at.slice(0, 19).replace("T", " ") + " UTC" : "an unknown time"}. ${active.map((b) => `${b.name}'s last engine report: ${b.engine?.received_at ? b.engine.received_at.slice(11, 19) + " UTC" : "none"}`).join("; ")}.`,
      evidence: [{ label: "Fleet snapshot", value: fleet.generated_at ?? "unknown" }], known: true };
  }

  // Portfolio-level questions (funded PAPER, the bots' own ledger figures; mirror and research never included)
  if (!bot && /\b(portfolio|account|overall|total|my p&l|my pnl)\b/.test(s) && /\b(down|up|losing|lost|negative|why|how)\b/.test(s) && !/offline|online|running|alive|stale/.test(s)) {
    const t = groupTotalsOf(active);
    if (!t.trades) return { text: "No funded trade has closed yet, so there is no verified result to explain.", evidence: [], known: true };
    const dir = t.net < 0 ? "down" : t.net > 0 ? "up" : "flat";
    const why = t.net < 0 && t.gross >= 0 ? ` The trades made ${sgn(t.gross)} before fees; fees of ${usd(t.fees)} turned that into a loss.`
      : t.net < 0 ? ` The trades lost ${sgn(t.gross)} before fees, and fees added ${usd(t.fees)}.`
      : ` Gross ${sgn(t.gross)}, fees ${usd(t.fees)}.`;
    return { text: `Your funded PAPER result is ${dir} ${usd(Math.abs(t.net))} after fees over ${t.trades} closed trade${t.trades === 1 ? "" : "s"}.${why}`,
      evidence: active.map((b) => ({ label: b.name, value: `net ${sgn(b.paper.net_usd)} · gross ${sgn(b.paper.gross_usd)} · fees ${usd(b.paper.fees_usd)} · ${b.paper.trades} trades`, link: "/trades?view=performance" })), known: true };
  }
  if (!bot && /\b(open|current)\b.*\bpositions?\b|\bpositions?\b.*\bopen\b/.test(s)) {
    const open = active.flatMap((b) => b.open_positions.map((p) => ({ b, p })));
    if (!open.length) return { text: "No funded PAPER position is open right now.", evidence: active.map((b) => ({ label: b.name, value: botPhase(b, nowMs).phase })), known: true };
    return { text: open.map(({ b, p }) => `${b.name}: ${p.side} ${p.qty} @ ${p.entry_price}${p.stop !== null ? `, stop ${b.engine?.strategy_state?.current_stop ?? p.stop}` : ""}${p.tp !== null ? `, target ${p.tp}` : ""}.`).join(" "),
      evidence: open.map(({ b, p }) => ({ label: b.name, value: `${p.trade_id} · opened ${p.opened_at}`, link: `/bots/trade/${encodeURIComponent(p.trade_id)}` })), known: true };
  }
  if (!bot && /\b(bots|fleet|everyone|all)\b/.test(s) && /\b(doing|status|up to|working)\b/.test(s)) {
    return { text: active.map((b) => { const p = botPhase(b, nowMs); return `${b.name}: ${p.phase}${p.detail ? ` (${p.detail})` : ""}.`; }).join(" "),
      evidence: active.map((b) => ({ label: b.name, value: `last report ${b.engine?.received_at ?? "none"}` })), known: true };
  }
  if (!bot && /\bfees?\b/.test(s)) {
    const t = groupTotalsOf(active);
    return { text: `Across all bots you have paid ${usd(t.fees)} in simulated PAPER fees over ${t.trades} closed trade${t.trades === 1 ? "" : "s"} (0.20% per fill).`,
      evidence: active.map((b) => ({ label: b.name, value: `fees ${usd(b.paper.fees_usd)} · ${b.paper.trades} trades` })), known: true };
  }
  if (/\b(most recent|latest|last)\b.*\btrade\b/.test(s) && !bot) {
    const last = extra.closed?.[0];
    if (!extra.closed) return { text: `${UNKNOWN} The trade history has not loaded yet.`, evidence: [], known: false };
    if (!last) return { text: "No funded trade has closed yet.", evidence: [], known: true };
    return { text: `${displayName(last.botId)} closed a ${last.side} on ${last.symbol} at ${last.closedAt.slice(0, 16).replace("T", " ")} UTC for ${sgn(last.net)} after fees.`,
      evidence: [{ label: "Trade", value: last.key, link: last.url }], known: true };
  }

  // Engine health
  if (/offline|online|down|running|alive|stale|disconnect|delayed|outage/.test(s) && !bot) {
    // the phase distinguishes a disconnected engine, a delayed report, delayed market data and a paused (still scanning) bot
    return { text: active.map((b) => { const ph = botPhase(b, nowMs); return `${b.name}: ${ph.phase}${ph.detail ? ` (${ph.detail})` : ""}`; }).join(" · "), evidence: active.map((b) => ({ label: b.bot_id, value: `last report ${b.engine?.received_at ?? "none"} · last candle ${b.engine?.last_candle_time ?? "none"}` })), known: true };
  }
  if (/missing candle|gap/.test(s)) {
    return { text: `${UNKNOWN} The fleet view records each bot's latest processed candle, not a gap list; the Strategy Mirror page lists observation gaps.`, evidence: active.map((b) => ({ label: b.bot_id, value: `last candle ${b.engine?.last_candle_time ?? "none"}` })), known: false };
  }
  if (/today/.test(s)) return { text: `${UNKNOWN} Daily results are not in the fleet records yet; I can give lifetime results.`, evidence: [], known: false };

  if (!bot) return { text: `${UNKNOWN} Name a bot (e.g. "SOL 1m", "BTC 5m" or "ALPHA 02").`, evidence: [], known: false };
  const st = botState(bot, nowMs);
  const offline = st === "OFFLINE" || st === "NO_REPORT" || st === "STALE";
  const lastKnown = offline ? ` (last known, ${st.toLowerCase().replace("_", " ")})` : "";
  const pos = bot.open_positions[0] ?? null;
  const po = bot.engine?.strategy_state?.pending_order ?? null;

  if (bot.status === "PROPOSED") return { text: `${bot.name} is registered with its exact settings but not approved or running, so it has no activity.`, evidence: ev(bot), known: true };
  if (/fee/.test(s)) return { text: `${bot.name} paid ${usd(bot.paper.fees_usd)} in simulated fees over ${bot.paper.trades} closed trades (Ndax-equivalent 0.20% per fill).`, evidence: [...ev(bot), { label: "Formula", value: "fee = 0.20% × fill notional, entry and exit" }], known: true };
  if (/\bstop\b|stop[\s-]?loss/.test(s)) {
    if (pos) return { text: `${bot.name}'s ${pos.side} stop is ${bot.engine?.strategy_state?.current_stop ?? pos.stop}${lastKnown} (initial ${pos.stop ?? "n/a"}).`, evidence: [...ev(bot), { label: "Trade", value: pos.trade_id, link: `/bots/${bot.bot_id}/chart` }], known: true };
    if (po) return { text: `${bot.name} has a pending ${po.side} limit at ${po.limit} with its stop at ${po.stop}${lastKnown}.`, evidence: ev(bot), known: true };
    return { text: `${bot.name} has no open position or pending order${lastKnown}, so there is no stop.`, evidence: ev(bot), known: true };
  }
  if (/take[\s-]?profit|target|\btp\b/.test(s) && !/would|make at/.test(s)) {
    const tp = pos?.tp ?? po?.tp ?? null;
    return tp !== null ? { text: `${bot.name}'s target is ${tp}${lastKnown}.`, evidence: ev(bot), known: true } : { text: `${bot.name} has no target recorded right now${lastKnown}.`, evidence: ev(bot), known: true };
  }
  if (/make at|would .*(make|earn)|at (its|the) target/.test(s)) {
    if (!pos || pos.tp === null) return { text: `${bot.name} has no open position with a target.`, evidence: ev(bot), known: true };
    const dir = pos.side === "LONG" ? 1 : -1;
    const gross = (pos.tp - pos.entry_price) * pos.qty * dir;
    const fees = (pos.entry_fee_usd ?? 0) + pos.tp * pos.qty * 0.002;
    return { text: `If ${bot.name}'s ${pos.side} exits exactly at ${pos.tp}: gross ${sgn(gross)}, estimated net ${sgn(gross - fees)} after fees. A fill at the target is not guaranteed.`, evidence: [...ev(bot), { label: "Formula", value: `(target − entry) × qty × ${dir} − entry fee − 0.20% exit fee` }], known: true };
  }
  if (/afford|minimum/.test(s)) {
    const m = MIN[bot.symbol]; const close = bot.engine?.last_candle_close ?? null;
    if (!m || close === null) return { text: UNKNOWN, evidence: ev(bot), known: false };
    const need = m.qty * close * 1.005 * 1.002;
    return { text: `${bot.name}'s minimum order is ${m.qty} ${bot.symbol.replace("USD", "")} (≈ ${usd(need)} at the last close ${close}, with headroom and fee). It has ${usd(bot.balances.available_usd)} available: ${bot.balances.available_usd >= need ? "it can afford the minimum" : "it cannot afford the minimum"}.`,
      evidence: [...ev(bot), { label: "Kraken minimum", value: `${m.qty} / $${m.notional}` }], known: true };
  }
  if (/why.*(reject|skip|refus|didn|not)|reject|refus/.test(s)) {
    const last = bot.engine?.sizing?.last;
    return last?.code ? { text: `${bot.name}'s last recorded sizing decision was ${last.status} (${last.code})${last.explanation ? `: ${last.explanation}` : ""}${lastKnown}.`, evidence: ev(bot), known: true }
      : { text: `${UNKNOWN} No recorded refusal for ${bot.name}.`, evidence: ev(bot), known: false };
  }
  if (/why.*(short|long|enter|take)/.test(s)) {
    const d = bot.engine?.strategy_state;
    return d?.direction ? { text: `${bot.name}'s strategy recorded a ${d.direction} setup from swing ${d.leg_start} to ${d.leg_end} (OTE retracement entry at 0.705 with PD-array confluence, per its profile ${bot.profile})${lastKnown}. I can only cite what the engine recorded.`, evidence: ev(bot), known: true }
      : { text: `${UNKNOWN} The engine has not recorded a current setup for ${bot.name}.`, evidence: ev(bot), known: false };
  }
  if (/profit|p&l|pnl|made|earn|lose|lost|perform/.test(s)) {
    return { text: `${bot.name}: net ${sgn(bot.paper.net_usd)} (gross ${sgn(bot.paper.gross_usd)}, fees ${usd(bot.paper.fees_usd)}) over ${bot.paper.trades} closed funded PAPER trades; ${usd(bot.funding.profit_swept_to_main_usd)} transferred to MAIN.${bot.mirror[0] ? ` Its hypothetical Strategy Mirror shows ${sgn(bot.mirror[0].gross)} gross (separate, not funded money).` : ""}`,
      evidence: [...ev(bot), { label: "Formula", value: "net = gross − entry fees − exit fees" }], known: true };
  }
  if (/doing|status|waiting|now|activity|up to/.test(s) || true) {
    const p = botPhase(bot, nowMs);
    return { text: `${bot.name} (${bot.symbol} ${bot.timeframe}): ${p.phase}${p.detail ? ` — ${p.detail}` : ""}${lastKnown}.${bot.engine?.status_text ? ` Engine status: "${bot.engine.status_text}".` : ""}`, evidence: ev(bot), known: !offline };
  }
}

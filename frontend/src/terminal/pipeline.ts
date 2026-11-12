// The Home "Pipeline": five stages of the real ALPHA TERMINAL flow, each derived only from data the Worker
// reported (dashboard poll, mirror overview). No counters, percentages, profits or activity are generated here:
// when a stage has no evidence it says so ("Offline", "Stale", "Waiting for candle").

import type { FeedState } from "./poller";
import type { DashboardData } from "./types";
import type { MirrorOverview } from "./mirror";

export type StageStatus =
  | "Processing" | "Waiting for candle" | "Setup found" | "Order pending" | "Entry filled"
  | "Exit recorded" | "Refused" | "Catching up" | "Stale" | "Offline";

export type StageTone = "ok" | "info" | "warn" | "bad" | "muted";
export type StageKey = "market" | "strategy" | "signals" | "risk" | "execution";

export interface Stage {
  key: StageKey;
  title: string;
  status: StageStatus;
  tone: StageTone;
  /** One line of evidence, taken from the Worker's data. */
  detail: string;
  /** Optional second line (e.g. the Strategy Mirror under Execution), always labelled. */
  sub?: string | null;
  /** True while this stage is doing something right now (drives the pulse; off with reduced motion). */
  active: boolean;
}

export const STAGE_TITLES: Record<StageKey, string> = {
  market: "Market Data", strategy: "Strategy", signals: "Signals", risk: "Risk", execution: "Execution / Mirror",
};

const TONE: Record<StageStatus, StageTone> = {
  Processing: "info", "Waiting for candle": "muted", "Setup found": "info", "Order pending": "warn", "Entry filled": "ok",
  "Exit recorded": "ok", Refused: "bad", "Catching up": "warn", Stale: "warn", Offline: "bad",
};

const RECENT_MS = 30 * 60_000; // how long a signal, refusal or exit stays "current" on the pipeline

function tfMinutes(tf: string | null | undefined): number | null {
  const m = /^(\d+)\s*m?$/i.exec(String(tf ?? "").trim());
  return m ? Number(m[1]) : null;
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};
const hhmm = (iso: string) => iso.slice(11, 16);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const usd = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
const qty = (v: number) => String(Number(v.toPrecision(6)));
const price = (v: number) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toPrecision(4));

function stage(key: StageKey, status: StageStatus, detail: string, extra: Partial<Stage> = {}): Stage {
  return { key, title: STAGE_TITLES[key], status, tone: TONE[status], detail, active: false, ...extra };
}

/** Every stage reads the same when there is no trustworthy data at all. */
function allStages(status: "Offline" | "Stale", detail: string): Stage[] {
  return (Object.keys(STAGE_TITLES) as StageKey[]).map((k) => stage(k, status, detail));
}

export interface PipelineInput {
  feed: Pick<FeedState, "status" | "data" | "lastSuccessAt">;
  mirror?: MirrorOverview | null;
  now: number;
}

export function buildPipeline({ feed, mirror = null, now }: PipelineInput): Stage[] {
  const d = feed.data;
  if (!d) {
    return feed.status === "loading" ? allStages("Stale", "Loading…") : allStages("Offline", "The Worker is unreachable; nothing to show.");
  }
  if (feed.status === "stale" || feed.status === "error") {
    const age = feed.lastSuccessAt ? ago(now - feed.lastSuccessAt) : "a while ago";
    return allStages("Stale", `Worker not responding; last good data ${age}.`);
  }
  return [market(d, mirror, now), strategy(d), signals(d, now), risk(d), execution(d, mirror, now)];
}

function market(d: DashboardData, mirror: MirrorOverview | null, now: number): Stage {
  const bot = d.bot;
  const st = bot?.status ?? null;
  if (!bot || bot.state === "NOT_RUNNING") return stage("market", "Offline", "The legacy ALPHA 02 engine (SOLUSD 5m) has not reported to this Worker; each fleet bot's own state is under Bots.");
  if (bot.state === "OFFLINE") return stage("market", "Offline", `Engine heartbeat lost${bot.age_seconds !== null ? ` ${ago(bot.age_seconds * 1000)}` : ""}.`);
  if (bot.state === "STALE") return stage("market", "Stale", `Engine heartbeat is late${bot.age_seconds !== null ? ` (${ago(bot.age_seconds * 1000)})` : ""}.`);
  const tf = tfMinutes(st?.timeframe);
  const last = st?.last_candle_time ?? null;
  const sym = st?.symbol ?? "—";
  if (!last || !tf) return stage("market", "Processing", `${sym}: engine online, no candle processed yet.`, { active: true });
  const closeMs = Date.parse(last) + tf * 60_000; // this candle closed here
  const nextClose = closeMs + tf * 60_000;
  const lagCandles = Math.floor((now - closeMs) / (tf * 60_000));
  const close = num(st?.last_candle_close);
  const gaps = mirror?.markets.some((m) => m.health.observation_gaps.some((g) => Date.parse(g.to) + tf * 60_000 > now - RECENT_MS)) ?? false;
  if (lagCandles >= 3) return stage("market", "Catching up", `${sym} ${tf}m: last candle ${hhmm(last)}, ${lagCandles} candles behind Kraken.`, { active: true });
  const closeTxt = close !== null ? ` closed ${price(close)}` : "";
  const mins = Math.max(0, Math.ceil((nextClose - now) / 60_000));
  return stage("market", gaps ? "Catching up" : "Waiting for candle",
    `${sym} ${tf}m: ${hhmm(last)} candle${closeTxt} · next close ${mins <= 0 ? "now" : `in ~${mins}m`}.`,
    { sub: gaps ? "Recent observation gap recorded (processed late)." : null });
}

function strategy(d: DashboardData): Stage {
  const bot = d.bot;
  const text = bot?.status?.status_text ?? null;
  if (!bot || bot.state === "NOT_RUNNING" || bot.state === "OFFLINE") return stage("strategy", "Offline", "No strategy state: the engine is not reporting.");
  if (bot.state === "STALE") return stage("strategy", "Stale", text ? `Last reported: ${text}.` : "Last state unknown.");
  if (!text) return stage("strategy", "Processing", "Engine online; no strategy state reported yet.", { active: true });
  const t = text.toUpperCase();
  if (t.startsWith("IN TRADE")) return stage("strategy", "Entry filled", text);
  if (t.startsWith("ORDER PLACED")) return stage("strategy", "Order pending", "Limit order placed at the OTE level · waiting for a fill.", { active: true });
  if (t.startsWith("ORDER SKIPPED")) return stage("strategy", "Refused", text);
  if (t.startsWith("WAITING FOR OTE TAP")) return stage("strategy", "Setup found", "Swing and confluence confirmed · waiting for price to tap the OTE zone.", { active: true });
  return stage("strategy", "Waiting for candle", `${text} · checked on every closed candle.`);
}

function signals(d: DashboardData, now: number): Stage {
  const ob = d.bot?.status?.outbox ?? null;
  const pending = num(ob?.pending) ?? 0;
  if (pending > 0) return stage("signals", "Processing", `${pending} signal${pending === 1 ? "" : "s"} queued for delivery to the Worker.`, { active: true });
  const a = d.recent.alerts[0];
  if (!a) return stage("signals", "Waiting for candle", "No signals received yet.");
  const age = now - Date.parse(a.received_at);
  const what = `${a.symbol ?? ""} ${String(a.action ?? "").toUpperCase()}`.trim();
  if (a.status === "processing") return stage("signals", "Processing", `${what} signal received ${ago(age)} · being checked.`, { active: true });
  if (age < RECENT_MS && a.status === "rejected") return stage("signals", "Refused", `${what} refused ${ago(age)}: ${a.response_code ?? "rejected"}.`);
  if (age < RECENT_MS) return stage("signals", "Setup found", `${what} signal accepted ${ago(age)} (dry run).`);
  return stage("signals", "Waiting for candle", `Last signal: ${what} ${a.status === "rejected" ? "refused" : "accepted"} ${ago(age)}.`);
}

function risk(d: DashboardData): Stage {
  const st = d.bot?.status ?? null;
  const fixed = st?.sizing?.risk_usd_fixed ?? st?.risk_usd ?? null;
  const riskTxt = fixed !== null ? `$${fixed} fixed risk` : "fixed risk";
  const ledger = st?.position?.ledger ?? null;
  if (ledger?.status === "NOT_IN_LEDGER") return stage("risk", "Refused", `ALPHA PAPER refused the entry: ${ledger.reason ?? "no reason given"}.`);
  if (ledger?.status === "PENDING") return stage("risk", "Processing", "Entry waiting for the ALPHA PAPER ledger.", { active: true });
  if (ledger?.status === "MIRRORED") return stage("risk", "Entry filled", `Position accepted by the ALPHA PAPER ledger · ${riskTxt}.`);
  const last = st?.sizing?.last ?? null;
  if (last?.current && last.status === "SKIPPED") return stage("risk", "Refused", `Sizing skipped: ${last.reason ?? last.code ?? "no reason given"}.`);
  if (last?.current && last.status === "SIZED" && last.qty !== null) {
    const r = last.risk_actual_usd ?? last.risk_target_usd;
    return stage("risk", "Setup found", `Sized ${last.side ?? ""} ${qty(last.qty)} @ ${last.entry !== null ? price(last.entry) : "—"}${r !== null ? ` · risk $${r.toFixed(2)}` : ""}.`.replace("  ", " "));
  }
  if (!d.bot || d.bot.state !== "ONLINE") return stage("risk", d.bot?.state === "STALE" ? "Stale" : "Offline", `${riskTxt} · no current order to check.`);
  return stage("risk", "Waiting for candle", `${riskTxt} · PAPER only · no order to check.`);
}

function execution(d: DashboardData, mirror: MirrorOverview | null, now: number): Stage {
  const pos = d.paper?.positions ?? [];
  const mirrorLine = mirrorSummary(mirror);
  if (pos.length) {
    const p = pos[0];
    return stage("execution", "Entry filled", `ALPHA PAPER · ${p.symbol} ${p.side.toUpperCase()} ${qty(p.qty)} @ ${price(p.avg_entry_price)}${pos.length > 1 ? ` (+${pos.length - 1} more)` : ""}.`, { sub: mirrorLine });
  }
  if ((d.bot?.status?.status_text ?? "").toUpperCase().startsWith("ORDER PLACED")) {
    return stage("execution", "Order pending", "Strategy order resting · not filled; nothing is executed until it fills.", { sub: mirrorLine, active: true });
  }
  const closed = d.recent.trades.find((t) => t.closed_at);
  if (closed && closed.closed_at && now - Date.parse(closed.closed_at) < RECENT_MS) {
    const pnl = num(closed.realized_pnl);
    return stage("execution", "Exit recorded", `ALPHA PAPER · ${closed.symbol} closed ${ago(now - Date.parse(closed.closed_at))}${pnl !== null ? ` · ${usd(pnl)} PAPER P&L` : ""}.`, { sub: mirrorLine });
  }
  if (!d.paper) return stage("execution", "Offline", "This Worker does not report the ALPHA PAPER ledger.", { sub: mirrorLine });
  return stage("execution", "Waiting for candle", "ALPHA PAPER · no open position. Dry run: no broker orders.", { sub: mirrorLine });
}

/** One labelled line for the Strategy Mirror: hypothetical, never mixed with the funded numbers. */
export function mirrorSummary(o: MirrorOverview | null): string | null {
  if (!o || !o.markets.length) return null;
  const open = o.markets.filter((m) => m.open_position);
  const stale = o.markets.filter((m) => m.health.state === "STALE");
  if (open.length) {
    const m = open[0];
    const p = m.open_position!;
    return `Strategy Mirror (hypothetical) · ${m.symbol} ${p.side ?? ""} open${open.length > 1 ? ` (+${open.length - 1} more)` : ""}`;
  }
  if (stale.length === o.markets.length) return "Strategy Mirror (hypothetical) · stale";
  return `Strategy Mirror (hypothetical) · watching ${o.markets.length} market${o.markets.length === 1 ? "" : "s"} · no open position`;
}

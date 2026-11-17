// Engine outage detection and alerts (candidate, 2026-11-17; migration 0009). Runs in the Worker's one-minute cron on
// Cloudflare, so a power cut or crash of the engine's PC cannot silence it (the 16 Nov outage lasted 700 minutes unseen).
//
// Per ACTIVE fleet bot that has ever reported (app_meta engine_status:<bot_id>):
//   ENGINE_OFFLINE     no report for longer than max(10 min, 3 candles)        -> its stops and exits are NOT managed
//   MARKET_DATA_STALE  reporting, but the last candle is older than 3 candles + 3 min (exchange feed or catch-up issue)
//   (a paused bot that keeps reporting is neither: pausing stops entries, not the engine)
// An episode opens once, alerts once, closes when the condition clears and sends one recovery notice. Several bots
// going down together (the PC) produce ONE notification per device listing them. Read-mostly: the only writes are this
// table's own rows. Trading, the ledger and every safeguard are untouched. Without migration 0009 it does nothing.
import { vapidOf, type EventsEnv } from "./events";
import { sendPush, type PushOutcome } from "./webpush";

export type OutageKind = "ENGINE_OFFLINE" | "REPORT_DELAYED" | "MARKET_DATA_STALE";
/** Kinds that notify devices. REPORT_DELAYED is recorded only (it escalates to ENGINE_OFFLINE, which notifies). */
export const NOTIFY: Record<OutageKind, boolean> = { ENGINE_OFFLINE: true, MARKET_DATA_STALE: true, REPORT_DELAYED: false };
type Send = (sub: { endpoint: string; p256dh: string; auth: string }, payload: unknown) => Promise<PushOutcome>;
interface BotRow { bot_id: string; name: string; symbol: string; timeframe_min: number }
interface OpenRow { id: number; bot_id: string; kind: OutageKind; started_at: string; alerted_at: string | null }

const MIN = 60_000;
/** Whole-engine outage: every reporting bot silent for longer than this. */
export const ENGINE_SILENT_MS = 10 * MIN;
export const offlineAfterMs = (tfMin: number) => Math.max(10 * MIN, 3 * tfMin * MIN);
export const staleAfterMs = (tfMin: number) => (3 * tfMin + 3) * MIN;
/** The dashboard's own ONLINE limit (engine_status.ts): two candles + 2 minutes. */
export const delayedAfterMs = (tfMin: number) => (2 * tfMin + 2) * MIN;
// Display aliases (frontend/src/terminal/botNames.ts), so a notification names the bot the owner knows.
export const DISPLAY_NAMES: Record<string, string> = { "ALPHA-01": "SOL Flare", "ALPHA-02": "SOL Orbit", "ALPHA-03": "BTC Hash", "ALPHA-04": "BTC Atlas" };
const hhmm = (iso: string | null | undefined) => (iso ? `${iso.slice(11, 16)} UTC` : "unknown");

/** The condition for one bot now, from its own last report only. */
export function assess(report: { received_at?: string; last_candle_time?: string } | null, tfMin: number, now: number): OutageKind | null {
  const at = Date.parse(String(report?.received_at ?? ""));
  if (!Number.isFinite(at)) return null; // never reported: not an outage (a bot that has not started)
  if (now - at > offlineAfterMs(tfMin)) return "ENGINE_OFFLINE";
  if (now - at > delayedAfterMs(tfMin)) return "REPORT_DELAYED";
  const candle = Date.parse(String(report?.last_candle_time ?? ""));
  if (Number.isFinite(candle) && now - candle > staleAfterMs(tfMin)) return "MARKET_DATA_STALE";
  return null;
}

export async function checkEngineOutages(env: EventsEnv & { DB: D1Database }, opts: { now?: number; send?: Send; names?: Record<string, string> } = {}) {
  const db = env.DB, now = opts.now ?? Date.now(), iso = new Date(now).toISOString();
  const out = { opened: 0, closed: 0, alerts: 0, recoveries: 0, devices: 0, skipped: null as string | null };
  let bots: BotRow[], reports: Map<string, Record<string, unknown>>, open: OpenRow[];
  try {
    const [b, r, o] = await db.batch([
      db.prepare(`SELECT bot_id, name, symbol, timeframe_min FROM bots WHERE status = 'ACTIVE' ORDER BY bot_id`),
      db.prepare(`SELECT key, value FROM app_meta WHERE key LIKE 'engine_status:%'`),
      db.prepare(`SELECT id, bot_id, kind, started_at, alerted_at FROM engine_outages WHERE ended_at IS NULL`),
    ]);
    bots = (b.results ?? []) as unknown as BotRow[];
    reports = new Map((r.results ?? []).map((x) => { const row = x as { key: string; value: string }; let v: Record<string, unknown> = {}; try { v = JSON.parse(row.value); } catch { /* malformed: ignored */ } return [row.key.slice("engine_status:".length), v]; }));
    open = (o.results ?? []) as unknown as OpenRow[];
  } catch {
    out.skipped = "not installed (migration 0009) or registry unavailable";
    return out;
  }
  const writes: D1PreparedStatement[] = [];
  const newly: { bot: BotRow; kind: OutageKind; last: string | null; candle: string | null }[] = [];
  const recovered: { bot: BotRow; kind: OutageKind; started: string }[] = [];
  // One engine process runs every bot: when EVERY bot that has reported is silent for more than 10 minutes, that is one
  // whole-engine outage (e.g. the PC lost power). All bots are marked offline together, so the owner gets ONE alert
  // instead of one for the 1m bots and another for the 5m bots a few minutes later.
  const ages = bots.map((b) => now - Date.parse(String(reports.get(b.bot_id)?.received_at ?? ""))).filter((a) => Number.isFinite(a));
  const engineDown = ages.length > 1 && ages.length === bots.length && ages.every((a) => a > ENGINE_SILENT_MS);
  for (const bot of bots) {
    const rep = reports.get(bot.bot_id) ?? null;
    const cond = engineDown ? "ENGINE_OFFLINE" : assess(rep as { received_at?: string; last_candle_time?: string } | null, Number(bot.timeframe_min) || 5, now);
    for (const kind of ["ENGINE_OFFLINE", "REPORT_DELAYED", "MARKET_DATA_STALE"] as OutageKind[]) {
      const row = open.find((x) => x.bot_id === bot.bot_id && x.kind === kind);
      if (cond === kind && !row) {
        writes.push(db.prepare(`INSERT OR IGNORE INTO engine_outages (bot_id, kind, started_at, last_report_at) VALUES (?, ?, ?, ?)`).bind(bot.bot_id, kind, iso, (rep?.received_at as string) ?? null));
        newly.push({ bot, kind, last: (rep?.received_at as string) ?? null, candle: (rep?.last_candle_time as string) ?? null });
        out.opened++;
      } else if (cond !== kind && row) {
        writes.push(db.prepare(`UPDATE engine_outages SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).bind(iso, row.id));
        if (row.alerted_at && NOTIFY[kind]) recovered.push({ bot, kind, started: row.started_at });
        out.closed++;
      }
    }
  }
  if (writes.length) await db.batch(writes);
  if (!newly.some((n) => NOTIFY[n.kind]) && !recovered.length) return out;

  // ---- notifications: one message per device per tick, listing every bot affected ----
  const name = (b: BotRow) => (opts.names ?? DISPLAY_NAMES)[b.bot_id] ?? b.name;
  const offline = newly.filter((n) => n.kind === "ENGINE_OFFLINE"), stale = newly.filter((n) => n.kind === "MARKET_DATA_STALE");
  const msgs: { title: string; body: string }[] = [];
  if (offline.length) msgs.push({
    title: offline.length === bots.length && bots.length > 1 ? "ALPHA PAPER · engine offline (all bots)" : `ALPHA PAPER · engine offline · ${offline.map((n) => name(n.bot)).join(", ")}`,
    body: `${offline.map((n) => `${name(n.bot)}: no report since ${hhmm(n.last)}`).join("; ")}. Stops and exits are not managed while the engine is down. Nothing has been changed automatically.`,
  });
  if (stale.length) msgs.push({ title: `ALPHA PAPER · market data delayed · ${stale.map((n) => name(n.bot)).join(", ")}`,
    body: `${stale.map((n) => `${name(n.bot)}: last candle ${hhmm(n.candle)}`).join("; ")}. The engine is reporting, but its candles are not advancing.` });
  if (recovered.length) msgs.push({ title: `ALPHA PAPER · back to normal · ${recovered.map((r) => name(r.bot)).join(", ")}`,
    body: recovered.map((r) => `${name(r.bot)}: ${r.kind === "ENGINE_OFFLINE" ? "engine reporting again" : "candles advancing again"} (since ${hhmm(r.started)} → ${hhmm(iso)})`).join("; ") + "." });

  const vapid = vapidOf(env);
  const send: Send | null = opts.send ?? (vapid ? (sub, payload) => sendPush(sub, payload, vapid, { urgency: "high", ttl: 3600 }) : null);
  let devices = 0;
  if (send) {
    const subs = (await db.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE disabled_at IS NULL`).all<{ id: number; endpoint: string; p256dh: string; auth: string }>().catch(() => ({ results: [] as { id: number; endpoint: string; p256dh: string; auth: string }[] }))).results;
    for (const s of subs) {
      let ok = false;
      for (const m of msgs) { const r = await send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, { ...m, url: "/bots", tag: "alpha-engine-health", ts: iso }); ok = ok || r.ok; }
      if (ok) devices++;
    }
  }
  out.devices = devices;
  const marks: D1PreparedStatement[] = [];
  for (const n of newly.filter((x) => NOTIFY[x.kind])) { marks.push(db.prepare(`UPDATE engine_outages SET alerted_at = ?, alert_devices = ? WHERE bot_id = ? AND kind = ? AND started_at = ?`).bind(iso, devices, n.bot.bot_id, n.kind, iso)); out.alerts++; }
  for (const r of recovered) { marks.push(db.prepare(`UPDATE engine_outages SET recovery_alerted_at = ? WHERE bot_id = ? AND kind = ? AND started_at = ?`).bind(iso, r.bot.bot_id, r.kind, r.started)); out.recoveries++; }
  if (marks.length) await db.batch(marks);
  return out;
}

/** Current classification of every ACTIVE bot (read-only): ONLINE, PAUSED (entries paused, engine reporting),
 *  REPORT_DELAYED, MARKET_DATA_STALE, ENGINE_OFFLINE or NO_REPORT. */
export async function outageStatus(db: D1Database, now = Date.now()) {
  const [b, r] = await db.batch([
    db.prepare(`SELECT bot_id, name, timeframe_min, entries_paused FROM bots WHERE status = 'ACTIVE' ORDER BY bot_id`),
    db.prepare(`SELECT key, value FROM app_meta WHERE key LIKE 'engine_status:%'`),
  ]);
  const reps = new Map((r.results ?? []).map((x) => { const row = x as { key: string; value: string }; let v: Record<string, unknown> = {}; try { v = JSON.parse(row.value); } catch { /* ignored */ } return [row.key.slice(14), v]; }));
  return (b.results ?? []).map((x) => {
    const bot = x as { bot_id: string; name: string; timeframe_min: number; entries_paused: number };
    const rep = reps.get(bot.bot_id) as { received_at?: string; last_candle_time?: string; ledger_check?: { entries_paused?: boolean } } | undefined;
    const cond = assess(rep ?? null, Number(bot.timeframe_min) || 5, now);
    const paused = !!bot.entries_paused || rep?.ledger_check?.entries_paused === true;
    return { bot_id: bot.bot_id, name: DISPLAY_NAMES[bot.bot_id] ?? bot.name, state: !rep || !Number.isFinite(Date.parse(String(rep.received_at ?? ""))) ? "NO_REPORT" : cond ?? (paused ? "PAUSED" : "ONLINE"), paused,
      last_report_at: rep?.received_at ?? null, last_candle_time: rep?.last_candle_time ?? null };
  });
}

/** Recent episodes for the dashboard / assistant (read-only). */
export async function recentOutages(db: D1Database, limit = 20) {
  try {
    return (await db.prepare(`SELECT bot_id, kind, started_at, last_report_at, ended_at, alerted_at, alert_devices, recovery_alerted_at FROM engine_outages ORDER BY id DESC LIMIT ?`).bind(limit).all()).results;
  } catch { return null; } // before migration 0009
}

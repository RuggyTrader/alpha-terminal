// READ-ONLY forward collector for the SOL open-interest reversal study. One run every ~5 minutes (Windows task).
// Public endpoints only (guarded); no wallet, no keys, no orders of any kind (PAPER or real).
//   node collect.mjs <data dir>
// Files in <data dir>: state.json (atomic), hours.jsonl (every hour boundary evaluated), events.jsonl, outcomes.jsonl,
// obs-YYYY-MM.jsonl (raw fetched rows with fetch times), gaps.jsonl, errors.jsonl, runs.jsonl, alerts.log, status.json, lock
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { M5, H, DAY, RULES, classify, entryTime, isPrimary, outcome, netReturns, clusters } from "./core.mjs";

const SYM = "SOLUSDT", ALLOW = new Set(["fapi.binance.com", "perps-api.jup.ag", "api.mainnet-beta.solana.com", "raw.githubusercontent.com"]);
/** Read-only network guard: GET to the allow-listed paths; Solana RPC read methods only. Anything else throws. */
export function guard(fetchFn) {
  return async (url, init = {}) => {
    const u = new URL(url), method = (init.method ?? "GET").toUpperCase();
    if (!ALLOW.has(u.host)) throw new Error(`guard: host ${u.host} refused`);
    if (u.host === "fapi.binance.com" && (method !== "GET" || !["/fapi/v1/klines", "/futures/data/openInterestHist"].includes(u.pathname))) throw new Error(`guard: ${method} ${u.pathname} refused`);
    if (u.host === "perps-api.jup.ag" && (method !== "GET" || u.pathname !== "/v2/market-stats")) throw new Error(`guard: ${method} ${u.pathname} refused`);
    if (u.host === "raw.githubusercontent.com" && method !== "GET") throw new Error("guard: non-GET refused");
    if (u.host === "api.mainnet-beta.solana.com") { const m = JSON.parse(init.body ?? "{}").method; if (!["getMultipleAccounts", "getAccountInfo"].includes(m)) throw new Error(`guard: RPC ${m} refused`); }
    return fetchFn(url, { ...init, headers: { "User-Agent": "research-client (read-only market data)", ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(15_000) });
  };
}
const getJson = async (f, url) => { const r = await f(url); if (!r.ok) throw new Error(`HTTP ${r.status} ${new URL(url).pathname}`); return r.json(); };

async function fetchKlines(f, startT, now) {
  const out = {}; let t = startT;
  const limit = now - startT > 200 * M5 ? 1500 : 200; // bootstrap / catch-up pages of 1500; normal runs request <= 200 (lower API weight)
  for (let i = 0; i < 12 && t < now; i++) { // at most 12 pages per run (bootstrap ~ 7)
    const rows = await getJson(f, `https://fapi.binance.com/fapi/v1/klines?symbol=${SYM}&interval=5m&limit=${limit}&startTime=${t}`);
    if (!rows.length) break;
    for (const x of rows) if (x[6] < now) out[x[0]] = [+x[1], +x[2], +x[3], +x[4]]; // CLOSED bars only (closeTime < now)
    t = rows.at(-1)[0] + M5; if (rows.length < limit) break;
  }
  return out;
}
async function fetchOI(f) { const rows = await getJson(f, `https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYM}&period=5m&limit=60`); return Object.fromEntries(rows.map((r) => [r.timestamp, +r.sumOpenInterest])); }

/** One collector run. opts: { dir, fetchFn, now: () => ms, onchain (optional async () => { borrowHourlySOL }) } */
export async function runOnce({ dir, fetchFn = fetch, now = () => Date.now(), onchain = null, marketStats = null }) {
  mkdirSync(dir, { recursive: true });
  const f = guard(fetchFn), t0 = now(), P = (n) => join(dir, n), log = (n, o) => appendFileSync(P(n), JSON.stringify(o) + "\n");
  // single instance: a lock older than 10 minutes is stale (crashed run) and is taken over, with a record
  const lock = P("lock");
  if (existsSync(lock)) { const held = Number(readFileSync(lock, "utf8")), age = t0 - (Number.isFinite(held) && held > 0 ? held : statSync(lock).mtimeMs); if (age < 10 * 60_000) { log("runs.jsonl", { at: t0, skipped: "another run holds the lock" }); return { skipped: true }; } log("errors.jsonl", { at: t0, kind: "STALE_LOCK", ageMin: age / 60_000 }); }
  writeFileSync(lock, String(t0));
  const st = existsSync(P("state.json")) ? JSON.parse(readFileSync(P("state.json"), "utf8")) : null;
  const S = st ?? { schema: 1, startedAt: t0, firstEligibleT: Math.floor(t0 / H) * H + H, lastEvaluatedT: Math.floor(t0 / H) * H, klines: {}, oi: {}, pending: [], jupiter: null, runs: 0, lastOkAt: null, consecutiveFailures: 0, counts: { hours: 0, strong: 0, qualifying: 0, primary: 0, late: 0, missingOI: 0, missingKlines: 0, resolved: 0, unresolved: 0, gaps: 0, apiFailures: 0, restarts: 0 } };
  if (!st) log("runs.jsonl", { at: t0, event: "INITIALIZED", startedAt: t0, firstEligibleT: S.firstEligibleT });
  // every run is a fresh process; a run after > 15 minutes without one is a recovery from downtime (counted and logged)
  if (st && S.lastRunAt && t0 - S.lastRunAt > 15 * 60_000) { S.counts.gaps++; S.counts.restarts++; log("gaps.jsonl", { from: S.lastRunAt, to: t0, minutes: (t0 - S.lastRunAt) / 60_000, note: "no run in this interval (PC off, task not run, or failures); recovered" }); }
  S.lastRunAt = t0; S.runs++;
  const month = new Date(t0).toISOString().slice(0, 7), errors = [];
  try {
    // 1) ingestion (raw rows logged with the fetch time; nothing is ever reconstructed as if observed live)
    const lastK = Math.max(0, ...Object.keys(S.klines).map(Number));
    const kStart = lastK ? lastK + M5 : Math.floor(t0 / M5) * M5 - (RULES.sigmaHours + 48) * H; // bootstrap: 30+ days for sigma ONLY
    const newK = await fetchKlines(f, kStart, t0), newOI = await fetchOI(f), fetchedAt = now();
    const kAdded = Object.keys(newK).filter((t) => !S.klines[t]), oiAdded = Object.keys(newOI).filter((t) => S.oi[t] === undefined);
    if (lastK && Object.keys(newK).length && Math.min(...Object.keys(newK).map(Number)) > lastK + M5) log("gaps.jsonl", { kind: "KLINE_GAP", after: lastK, next: Math.min(...Object.keys(newK).map(Number)) });
    for (const t of kAdded) S.klines[t] = newK[t];
    for (const t of oiAdded) S.oi[t] = newOI[t];
    if (kAdded.length || oiAdded.length) log(`obs-${month}.jsonl`, { fetchedAt, bootstrap: !lastK, klines: lastK ? Object.fromEntries(kAdded.map((t) => [t, newK[t]])) : { count: kAdded.length, first: Math.min(...kAdded.map(Number)), last: Math.max(...kAdded.map(Number)) }, oi: Object.fromEntries(oiAdded.map((t) => [t, newOI[t]])) });
    // 2) daily on-chain Jupiter borrow rate (read-only), used for the hypothetical cost model
    const day = Math.floor(t0 / DAY) * DAY;
    if (onchain && S.jupiter?.day !== day) { try { S.jupiter = { day, ...(await onchain(f)), fetchedAt: now() }; } catch (e) { errors.push(`jupiter params: ${e.message}`); } }
    // 3) detection for every hour boundary not yet decided (real-time knowledge only)
    for (let T = S.lastEvaluatedT + H; T <= t0; T += H) {
      if (T < S.firstEligibleT) { S.lastEvaluatedT = T; continue; }
      if (!S.klines[T - M5] && t0 < T + 60 * 60_000) break; // bar not available yet: wait
      const c = classify(S.klines, S.oi, T);
      if (c.status === "MISSING_OI" && t0 < T + 60 * 60_000) break; // OI row may still be published
      S.counts.hours++; if (c.status === "MISSING_OI") S.counts.missingOI++; if (c.status === "MISSING_KLINES") S.counts.missingKlines++;
      log("hours.jsonl", { T, decidedAt: fetchedAt, ...c });
      if (c.status === "STRONG") {
        S.counts.strong++;
        const eT = entryTime(T, fetchedAt), primary = isPrimary(T, eT), id = `SOL-${T}`;
        let mark = null; if (c.qualifying && marketStats) { try { mark = await marketStats(f); } catch (e) { errors.push(`market-stats: ${e.message}`); } }
        const ev = { id, T, detectedAt: fetchedAt, entryT: eT, entryDelayMin: (eT - T) / 60_000, primary, late: !primary, ...c, jupiterMarkUsd: mark, borrowHourlySOL: S.jupiter?.borrowHourlySOL ?? null, used: { klineT_1h: S.klines[T - H], klineT_5m: S.klines[T - M5], oiT: c.oiT, oiPrev: c.oiPrev } };
        log("events.jsonl", ev);
        if (c.qualifying) { S.counts.qualifying++; if (primary) S.counts.primary++; else S.counts.late++; S.pending.push({ id, T, entryT: eT, primary, borrowHourlySOL: ev.borrowHourlySOL }); }
      }
      S.lastEvaluatedT = T;
    }
    // 4) outcomes after 4 h (from klines fetched after the fact; missing bars -> UNRESOLVED, never interpolated)
    S.pending = S.pending.filter((p) => {
      const endBar = p.entryT + RULES.horizonMs - M5;
      if (t0 < endBar + M5) return true;
      const g = outcome(S.klines, p.entryT);
      if (g === null && t0 < endBar + M5 + 2 * H) return true;
      const o = g === null ? { id: p.id, status: "UNRESOLVED", checkedAt: now() } : { id: p.id, status: "RESOLVED", resolvedAt: now(), gross: g, net: netReturns(g, p.borrowHourlySOL), entryOpen: S.klines[p.entryT][0], exitClose: S.klines[endBar][3] };
      if (o.status === "RESOLVED") S.counts.resolved++; else S.counts.unresolved++;
      log("outcomes.jsonl", o); return false;
    });
    // 5) retention: 40 days of 5-minute bars (sigma needs 30), 3 days of OI
    for (const t of Object.keys(S.klines)) if (+t < t0 - 40 * DAY) delete S.klines[t];
    for (const t of Object.keys(S.oi)) if (+t < t0 - 3 * DAY) delete S.oi[t];
    S.lastOkAt = t0; S.consecutiveFailures = 0;
  } catch (e) {
    S.consecutiveFailures++; S.counts.apiFailures++; errors.push(e.message);
  }
  for (const m of errors) log("errors.jsonl", { at: t0, error: m });
  const lagMin = (t0 - Math.max(0, ...Object.keys(S.klines).map(Number))) / 60_000;
  if (S.consecutiveFailures >= 6 || lagMin > 30) appendFileSync(P("alerts.log"), `${new Date(t0).toISOString()} ALERT consecutiveFailures=${S.consecutiveFailures} dataLagMin=${lagMin.toFixed(1)}\n`);
  // status: counts and data quality only (NO returns, to avoid optional stopping)
  const primaryIds = S.counts.primary, status = { generatedAt: new Date(t0).toISOString(), mode: "READ-ONLY forward observation (no trading)", startedAt: new Date(S.startedAt).toISOString(), runs: S.runs, lastOkAt: S.lastOkAt && new Date(S.lastOkAt).toISOString(), consecutiveFailures: S.consecutiveFailures, dataLagMinutes: +lagMin.toFixed(1), counts: S.counts, pendingOutcomes: S.pending.length, gate: `${primaryIds} / ${RULES.gate.events} primary events (clusters checked at evaluation, >= ${RULES.gate.clusters})`, errorsThisRun: errors };
  writeFileSync(P("status.json.tmp"), JSON.stringify(status, null, 1)); renameSync(P("status.json.tmp"), P("status.json"));
  log("runs.jsonl", { at: t0, ms: now() - t0, ok: !errors.length, errors: errors.length, qualifying: S.counts.qualifying, lagMin: +lagMin.toFixed(1) });
  writeFileSync(P("state.json.tmp"), JSON.stringify(S)); renameSync(P("state.json.tmp"), P("state.json"));
  try { unlinkSync(lock); } catch {}
  return { status, errors };
}

if (process.argv[1]?.endsWith("collect.mjs")) {
  const dir = process.argv[2];
  let snap = null; try { snap = (await import("./onchain.mjs")).fetchSnapshot; } catch { try { snap = (await import("../../jupiter/onchain.mjs")).fetchSnapshot; } catch {} }
  const onchain = snap ? async (f) => { const s = await snap({ fetchFn: f }); return { borrowHourlySOL: s.custodies.SOL.hourlyBorrowRate, slot: s.slot, idlSha256: s.idlSha256 }; } : null;
  const marketStats = async (f) => { const j = await getJson(f, "https://perps-api.jup.ag/v2/market-stats?mint=So11111111111111111111111111111111111111112"); return Number(j.price); };
  const { status } = await runOnce({ dir, onchain, marketStats });
  if (status) console.log(`${status.generatedAt} runs ${status.runs} lag ${status.dataLagMinutes}m qualifying ${status.counts.qualifying} primary ${status.counts.primary} failures ${status.consecutiveFailures} errors ${status.errorsThisRun.length}`);
}

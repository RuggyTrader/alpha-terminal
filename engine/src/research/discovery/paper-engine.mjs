// Forward PAPER engine: P1 at f = 100 % and 50 %, and S3 at 25 % (docs/research/discovery/PAPER-FORWARD-PREREGISTRATION.md).
// PAPER ONLY: no orders are sent anywhere and no credentials exist. Inputs are the read-only collector's order-book samples
// and public daily candles (Ndax GetTickerHistory, Kraken OHLC). Every new 2-minute sample is processed in time order.
//   node paper-engine.mjs <gap-study dir>   (state: <dir>/paper/state.json, equity log: <dir>/paper/equity.jsonl)
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export const FEE = 0.002, DAY = 86_400_000, HOUR = 3_600_000, HALT_DD = 0.15, START = Date.parse("2026-11-24T00:00:00Z");
export const COST = { BTC: 0.009, ETH: 0.0078, XRP: 0.0088, LTC: 0.011, DOGE: 0.01, SOL: 0.009 };
export const S3_BAND = 0.1 * 0.5 * 0.25; // bt.mjs band for V n200 tv0.4 (0.10 x tv/0.4) x per-asset cap 0.5 x scale 0.25

// ---------------- pure accounting ----------------
/** Buy `notional` CAD walking the asks ([price, qty] best first). { qty, px } or null if the visible book is too thin. */
export function buyWalk(asks, notional) {
  let left = notional, qty = 0;
  for (const [p, q] of asks) { const take = Math.min(left, p * q); qty += take / p; left -= take; if (left <= 1e-9) return { qty, px: notional / qty }; }
  return null;
}
/** Sell `qty` walking the bids. { proceeds, px } or null if the visible book is too thin. */
export function sellWalk(bids, qty) {
  let left = qty, cad = 0;
  for (const [p, q] of bids) { const take = Math.min(left, q); cad += take * p; left -= take; if (left <= 1e-12) return { proceeds: cad, px: cad / qty }; }
  return null;
}
export function newAccount(name, kind, f) { return { name, kind, f, cash: 100, pos: {}, hwm: 100, maxDD: 0, equity: 100, trades: [], missed: [], fees: 0, halted: false, haltPending: false }; }

/** Paper buy of `notional` CAD (fee 0.2 % on top). Records a miss instead if the book is too thin or cash is short. */
export function buy(acct, coin, book, notional, t, meta = {}) {
  if (!(notional >= 1)) { acct.missed.push({ t, coin, why: "below the C$1 minimum" }); return false; }
  const w = book && buyWalk(book.asks, notional);
  if (!w) { acct.missed.push({ t, coin, why: "ask book too thin" }); return false; }
  const fee = notional * FEE;
  if (notional + fee > acct.cash + 1e-9) { acct.missed.push({ t, coin, why: "not enough cash" }); return false; }
  acct.cash -= notional + fee; acct.fees += fee;
  const p = acct.pos[coin] ?? { qty: 0, cost: 0, entryT: t, bars: 0, exitFlag: null };
  acct.pos[coin] = { ...p, ...meta, qty: p.qty + w.qty, cost: p.cost + notional + fee };
  return true;
}
/** Paper sell of `qty` walking the bids (fee 0.2 % of proceeds). Closes a trade record for the sold share of the position. */
export function sell(acct, coin, book, qty, t, reason) {
  const p = acct.pos[coin]; if (!p) return false;
  qty = Math.min(qty, p.qty);
  const w = book && sellWalk(book.bids, qty);
  if (!w) { acct.missed.push({ t, coin, why: "bid book too thin to sell" }); return false; }
  const fee = w.proceeds * FEE, costShare = p.cost * (qty / p.qty);
  acct.cash += w.proceeds - fee; acct.fees += fee;
  acct.trades.push({ coin, entryT: p.entryT, exitT: t, cost: costShare, net: w.proceeds - fee - costShare, ret: (w.proceeds - fee) / costShare - 1, reason });
  if (qty >= p.qty - 1e-12) delete acct.pos[coin]; else acct.pos[coin] = { ...p, qty: p.qty - qty, cost: p.cost - costShare };
  return true;
}
/** Liquidation value: cash + every position sold into the current bids, after the sell fee. Missing book -> last mark. */
export function equity(acct, books) {
  let e = acct.cash;
  for (const [c, p] of Object.entries(acct.pos)) {
    const w = books[c] && sellWalk(books[c].bids, p.qty);
    // a position bigger than the 10 recorded levels is valued punitively at half the deepest recorded bid
    const v = w ? w.proceeds * (1 - FEE) : books[c] ? 0.5 * p.qty * books[c].bids.at(-1)[0] : p.lastValue ?? p.cost;
    p.lastValue = v; e += v;
  }
  return e;
}
/** Mark to market; drawdown from the high-water mark; a 15 % drawdown halts the account (closed at the NEXT sample). */
export function mark(acct, books, t) {
  const e = equity(acct, books);
  acct.equity = e; acct.hwm = Math.max(acct.hwm, e); acct.maxDD = Math.max(acct.maxDD, 1 - e / acct.hwm);
  if (!acct.halted && acct.maxDD >= HALT_DD - 1e-12) { acct.halted = true; acct.haltPending = true; acct.haltT = t; }
  return e;
}
/** S3 rebalance toward target weights (fractions of equity), with bt.mjs's absolute band and sign-change rule. */
export function rebalance(acct, books, targets, band, t) {
  const e = equity(acct, books);
  for (const [c, tw] of Object.entries(targets)) {
    const b = books[c]; if (!b || tw === null) continue;
    const held = acct.pos[c] ? (sellWalk(b.bids, acct.pos[c].qty)?.proceeds ?? 0) : 0, act = held / e;
    if (tw === 0 && !acct.pos[c]) continue;
    if ((tw === 0) === (act === 0) && Math.abs(tw - act) < band) continue;
    if (tw === 0) sell(acct, c, b, acct.pos[c].qty, t, "S3_TARGET_0");
    else if (tw > act) buy(acct, c, b, Math.min((tw - act) * e, acct.cash / (1 + FEE)), t);
    else sell(acct, c, b, acct.pos[c].qty * (1 - tw / act), t, "S3_REDUCE");
  }
}

/**
 * The daily decision at the first sample of a UTC day (pure). inp.p1[coin] = { x, med, signal } from day d-1's close (or null);
 * s3w = { BTC, ETH } target weights already x 0.5 x 0.25 (or null); global(coin) = Kraken mid x USD/CAD mid in CAD.
 */
export function daily(state, s, books, inp, s3w, global) {
  const today = Math.floor(s.t / DAY) * DAY, inWindow = s.t - today < HOUR;
  for (const a of state.accounts.filter((x) => !x.halted)) {
    if (a.kind === "P1") {
      for (const [c, p] of Object.entries(a.pos)) { const d = inp.p1[c]; p.bars = (p.bars ?? 0) + 1; if (d && d.x >= 0) p.exitFlag ??= "REVERTED"; else if (p.bars >= 7) p.exitFlag ??= "TIME_7D"; }
      for (const [c, p] of Object.entries(a.pos)) if (p.exitFlag) sell(a, c, books[c], p.qty, s.t, p.exitFlag);
      const eq = equity(a, books);
      for (const [c, d] of Object.entries(inp.p1)) {
        if (!d?.signal || a.pos[c]) continue;
        if (!inWindow) { a.missed.push({ t: s.t, coin: c, why: "no sample in the 00:00-01:00 UTC window" }); continue; }
        if (Object.keys(a.pos).length >= 3) { a.missed.push({ t: s.t, coin: c, why: "3 slots full" }); continue; }
        const notional = Math.min((eq * a.f) / 3, a.cash / (1 + FEE)), w = books[c] && buyWalk(books[c].asks, notional), g = global(c);
        if (!w || !g) { a.missed.push({ t: s.t, coin: c, why: "no executable book" }); continue; }
        const xExec = w.px / g - 1 - d.med;
        if (!(xExec < -COST[c] / 2)) { a.missed.push({ t: s.t, coin: c, why: `gap gone at execution (${(xExec * 100).toFixed(2)} %)`, crossingGone: true }); continue; }
        buy(a, c, books[c], notional, s.t, { entryT: s.t, bars: 0, exitFlag: null, xSignal: d.x, xExec });
      }
    } else if (s3w && s3w.BTC !== null && s3w.ETH !== null) rebalance(a, books, s3w, S3_BAND, s.t);
  }
}

/** One sample (pure apart from the daily inputs, which the caller supplies when a new day starts). */
export function step(state, s, dayInputs) {
  const books = Object.fromEntries(Object.entries(s.ndax ?? {}).map(([c, n]) => [c, n?.top10 && { bids: n.top10.bids, asks: n.top10.asks }]));
  const k = s.kraken ?? {}, fx = k.USDCAD && (k.USDCAD.bid + k.USDCAD.ask) / 2;
  const global = (c) => (k[c] && fx ? ((k[c].bid + k[c].ask) / 2) * fx : null);
  state.samples = (state.samples ?? 0) + 1;
  for (const a of state.accounts) if (a.haltPending) { for (const c of Object.keys(a.pos)) sell(a, c, books[c], a.pos[c].qty, s.t, "HALT_DRAWDOWN_15"); if (!Object.keys(a.pos).length) a.haltPending = false; }
  if (s.t >= START) {
    const today = Math.floor(s.t / DAY) * DAY;
    if (state.lastDay !== today && dayInputs) { daily(state, s, books, dayInputs.inp, dayInputs.s3w, global); state.lastDay = today; }
    else for (const a of state.accounts.filter((x) => x.kind === "P1" && !x.halted)) for (const [c, p] of Object.entries(a.pos)) if (p.exitFlag) sell(a, c, books[c], p.qty, s.t, p.exitFlag + "_LATE");
  }
  return Object.fromEntries(state.accounts.map((a) => [a.name, +mark(a, books, s.t).toFixed(4)]));
}

// ---------------- public daily inputs (network) ----------------
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const UA = { "User-Agent": "research-client (read-only market data)" };
async function getJson(url, init = {}) { const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.json(); }
export async function fetchDayInputs(today, signalsFn) {
  const kr = async (pair) => { const r = await getJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440`); if (r.error?.length) throw new Error(r.error.join(";")); return Object.values(r.result).find(Array.isArray).map((x) => ({ t: x[0] * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4] })).filter((b) => b.t < today); };
  const fx = new Map((await kr("USDCAD")).map((b) => [b.t, b.c]));
  const IDS = { BTC: [1, "XBTUSD"], ETH: [3, "ETHUSD"], XRP: [4, "XRPUSD"], LTC: [5, "LTCUSD"], DOGE: [77, "XDGUSD"], SOL: [99, "SOLUSD"] };
  const p1 = {}, K = {}, missing = [];
  for (const [c, [id, pair]] of Object.entries(IDS)) {
    K[c] = await kr(pair); const km = new Map(K[c].map((b) => [b.t, b.c]));
    const rows = await getJson("https://api.ndax.io:8443/AP/GetTickerHistory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ OMSId: 1, InstrumentId: id, Interval: 86400, FromDate: new Date(today - 45 * DAY).toISOString().slice(0, 19), ToDate: new Date(today).toISOString().slice(0, 19) }) });
    const prem = rows.filter((x) => x[9] < today).map((x) => ({ t: x[9], p: x[4] / ((km.get(x[9]) ?? NaN) * (fx.get(x[9]) ?? NaN)) - 1, cad: x[5] * x[4] })).filter((x) => Number.isFinite(x.p)).sort((a, b) => a.t - b.t);
    const last = prem.at(-1);
    await new Promise((r) => setTimeout(r, 300));
    if (!last || last.t !== today - DAY || prem.length < 31) { p1[c] = null; missing.push(c); continue; }
    const med = median(prem.slice(-31, -1).map((x) => x.p)), x = last.p - med;
    p1[c] = { x, med, p: last.p, cad: last.cad, signal: x < -COST[c] && last.cad >= 10_000 };
  }
  const s3w = {};
  for (const c of ["BTC", "ETH"]) { const s = signalsFn(K[c], { family: "V", p: { n: 200, tv: 0.4 }, cb: 0 }), w = K[c].at(-1)?.t === today - DAY ? s.target(K[c].length - 1) : null; s3w[c] = w === null ? null : w * 0.5 * 0.25; }
  return { inp: { p1 }, s3w, missing };
}

// ---------------- main (scheduled after each collector sample) ----------------
if (process.argv[1]?.endsWith("paper-engine.mjs")) {
  const DIR = process.argv[2], P = join(DIR, "paper"); mkdirSync(P, { recursive: true });
  const statePath = join(P, "state.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8"))
    : { created: new Date().toISOString(), accounts: [newAccount("P1-100", "P1", 1), newAccount("P1-50", "P1", 0.5), newAccount("S3-25", "S3", 0.25)], lastT: 0, lastDay: null, days: [] };
  const fromDay = new Date(state.lastT).toISOString().slice(0, 10);
  const files = readdirSync(join(DIR, "data")).filter((f) => /^samples-\d{4}-\d\d-\d\d\.jsonl$/.test(f) && f.slice(8, 18) >= fromDay).sort();
  const samples = files.flatMap((f) => readFileSync(join(DIR, "data", f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })).filter((s) => s && s.t > state.lastT).sort((a, b) => a.t - b.t);
  const { signals } = await import("../dd2/bt.mjs").catch(() => import("./bt.mjs"));
  let out = null, n = 0;
  for (const s of samples) {
    const today = Math.floor(s.t / DAY) * DAY;
    let di = null;
    if (s.t >= START && state.lastDay !== today) {
      try {
        di = await fetchDayInputs(today, signals);
        // a daily candle published late: retry (from this same sample) for up to 30 minutes, then decide with what exists
        if (di.missing.length && Date.now() - today < 30 * 60_000) throw new Error(`yesterday's candle not published yet: ${di.missing.join(",")}`);
      }
      catch (e) { appendFileSync(join(P, "errors.log"), `${new Date().toISOString()} daily inputs for ${new Date(today).toISOString().slice(0, 10)}: ${e.message}\n`); break; } // retried next run from this sample
      state.days.push({ day: new Date(today).toISOString().slice(0, 10), firstSample: new Date(s.t).toISOString(), p1: Object.fromEntries(Object.entries(di.inp.p1).map(([c, d]) => [c, d && { x_pct: +(d.x * 100).toFixed(3), cad: Math.round(d.cad), signal: d.signal }])), s3w: di.s3w });
    }
    out = step(state, s, di); state.lastT = s.t; n++;
    appendFileSync(join(P, "equity.jsonl"), JSON.stringify({ t: s.t, ...out }) + "\n");
  }
  writeFileSync(statePath + ".tmp", JSON.stringify(state, null, 1)); renameSync(statePath + ".tmp", statePath);
  console.log(`${new Date().toISOString()} processed ${n} samples${out ? " " + JSON.stringify(out) : ""}`);
}

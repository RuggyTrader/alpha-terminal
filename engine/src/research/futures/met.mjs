// Futures research: one-contract CME Micro Ether (MET) simulator for a $100 PAPER account (research only).
// VERIFIED inputs (2026-11-22): contract 0.1 ETH, tick 0.50 = $0.05 (CME); NinjaTrader all-in fee $0.69/side (Free plan);
// intraday margin $50, initial $49.50; "margin must be met at all times" else liquidation; liquidation fees $25 first,
// $50 later; CME crypto futures 24/7 from 2026-05-29, before that closed weekends and 1 h daily.
// ASSUMED (labelled in reports): price path = Kraken ETH/USD spot (futures basis modelled as a carry rate), session times
// in fixed UTC (CT/DST ignored, +/- 1 h), spread + slippage per side, stop slippage, roll on the last Friday of the month.
export const HOUR = 3_600_000, DAY = 86_400_000;
export const CME_247_FROM = Date.parse("2026-05-29T21:00:00Z");

/** Is CME Globex open for crypto futures at bar time t (hourly bar starting at t)? */
export function cmeOpen(t) {
  if (t >= CME_247_FROM) { const d = new Date(t); return !(d.getUTCDay() === 6 && d.getUTCHours() >= 8 && d.getUTCHours() < 10); } // Sat 2-4 a.m. CT maintenance
  const d = new Date(t), wd = d.getUTCDay(), h = d.getUTCHours();
  if (wd === 6) return false;                       // Saturday closed
  if (wd === 5 && h >= 22) return false;            // Friday from 22:00 UTC
  if (wd === 0 && h < 23) return false;             // Sunday until 23:00 UTC
  if (h === 22) return false;                       // daily maintenance hour (Mon-Thu)
  return true;
}
const lastFridayRoll = (t) => { const d = new Date(t); if (d.getUTCDay() !== 5 || d.getUTCHours() !== 15) return false; const n = new Date(t + 7 * DAY); return n.getUTCMonth() !== d.getUTCMonth(); };

/**
 * H: hourly bars sorted; decide(dayStartT) -> { pos: -1 | 0 | 1, stop?: price } from information up to that day's start.
 * cfg: { capital=100, mult=0.1, fee=0.69, spread=0.0005, stopSlip=0.002, liqThreshold=50, openMin=50, basisAnnual=0.08,
 *        hours="cme" | "247", liqFees=[25, 50] }
 */
export function simulateMET(H, decide, cfg, { from, to }) {
  const { capital = 100, mult = 0.1, fee = 0.69, spread = 0.0005, stopSlip = 0.002, liqThreshold = 50, openMin = 50, basisAnnual = 0.08, hours = "cme", liqFees = [25, 50] } = cfg;
  const open = (t) => (hours === "247" ? true : cmeOpen(t));
  let cash = capital, pos = 0, entry = 0, stop = null, lastPx = null, hwm = capital, dd = 0, ddClose = 0, fees = 0, trades = 0, liqs = 0, rolls = 0, carry = 0, ruined = false;
  let pendingDay = null, decidedFor = null;
  const log = [];
  const eq = (px) => cash + pos * mult * (px - entry);
  const close = (px, why, extraFee = 0) => {
    cash += pos * mult * (px - entry) - fee - extraFee; fees += fee + extraFee; trades++;
    log.push({ t: curT, why, side: pos, entry, exit: px }); pos = 0; stop = null;
  };
  const openPos = (side, px, st) => { if (eq(px) < openMin) return false; pos = side; entry = px; cash -= fee; fees += fee; stop = st ?? null; return true; };
  let curT = from;
  for (const b of H) {
    if (b.t < from) continue; if (b.t >= to) break;
    curT = b.t;
    const day = Math.floor(b.t / DAY) * DAY;
    if (decidedFor !== day) { pendingDay = day; decidedFor = day; }
    if (!open(b.t)) continue; // futures not trading: no fills, no marks (price frozen)
    // 1) daily decision executes at the first open bar of the day (or later, after a closure)
    if (pendingDay !== null && !ruined) {
      const d = decide(pendingDay); pendingDay = null;
      if (d && d.pos !== pos) {
        if (pos !== 0) close(b.o * (1 - pos * spread), "SIGNAL");
        if (d.pos !== 0) { const px = b.o * (1 + d.pos * spread); openPos(d.pos, px, d.stopPct ? px * (1 - d.pos * d.stopPct) : null); }
      }
    }
    // 2) strict marks: best then worst price of the bar (worst-case intrabar order for the drawdown)
    const best = pos > 0 ? b.h : pos < 0 ? b.l : b.c, worst = pos > 0 ? b.l : pos < 0 ? b.h : b.c;
    const eqBest = eq(best);
    // 3) server-side stop (fills at the stop, or at the open after a gap)
    if (pos !== 0 && stop !== null && (pos > 0 ? b.l <= stop : b.h >= stop)) {
      const px = pos > 0 ? Math.min(b.o, stop) * (1 - stopSlip) : Math.max(b.o, stop) * (1 + stopSlip);
      dd = Math.max(dd, 1 - eq(px) / Math.max(hwm, eqBest)); close(px, "STOP");
    }
    // 4) broker liquidation if equity at the worst price falls below the threshold
    if (pos !== 0 && eq(worst) < liqThreshold) {
      const px = worst * (1 - pos * stopSlip);
      dd = Math.max(dd, 1 - eq(px) / Math.max(hwm, eqBest)); close(px, "LIQUIDATION", liqFees[Math.min(liqs, 1)]); liqs++;
    }
    if (pos !== 0) dd = Math.max(dd, 1 - eq(worst) / Math.max(hwm, eqBest));
    // 5) carry (futures premium decays toward spot: longs pay, shorts earn) and monthly roll
    if (pos !== 0) { const c = pos * mult * b.c * basisAnnual / 8760; cash -= c; carry += c; }
    if (pos !== 0 && lastFridayRoll(b.t)) { cash -= 2 * fee + 2 * spread * mult * b.c; fees += 2 * fee; rolls++; }
    lastPx = b.c;
    const e = eq(b.c);
    hwm = Math.max(hwm, eqBest, e); ddClose = Math.max(ddClose, 1 - e / hwm);
    if (e <= 0) { ruined = true; if (pos !== 0) close(b.c, "RUIN"); }
  }
  const final = lastPx === null ? cash : eq(lastPx), years = (to - from) / (365.25 * DAY);
  return { final, cagr_pct: final > 0 ? ((final / capital) ** (1 / years) - 1) * 100 : -100, dd_official_pct: dd * 100, dd_close_pct: ddClose * 100, fees, trades, liquidations: liqs, rolls, carry, ruined, log };
}

// Strategy signal logic ONLY (pure functions; no execution, venue or account knowledge). The PAPER engine and the backtester
// both call these, so changing the execution layer cannot change a signal. Rules: config.frozen.json (jupiter-r11-v1a).
export const H = 3_600_000, H4 = 4 * H, DAY = 86_400_000;

/** Aggregate 1h rows [t, o, h, l, c, v] into UTC-aligned bars of `step` ms. A bar is emitted only when complete (all hours present). */
export function aggregate(rows, step) {
  const out = []; let cur = null, n = 0;
  const need = step / H;
  for (const [t, o, h, l, c, v] of rows) {
    const b = Math.floor(t / step) * step;
    if (!cur || cur.t !== b) { if (cur && n === need) out.push(cur); cur = { t: b, o, h, l, c, v }; n = 1; continue; }
    cur.h = Math.max(cur.h, h); cur.l = Math.min(cur.l, l); cur.c = c; cur.v += v; n++;
  }
  if (cur && n === need) out.push(cur);
  return out;
}

/** Strategy A: Donchian Trend Ensemble on 4h bars. Returns [{ t: close time, signal }] for every bar with full warm-up. */
export function strategyA(bars4, { channelsDays, barsPerDay, exitFraction }, variant) {
  const ns = channelsDays.map((d) => d * barsPerDay), maxN = Math.max(...ns);
  const state = ns.map(() => 0), out = [];
  const hi = (i, n) => { let m = -Infinity; for (let j = i - n; j < i; j++) m = Math.max(m, bars4[j].h); return m; };
  const lo = (i, n) => { let m = Infinity; for (let j = i - n; j < i; j++) m = Math.min(m, bars4[j].l); return m; };
  for (let i = 0; i < bars4.length; i++) {
    if (i < maxN) continue;
    const c = bars4[i].c;
    ns.forEach((n, k) => {
      const ne = Math.max(1, Math.round(n * exitFraction));
      if (state[k] === 1 && c < lo(i, ne)) state[k] = 0;
      else if (state[k] === -1 && c > hi(i, ne)) state[k] = 0;
      if (state[k] === 0) { if (c > hi(i, n)) state[k] = 1; else if (variant === "long_short" && c < lo(i, n)) state[k] = -1; }
    });
    out.push({ t: bars4[i].t + 4 * H, signal: state.reduce((s, x) => s + x, 0) / ns.length });
  }
  return out;
}

/** Strategy B: time-series momentum on daily closes; decisions every holdDays from the anchor. [{ t: decision time, signal }] */
export function strategyB(daily, { lookbackDays, holdDays, anchor }, variant) {
  const a = Date.parse(anchor), byT = new Map(daily.map((d) => [d.t, d])), out = [];
  for (const d of daily) {
    const decT = d.t + DAY; // decision at the close of day d (= 00:00 UTC of the next day)
    if (((decT - a) / DAY) % holdDays !== 0 || decT < a) continue;
    const past = byT.get(d.t - lookbackDays * DAY); if (!past) continue;
    const r = d.c / past.c - 1;
    out.push({ t: decT, signal: r > 0 ? 1 : variant === "long_short" && r < 0 ? -1 : 0 });
  }
  return out;
}

/** Annualised stdev of daily log returns over the last `days` daily bars closed by time t (null without enough history). */
export function sigmaAt(daily, t, days) {
  let i = daily.length - 1; while (i >= 0 && daily[i].t + DAY > t) i--;
  if (i < days) return null;
  const r = []; for (let j = i - days + 1; j <= i; j++) { if (daily[j].t - daily[j - 1].t !== DAY) return null; r.push(Math.log(daily[j].c / daily[j - 1].c)); }
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(365);
}

/** Target exposure (notional / sleeve equity) from a signal: signal x L x min(1, volRef / sigma). */
export const exposure = (signal, L, sigma, volRef) => (sigma && sigma > 0 ? signal * L * Math.min(1, volRef / sigma) : 0);

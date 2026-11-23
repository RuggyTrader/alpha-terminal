// INDEPENDENT re-implementation of the perpetual-style simulator, for audit only. Written from the specification in
// PERP-PREREGISTRATION.md (+ Amendment 1) without reusing perp.mjs code. Different structure: each hour's P&L is split at
// the trade price as u_old x (open - prevClose) + u_new x (close - open); equity is carried explicitly.
const HOUR = 3_600_000, DAY = 86_400_000;

export function simulateIndependent(assets, decide, cfg, { from, to }) {
  const c = { capital: 100, compound: true, slip: 0, liqSlip: 0, missProb: 0, seed: 7, band: 0, ...cfg };
  let s = c.seed >>> 0; const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const maps = assets.map((a) => new Map(a.H.map((b) => [b.t, b])));
  const u = assets.map(() => 0), prevClose = assets.map(() => null);
  let E = c.capital, peak = c.capital, maxDD = 0, ruined = false, liqCount = 0;
  const orderFee = (name, notional) => (c.fee.mode === "ideal" ? notional * c.fee.pct[name] : Math.max(notional * c.fee.pct[name], c.fee.perContract[name]));
  const liqCost = (notional) => (c.fee.mode === "ideal" ? notional * c.liqFee.pct : Math.max(notional * c.liqFee.pct, c.liqFee.perContract));
  for (let t = Math.ceil(from / HOUR) * HOUR; t < to; t += HOUR) {
    const B = maps.map((m) => m.get(t));
    // mark to this hour's open
    assets.forEach((_, j) => { if (B[j] && prevClose[j] !== null) E += u[j] * (B[j].o - prevClose[j]); });
    if (!ruined && t % DAY === 0) {
      const w = decide(t);
      if (w) {
        const base = c.compound ? Math.max(E, 0) : c.capital;
        const want = assets.map((a, j) => (B[j] ? ((w[a.name] ?? 0) * base) / B[j].o : u[j]));
        const needed = assets.reduce((acc, a, j) => acc + (B[j] ? Math.abs(want[j]) * B[j].o * c.margin.init[a.name] : 0), 0);
        const k = needed > E && needed > 0 ? Math.max(E, 0) / needed : 1;
        assets.forEach((a, j) => {
          if (!B[j]) return;
          const target = want[j] * k, delta = target - u[j];
          if (Math.abs(delta) < 1e-12) return;
          const keep = c.band > 0 && target !== 0 && Math.sign(target) === Math.sign(u[j]) && Math.abs(delta) <= c.band * Math.abs(target);
          if (keep) return;
          if (rand() < c.missProb) return;
          const notional = Math.abs(delta) * B[j].o;
          E -= orderFee(a.name, notional) + notional * (c.spread[a.name] / 2 + c.slip);
          u[j] = target;
        });
      }
    }
    // intrabar extremes relative to the open (positions after the open's trades)
    let up = 0, down = 0, req = 0;
    assets.forEach((a, j) => { const b = B[j]; if (!b || !u[j]) return; const hi = u[j] > 0 ? b.h : b.l, lo = u[j] > 0 ? b.l : b.h; up += u[j] * (hi - b.o); down += u[j] * (lo - b.o); req += Math.abs(u[j]) * lo * c.margin.maint[a.name]; });
    maxDD = Math.max(maxDD, 1 - (E + down) / Math.max(peak, E + up)); peak = Math.max(peak, E + up);
    let liquidated = false;
    if (req > 0 && E + down < req) {
      liqCount++; liquidated = true;
      assets.forEach((a, j) => { const b = B[j]; if (!b || !u[j]) return; const lo = u[j] > 0 ? b.l : b.h, px = lo * (1 - Math.sign(u[j]) * c.liqSlip); E += u[j] * (px - b.o) - liqCost(Math.abs(u[j]) * px); u[j] = 0; });
      maxDD = Math.max(maxDD, 1 - E / Math.max(peak, E));
    }
    // to the close, then funding on the close notional
    assets.forEach((a, j) => { const b = B[j]; if (!b) return; if (u[j]) E += u[j] * (b.c - b.o) - a.funding(t) * u[j] * b.c; prevClose[j] = b.c; });
    if (liquidated) assets.forEach((_, j) => { if (B[j]) prevClose[j] = B[j].c; });
    peak = Math.max(peak, E);
    if (E <= 0 && !ruined) { ruined = true; u.fill(0); }
  }
  return { final: E, dd_pct: maxDD * 100, liquidations: liqCount, ruined };
}

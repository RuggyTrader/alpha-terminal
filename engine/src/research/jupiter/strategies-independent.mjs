// INDEPENDENT re-implementation of the A/B signals for validation (written separately, different algorithm:
// rolling extremes via monotonic deques, explicit per-channel state machine, date arithmetic by calendar strings).
// Used only by tests to cross-check strategies.mjs bar by bar. No original source implementation was supplied.
export function strategyAIndependent(bars4, channelsDays, barsPerDay, exitFraction, longShort) {
  const ns = channelsDays.map((d) => d * barsPerDay), warm = Math.max(...ns);
  const maxOf = (arr, len) => { const res = new Array(arr.length).fill(null), dq = []; for (let i = 0; i < arr.length; i++) { while (dq.length && dq[0] <= i - len - 1) dq.shift(); res[i] = dq.length && i >= len ? arr[dq[0]] : null; while (dq.length && arr[dq.at(-1)] <= arr[i]) dq.pop(); dq.push(i); } return res; };
  const minOf = (arr, len) => maxOf(arr.map((x) => -x), len).map((x) => (x === null ? null : -x));
  const highs = bars4.map((b) => b.h), lows = bars4.map((b) => b.l);
  // maxOf(arr, len)[i] = max of arr[i-len .. i-1]
  const ch = ns.map((n) => { const ne = Math.max(1, Math.round(n * exitFraction)); return { up: maxOf(highs, n), dn: minOf(lows, n), xUp: maxOf(highs, ne), xDn: minOf(lows, ne) }; });
  const st = ns.map(() => "FLAT"), out = [];
  for (let i = warm; i < bars4.length; i++) {
    const c = bars4[i].c; let sum = 0;
    for (let k = 0; k < ns.length; k++) {
      const z = ch[k];
      if (st[k] === "LONG" && c < z.xDn[i]) st[k] = "FLAT";
      if (st[k] === "SHORT" && c > z.xUp[i]) st[k] = "FLAT";
      if (st[k] === "FLAT") { if (c > z.up[i]) st[k] = "LONG"; else if (longShort && c < z.dn[i]) st[k] = "SHORT"; }
      sum += st[k] === "LONG" ? 1 : st[k] === "SHORT" ? -1 : 0;
    }
    out.push([bars4[i].t + 14_400_000, sum / ns.length]);
  }
  return out;
}

export function strategyBIndependent(daily, lookbackDays, holdDays, anchorIso, longShort) {
  const closeByDate = new Map(daily.map((d) => [new Date(d.t).toISOString().slice(0, 10), d.c])), out = [];
  const anchor = new Date(anchorIso);
  for (const d of daily) {
    const dec = new Date(d.t); dec.setUTCDate(dec.getUTCDate() + 1);
    const daysFromAnchor = Math.round((dec - anchor) / 86_400_000);
    if (daysFromAnchor < 0 || daysFromAnchor % holdDays) continue;
    const past = new Date(d.t); past.setUTCDate(past.getUTCDate() - lookbackDays);
    const pc = closeByDate.get(past.toISOString().slice(0, 10)); if (pc === undefined) continue;
    const r = d.c / pc - 1;
    out.push([dec.getTime(), r > 0 ? 1 : longShort && r < 0 ? -1 : 0]);
  }
  return out;
}

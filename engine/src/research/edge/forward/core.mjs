// Forward SOL open-interest reversal observation: pure logic (docs/research/edge/FORWARD-SOL-OI-PREREGISTRATION.md).
// Same definitions as research H-OI (phase2-study.mjs oiStudy), group down_OIdown_longClosing. No trading of any kind.
export const M5 = 300_000, H = 3_600_000, DAY = 86_400_000;
export const RULES = Object.freeze({ sigmaHours: 720, sigmaMult: 2, oiCut: 0.005, entryLagMin: 5, primaryMaxDelayMin: 15, horizonMs: 4 * H,
  costsBps: { optimistic: 15, baseline: 30, conservative: 60 }, gate: { events: 60, clusters: 40, clusterGapMs: 4 * H }, pass: { meanBps: 60, ciLowerBps: 30, ciLevel: 0.9 } });

/** 1-hour return ending at boundary T from 5-minute bars { t: [o, h, l, c] }; null if a bar is missing. */
export function hourlyReturn(k, T) { const a = k[T - H], z = k[T - M5]; return a && z ? z[3] / a[0] - 1 : null; }
/** Sample stdev of the previous `n` AVAILABLE hourly returns before T (research: rets.slice(i - 720, i) over existing hours). */
export function sigmaBefore(k, T, n = RULES.sigmaHours, maxLookbackH = 1500) {
  const r = []; for (let i = 1; i <= maxLookbackH && r.length < n; i++) { const x = hourlyReturn(k, T - i * H); if (x !== null) r.push(x); }
  if (r.length < n) return null;
  const m = r.reduce((s, x) => s + x, 0) / n; return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
}
/** Classify hour boundary T. oi: { t: sumOpenInterest }. */
export function classify(k, oi, T) {
  const R = hourlyReturn(k, T); if (R === null) return { status: "MISSING_KLINES" };
  const sigma = sigmaBefore(k, T); if (sigma === null) return { status: "INSUFFICIENT_HISTORY", R };
  if (!(Math.abs(R) > RULES.sigmaMult * sigma)) return { status: "NOT_STRONG", R, sigma };
  const o1 = oi[T], o0 = oi[T - H]; if (!(o1 > 0) || !(o0 > 0)) return { status: "MISSING_OI", R, sigma };
  const dOI = o1 / o0 - 1, dir = Math.sign(R);
  const group = dOI > RULES.oiCut ? (dir > 0 ? "up_OIup_newLongs" : "down_OIup_newShorts") : dOI < -RULES.oiCut ? (dir > 0 ? "up_OIdown_shortCovering" : "down_OIdown_longClosing") : dir > 0 ? "up_neutral" : "down_neutral";
  return { status: "STRONG", R, sigma, dOI, oiT: o1, oiPrev: o0, group, qualifying: group === "down_OIdown_longClosing" };
}
/** Hypothetical entry: the first 5-minute bar starting at or after max(T + 5 min, detection time). */
export function entryTime(T, detectT) { return Math.max(T + RULES.entryLagMin * 60_000, Math.ceil(detectT / M5) * M5); }
export const isPrimary = (T, entryT) => entryT - T <= RULES.primaryMaxDelayMin * 60_000;
/** Gross 4 h rebound of a long from entry open to the close of the bar ending at entry + 4 h; null if a bar is missing. */
export function outcome(k, entryT) { const a = k[entryT], z = k[entryT + RULES.horizonMs - M5]; return a && z ? z[3] / a[0] - 1 : null; }
/** Net returns (fractions) under each cost scenario; borrow for 4 h at the hourly rate (conservative: 2x). */
export function netReturns(gross, borrowHourly) {
  const b = (borrowHourly ?? 0) * 4;
  return { optimistic: gross - RULES.costsBps.optimistic / 1e4 - b, baseline: gross - RULES.costsBps.baseline / 1e4 - b, conservative: gross - RULES.costsBps.conservative / 1e4 - 2 * b };
}
/** Cluster events whose T lie within 4 h of the previous one. Returns arrays of events. */
export function clusters(evs) {
  const s = [...evs].sort((a, b) => a.T - b.T), out = []; let last = -Infinity;
  for (const e of s) { if (e.T - last > RULES.gate.clusterGapMs) out.push([]); out.at(-1).push(e); last = e.T; }
  return out;
}
export const gateMet = (primary) => primary.length >= RULES.gate.events && clusters(primary).length >= RULES.gate.clusters;

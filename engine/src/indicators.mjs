// Pine-equivalent indicator helpers. All work on plain arrays/objects so the full state can be saved to JSON.
// `null` plays the role of Pine's `na`: any comparison involving it is false.

/** ta.atr(len): RMA of the true range. First value = SMA of the first `len` true ranges (Pine's ta.rma). */
export function atrStep(s, high, low, len) {
  const tr = s.prevClose === null ? high - low
    : Math.max(high - low, Math.abs(high - s.prevClose), Math.abs(low - s.prevClose));
  s.n += 1;
  if (s.value === null) {
    s.sum += tr;
    if (s.n >= len) s.value = s.sum / len;
  } else {
    s.value = (tr + (len - 1) * s.value) / len; // alpha = 1/len
  }
  return s.value;
}

export const newAtr = () => ({ n: 0, sum: 0, value: null, prevClose: null });

/**
 * ta.pivothigh(src, L, L) / ta.pivotlow on the bar `L` bars ago, from a window ending at the current bar.
 * Ties: Pine does not document how equal values are treated. Default here is strict on both sides; the
 * comparison against a TradingView export decides whether this needs changing (see engine/README.md).
 */
export function pivot(win, L, kind, ties = { left: "loose", right: "strict" }) {
  if (win.length < 2 * L + 1) return null;
  const end = win.length - 1;
  const c = win[end - L];
  const beats = (other, rule) => kind === "high"
    ? (rule === "strict" ? c > other : c >= other)
    : (rule === "strict" ? c < other : c <= other);
  for (let i = 1; i <= L; i++) {
    if (!beats(win[end - L - i], ties.left)) return null; // left (older) bars
    if (!beats(win[end - L + i], ties.right)) return null; // right (newer) bars
  }
  return c;
}

/** ta.lowest / ta.highest over the last n bars including the current one; na until n bars exist. */
export function lowest(win, n) {
  if (win.length < n) return null;
  let m = Infinity;
  for (let i = win.length - n; i < win.length; i++) m = Math.min(m, win[i]);
  return m;
}
export function highest(win, n) {
  if (win.length < n) return null;
  let m = -Infinity;
  for (let i = win.length - n; i < win.length; i++) m = Math.max(m, win[i]);
  return m;
}

/** math.round_to_mintick. */
export function roundToTick(x, tick) {
  if (x === null || !Number.isFinite(x)) return null;
  return Number((Math.round(x / tick + 1e-9 * Math.sign(x)) * tick).toFixed(10));
}

const fmtCache = new Map();
/** hour, minute and Pine dayofweek (Sunday = 1 … Saturday = 7) of a UTC ms timestamp in a time zone. */
export function zonedParts(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" });
    fmtCache.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const dow = { Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7 }[parts.weekday];
  return { hour: Number(parts.hour), minute: Number(parts.minute), dow };
}

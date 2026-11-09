// Terminal formatting on top of lib/format.ts. Missing values never become numbers.

import { NA, num, pct } from "../lib/format";
import type { NumLike } from "./types";

export { NA, money, signedMoney, price, qty, tone } from "../lib/format";

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "MM-DD HH:MM:SS" — compact, sortable-looking timestamp for tables. */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return NA;
  // SQLite datetime('now') is UTC without a zone ("2026-10-31 04:39:10").
  const v = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(" ", "T")}Z` : iso;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return NA;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function clock(ms: number | null): string {
  if (ms === null) return NA;
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Alpaca returns fractions (0.0123) for *_plpc / change_today. */
export function fractionPct(v: NumLike | undefined): string {
  const n = num(v as string | number | null | undefined);
  return n === null ? NA : pct(n * 100);
}

/** D1 return_pct is stored already in percent. */
export function percent(v: NumLike | undefined): string {
  return pct(v as string | number | null | undefined);
}

export function text(v: string | null | undefined): string {
  return v === null || v === undefined || v === "" ? NA : v;
}

export function upper(v: string | null | undefined): string {
  return v ? v.toUpperCase() : NA;
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const v = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(" ", "T")}Z` : iso;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "12:22" today, otherwise "Oct 31 · 12:22". */
export function when(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return NA;
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${t}`;
}

/** "12:22:01" for feeds. */
export function hms(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : NA;
}

/** Today's P&L as a percentage of yesterday's close equity; null when it cannot be computed. */
export function todayPct(todaysPnl: number | null | undefined, lastEquity: number | null | undefined): number | null {
  const p = num(todaysPnl ?? null);
  const base = num(lastEquity ?? null);
  if (p === null || base === null || base <= 0) return null;
  return (p / base) * 100;
}

export { pct, num };

/**
 * A simulated cost (fee or slippage) shown as a deduction: "−$0.0123". Costs on small PAPER trades are often below a
 * cent, so amounts under $1 keep 4 decimals instead of rounding to $0.00.
 */
export function costMoney(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return NA;
  const n = Math.abs(Number(v));
  if (!Number.isFinite(n)) return NA;
  if (n === 0) return "$0.00";
  return `\u2212$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

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

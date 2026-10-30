import type { Num } from "../types/api";

export const NA = "N/A";

/** Parse an API decimal string; null when missing or not a finite number. */
export function num(v: Num | number | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const usd2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const MINUS = "−";

export function money(v: Num | number | undefined): string {
  const n = num(v);
  if (n === null) return NA;
  return (n < 0 ? `${MINUS}$` : "$") + usd2.format(Math.abs(n));
}

export function signedMoney(v: Num | number | undefined): string {
  const n = num(v);
  if (n === null) return NA;
  const r = Math.round(n * 100) / 100;
  const sign = r > 0 ? "+" : r < 0 ? MINUS : "";
  return `${sign}$${usd2.format(Math.abs(r))}`;
}

/** Tight money for tiles and strips: cents below $1,000, whole dollars above, M above 1e6. */
export function compactMoney(v: Num | number | undefined, signed = false): string {
  const n = num(v);
  if (n === null) return NA;
  const a = Math.abs(n);
  const body = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1000 ? usd0.format(a) : usd2.format(a);
  const r = Math.round(n * 100) / 100;
  const sign = signed ? (r > 0 ? "+" : r < 0 ? MINUS : "") : r < 0 ? MINUS : "";
  return `${sign}$${body}`;
}

export function pct(v: Num | number | undefined, signed = true): string {
  const n = num(v);
  if (n === null) return NA;
  const r = Math.round(n * 100) / 100;
  const sign = signed ? (r > 0 ? "+" : r < 0 ? MINUS : "") : r < 0 ? MINUS : "";
  return `${sign}${Math.abs(r).toFixed(Math.abs(r) >= 100 ? 0 : Math.abs(r) >= 10 ? 1 : 2)}%`;
}

export function qty(v: Num | number | undefined): string {
  const n = num(v);
  if (n === null) return NA;
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, "");
}

export function price(v: Num | number | undefined): string {
  const n = num(v);
  if (n === null) return NA;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function tone(v: Num | number | undefined): "pos" | "neg" | "na" | "zero" {
  const n = num(v);
  if (n === null) return "na";
  const r = Math.round(n * 100) / 100;
  if (r > 0) return "pos";
  if (r < 0) return "neg";
  return "zero";
}

export function time(iso: string | null | undefined): string {
  if (!iso) return NA;
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return NA;
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

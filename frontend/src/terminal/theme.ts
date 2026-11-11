// Light / Dark / System theme. index.html applies the stored choice before the first paint; this module changes it
// and follows the device while "System" is selected. Only the choice itself is stored (localStorage "at-theme"):
// nothing sensitive, and the app works the same when storage is unavailable.

import { useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";
export const THEME_PREFS: ThemePref[] = ["light", "dark", "system"];
export const THEME_LABEL: Record<ThemePref, string> = { light: "Light", dark: "Dark", system: "System" };
const KEY = "at-theme";
const COLORS = { light: "#F3F0EA", dark: "#0F0D0B" } as const;

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

const systemDark = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

export function resolveTheme(pref: ThemePref, deviceDark = systemDark()): "light" | "dark" {
  return pref === "dark" || (pref === "system" && deviceDark) ? "dark" : "light";
}

/** Applies a theme to the document: data-theme, and the browser/iOS status-bar colour. */
export function applyTheme(pref: ThemePref): "light" | "dark" {
  const t = resolveTheme(pref);
  if (typeof document === "undefined") return t;
  const root = document.documentElement;
  root.setAttribute("data-theme", t);
  root.setAttribute("data-theme-pref", pref);
  // One theme-color for the resolved theme (the media-specific tags in index.html are only for the first paint).
  for (const m of Array.from(document.querySelectorAll('meta[name="theme-color"]'))) m.remove();
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = COLORS[t];
  document.head.appendChild(meta);
  return t;
}

export function setThemePref(pref: ThemePref): void {
  try { localStorage.setItem(KEY, pref); } catch { /* storage unavailable: applies for this visit only */ }
  applyTheme(pref);
}

/** Keeps "System" in step with the device (e.g. iOS switching to dark at sunset). Call once at start-up. */
export function watchSystemTheme(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const on = () => { if (readThemePref() === "system") applyTheme("system"); };
  mq.addEventListener?.("change", on);
  return () => mq.removeEventListener?.("change", on);
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  useEffect(() => { applyTheme(pref); }, [pref]);
  return [pref, (p) => { setThemePref(p); setPref(p); }];
}

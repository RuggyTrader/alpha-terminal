// Display preferences stored on this device (localStorage; the app works the same when storage is unavailable).
//   motion     "full" | "reduced"  — reduced also follows the device's own reduce-motion setting
//   companion  "on" | "off"        — the talking globe's speech bubble on Home
// Nothing here affects data, trading or the backend.

import { useEffect, useState } from "react";

export type MotionPref = "full" | "reduced";
export type CompanionPref = "on" | "off";
const KEYS = { motion: "at-motion", companion: "at-companion" } as const;
const listeners = new Set<() => void>();

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: still applied for this visit */ } };

export function readMotion(): MotionPref { return read(KEYS.motion) === "reduced" ? "reduced" : "full"; }
export function readCompanion(): CompanionPref { return read(KEYS.companion) === "off" ? "off" : "on"; }

/** Applies the motion preference to the document (CSS and prefersReducedMotion() read it). */
export function applyMotion(p: MotionPref = readMotion()): void {
  if (typeof document === "undefined") return;
  if (p === "reduced") document.documentElement.setAttribute("data-motion", "reduced");
  else document.documentElement.removeAttribute("data-motion");
}

export function setMotion(p: MotionPref): void { write(KEYS.motion, p); applyMotion(p); listeners.forEach((f) => f()); }
export function setCompanion(p: CompanionPref): void { write(KEYS.companion, p); listeners.forEach((f) => f()); }

export function usePrefs(): { motion: MotionPref; companion: CompanionPref } {
  const [v, setV] = useState(() => ({ motion: readMotion(), companion: readCompanion() }));
  useEffect(() => {
    const f = () => setV({ motion: readMotion(), companion: readCompanion() });
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  return v;
}

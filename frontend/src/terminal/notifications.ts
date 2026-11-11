// Web Push on this device: support detection, enabling (with the passphrase), preferences, test, disable.
// The service worker (/sw.js) is registered only when the user enables notifications and has no fetch handler.

import { api, ApiError } from "../api/client";

export interface NotifyPrefs {
  enabled: boolean;
  funded_entry: boolean; funded_close: boolean; mirror_entry: boolean; mirror_close: boolean;
  include_pnl: boolean; hide_amounts: boolean;
  include_catch_up: boolean; include_historical: boolean;
}

export interface NotifyConfig {
  available: boolean;
  public_key: string | null;
  devices: number;
  max_devices: number;
  reason: string | null;
  defaults: NotifyPrefs;
}

export type Support =
  | { ok: true }
  | { ok: false; why: "needs-home-screen" | "unsupported" | "insecure" };

export interface EnvProbe {
  ua: string;
  maxTouchPoints: number;
  standalone: boolean;
  secure: boolean;
  hasSW: boolean;
  hasPush: boolean;
  hasNotification: boolean;
}

export function probe(): EnvProbe {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { standalone?: boolean }) : null;
  const w = typeof window !== "undefined" ? window : null;
  let standalone = !!nav?.standalone;
  try {
    standalone = standalone || !!w?.matchMedia?.("(display-mode: standalone)").matches;
  } catch {
    /* ignore */
  }
  return {
    ua: nav?.userAgent ?? "", maxTouchPoints: nav?.maxTouchPoints ?? 0, standalone,
    secure: !!w?.isSecureContext, hasSW: !!nav && "serviceWorker" in nav, hasPush: !!w && "PushManager" in w, hasNotification: !!w && "Notification" in w,
  };
}

export const isIOS = (p: Pick<EnvProbe, "ua" | "maxTouchPoints">) =>
  /iPhone|iPad|iPod/.test(p.ua) || (/Macintosh/.test(p.ua) && p.maxTouchPoints > 1);

/** iPhone/iPad: Web Push works only in the app added to the Home Screen (iOS 16.4+), never in a Safari tab. */
export function support(p: EnvProbe): Support {
  if (!p.secure) return { ok: false, why: "insecure" };
  if (isIOS(p) && !p.standalone) return { ok: false, why: "needs-home-screen" };
  if (!p.hasSW || !p.hasPush || !p.hasNotification) return { ok: false, why: isIOS(p) ? "needs-home-screen" : "unsupported" };
  return { ok: true };
}

export function urlB64ToBytes(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const s = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

type Env<T> = { ok: boolean; data?: T; code?: string; message?: string } & Partial<T>;

export async function fetchNotifyConfig(): Promise<NotifyConfig> {
  const env = await api.get<Env<NotifyConfig>>("/api/notifications/config");
  if (!env?.ok || !env.data) throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected response");
  return env.data;
}

/** This device's existing push subscription, without registering anything new. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? await reg.pushManager.getSubscription() : null;
}

export async function deviceStatus(endpoint: string) {
  return api.post<{ ok: boolean; prefs: NotifyPrefs; active: boolean; last_success_at: string | null; last_error: string | null }>("/api/notifications/status", { endpoint });
}

/**
 * Enables notifications on this device. Must run from a tap: the permission prompt is requested first,
 * before any network call, as iOS requires.
 */
export async function enableOnDevice(cfg: NotifyConfig, passphrase: string, prefs: NotifyPrefs): Promise<{ sub: PushSubscription; prefs: NotifyPrefs }> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new ApiError(0, "PERMISSION_DENIED", perm === "denied" ? "Notifications are blocked for this app in the device settings." : "Permission was not granted.");
  if (!cfg.public_key) throw new ApiError(503, "NOT_AVAILABLE", cfg.reason ?? "Notifications are not set up on the Worker");
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(cfg.public_key) as BufferSource });
  const label = isIOS(probe()) ? "iPhone / iPad" : (navigator.platform || "Browser").slice(0, 40);
  try {
    const r = await api.post<{ ok: boolean; prefs: NotifyPrefs }>("/api/notifications/subscribe", { subscription: sub.toJSON(), passphrase, prefs, label });
    return { sub, prefs: r.prefs };
  } catch (e) {
    // Not stored on the Worker: leave nothing behind on the device either.
    await sub.unsubscribe().catch(() => undefined);
    await reg.unregister().catch(() => undefined);
    throw e;
  }
}

export async function savePrefs(endpoint: string, prefs: NotifyPrefs) {
  return (await api.post<{ ok: boolean; prefs: NotifyPrefs }>("/api/notifications/preferences", { endpoint, prefs })).prefs;
}

export async function sendTest(endpoint: string) {
  return api.post<{ ok: boolean; sent: number; failed: number }>("/api/notifications/test", { endpoint });
}

/** Stops notifications for this device on the Worker and removes the subscription and service worker here. */
export async function disableOnDevice(sub: PushSubscription): Promise<void> {
  try {
    await api.post("/api/notifications/unsubscribe", { endpoint: sub.endpoint });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e; // already gone on the Worker: still clean up here
  }
  await sub.unsubscribe().catch(() => undefined);
  const reg = await navigator.serviceWorker.getRegistration("/");
  await reg?.unregister().catch(() => undefined);
}

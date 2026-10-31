// Browser → ALPHA TERMINAL backend only. The browser never talks to Alpaca and
// holds no credentials: authentication is an HttpOnly session cookie.

import type { ApiEnvelope } from "../types/api";

// Public, non-secret base URL of the backend (empty = same origin / Vite proxy).
const BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const listeners = new Set<() => void>();
export function onUnauthorized(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// A request that hangs must fail, so the dashboard can mark its data stale.
export const REQUEST_TIMEOUT_MS = 12000;

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let resp: Response;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    resp = await fetch(BASE + path, {
      method,
      signal: ctrl.signal,
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-Alpha-Terminal": "1",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    clearTimeout(timer);
    throw ctrl.signal.aborted
      ? new ApiError(0, "TIMEOUT", "Backend did not respond in time")
      : new ApiError(0, "OFFLINE", "Backend unreachable");
  }
  let data: unknown = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const env = (data ?? {}) as Partial<ApiEnvelope>;
    if (resp.status === 401 && path !== "/auth/login") listeners.forEach((fn) => fn());
    throw new ApiError(resp.status, env.code ?? "HTTP_" + resp.status, env.message ?? resp.statusText);
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>("GET", path),
  post: <T,>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
};

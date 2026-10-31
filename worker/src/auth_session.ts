// Dashboard sign-in for the browser.
//
// Two separate credentials:
// * DASHBOARD_PASSPHRASE (Worker secret) - typed on the dashboard sign-in
//   screen and compared ONLY by /auth/login. It creates a read-only session.
// * ADMIN_SECRET (Worker secret) - server/admin scripts only, sent as the
//   x-admin-secret header. It is never accepted by /auth/login, and the
//   dashboard never sends, stores or compares it.
//
// "Remember this device" (remember_device: true) only lengthens the session from
// 12 hours to 30 days. Permissions are identical: still read-only.
//
// A successful login sets an HttpOnly, Secure, SameSite=Strict session cookie
// holding a random token; only its SHA-256 hash is stored in D1
// (auth_sessions). The session is READ-ONLY: it unlocks GET /api/dashboard*
// only. Engine controls, kill switch, broker, risk preview, dry-run admin and
// webhook routes do not accept it.

import { secureEqual } from "./trade_core";

export interface AuthEnv {
  DB: D1Database;
  // Worker secret used only by /auth/login. Missing -> AUTH_NOT_CONFIGURED.
  DASHBOARD_PASSPHRASE?: string;
  // Optional, comma separated. Extra origins allowed to call /auth/* (local
  // development through the Vite proxy). Production is same-origin.
  DASHBOARD_ORIGINS?: string;
}

export const SESSION_COOKIE = "at_session";
// Normal session, and the opt-in "Remember this device" session. Both are read-only.
export const SESSION_SECONDS = 12 * 3600;
export const REMEMBERED_SESSION_SECONDS = 30 * 24 * 3600;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_BODY = 4096;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return v.length > 0 && v.length <= 128 ? v : null;
    }
  }
  return null;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** CSRF guard for state-changing /auth routes: custom header + allowed Origin. */
function sameOriginOk(request: Request, env: AuthEnv): boolean {
  if (request.headers.get("x-alpha-terminal") !== "1") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser client; the custom header is still required
  const allowed = new Set<string>([new URL(request.url).origin]);
  for (const o of (env.DASHBOARD_ORIGINS ?? "").split(",")) {
    if (o.trim()) allowed.add(o.trim().replace(/\/$/, ""));
  }
  return allowed.has(origin.replace(/\/$/, ""));
}

/** True when the request carries a valid, unexpired dashboard session cookie. */
export async function hasValidSession(request: Request, env: AuthEnv): Promise<boolean> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const row = await env.DB.prepare(
    "SELECT expires_at FROM auth_sessions WHERE token_hash = ?",
  ).bind(await hashToken(token)).first<{ expires_at: string }>();
  return !!row && Date.parse(row.expires_at) > Date.now();
}

// ---------------------------------------------------------------------------
// Login rate limit (per IP, stored in app_meta so it survives isolates)
// ---------------------------------------------------------------------------

type FailWindow = { n: number; start: number };

async function readFailures(env: AuthEnv, ip: string): Promise<FailWindow> {
  const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key = ?")
    .bind(`auth_fail:${ip}`).first<{ value: string }>();
  if (!row) return { n: 0, start: Date.now() };
  try {
    const w = JSON.parse(row.value) as FailWindow;
    if (Date.now() - w.start > LOGIN_WINDOW_MS) return { n: 0, start: Date.now() };
    return w;
  } catch {
    return { n: 0, start: Date.now() };
  }
}

async function writeFailures(env: AuthEnv, ip: string, w: FailWindow | null): Promise<void> {
  if (!w) {
    await env.DB.prepare("DELETE FROM app_meta WHERE key = ?").bind(`auth_fail:${ip}`).run();
    return;
  }
  await env.DB.prepare(
    "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).bind(`auth_fail:${ip}`, JSON.stringify(w)).run();
}

// ---------------------------------------------------------------------------
// Routes: POST /auth/login, GET /auth/session, POST /auth/logout
// ---------------------------------------------------------------------------

export async function handleAuth(request: Request, env: AuthEnv, pathname: string): Promise<Response> {
  if (pathname === "/auth/session" && request.method === "GET") {
    if (await hasValidSession(request, env)) {
      return json({ ok: true, authenticated: true, read_only: true, mode: "PAPER" });
    }
    return json({ ok: false, code: "UNAUTHORIZED", message: "Not signed in" }, 401);
  }

  if (pathname === "/auth/login" && request.method === "POST") {
    if (!sameOriginOk(request, env)) {
      return json({ ok: false, code: "ORIGIN_NOT_ALLOWED", message: "Request origin not allowed" }, 403);
    }
    const expected = env.DASHBOARD_PASSPHRASE ?? "";
    if (!expected) {
      return json({ ok: false, code: "AUTH_NOT_CONFIGURED", message: "Sign-in is not configured" }, 503);
    }
    const ip = clientIp(request);
    const failures = await readFailures(env, ip);
    if (failures.n >= LOGIN_MAX_FAILURES) {
      return json({ ok: false, code: "RATE_LIMITED", message: "Too many attempts. Try again later." }, 429);
    }

    const raw = await request.text();
    if (raw.length > MAX_LOGIN_BODY) {
      return json({ ok: false, code: "PAYLOAD_TOO_LARGE", message: "Request too large" }, 413);
    }
    let passphrase = "";
    let remember = false;
    try {
      const body = JSON.parse(raw) as { passphrase?: unknown; remember_device?: unknown };
      passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
      // Only an explicit boolean true opts in to the longer session.
      remember = body.remember_device === true;
    } catch {
      return json({ ok: false, code: "INVALID_JSON", message: "Body must be JSON" }, 400);
    }

    if (!passphrase || !(await secureEqual(passphrase, expected))) {
      await writeFailures(env, ip, { n: failures.n + 1, start: failures.start });
      return json({ ok: false, code: "INVALID_PASSPHRASE", message: "Wrong passphrase" }, 401);
    }

    await writeFailures(env, ip, null);
    const now = new Date();
    const lifetime = remember ? REMEMBERED_SESSION_SECONDS : SESSION_SECONDS;
    const expires = new Date(now.getTime() + lifetime * 1000);
    const token = newToken();
    await env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").bind(now.toISOString()).run();
    await env.DB.prepare(
      "INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_seen_at, ip) VALUES (?, ?, ?, ?, ?)",
    ).bind(await hashToken(token), now.toISOString(), expires.toISOString(), now.toISOString(), ip).run();

    return json(
      { ok: true, authenticated: true, read_only: true, remembered: remember, expires_at: expires.toISOString() },
      200,
      { "Set-Cookie": sessionCookie(token, lifetime) },
    );
  }

  if (pathname === "/auth/logout" && request.method === "POST") {
    if (!sameOriginOk(request, env)) {
      return json({ ok: false, code: "ORIGIN_NOT_ALLOWED", message: "Request origin not allowed" }, 403);
    }
    const token = readCookie(request, SESSION_COOKIE);
    if (token) {
      await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
    }
    return json({ ok: true, authenticated: false }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  return json({ ok: false, code: "NOT_FOUND", message: "Route not found" }, 404);
}

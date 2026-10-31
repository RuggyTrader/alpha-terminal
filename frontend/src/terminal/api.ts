// Dashboard calls to the ALPHA TERMINAL Worker. The user signs in with the
// dashboard passphrase (Worker secret DASHBOARD_PASSPHRASE, separate from the
// admin credential); after that the browser sends only the HttpOnly session
// cookie, which it cannot read. The admin credential is never used here.

import { api, ApiError } from "../api/client";
import type { DashboardData, DashboardEnvelope } from "./types";

export const DASHBOARD_LIMIT = 50;

export async function fetchDashboard(limit = DASHBOARD_LIMIT): Promise<DashboardData> {
  const env = await api.get<DashboardEnvelope>(`/api/dashboard?limit=${limit}`);
  if (!env || !env.ok || !env.data) {
    throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected dashboard response");
  }
  // Refuse to render anything that does not identify itself as PAPER.
  if (env.data.mode !== "PAPER") {
    throw new ApiError(502, "UNEXPECTED_MODE", `Backend reported mode ${String(env.data.mode)}, expected PAPER`);
  }
  return env.data;
}

export function checkSession(): Promise<unknown> {
  return api.get("/auth/session");
}

export function login(passphrase: string): Promise<unknown> {
  return api.post("/auth/login", { passphrase });
}

export function logout(): Promise<unknown> {
  return api.post("/auth/logout");
}

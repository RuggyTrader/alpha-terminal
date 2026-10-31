// Sign-out must be truthful: the UI only switches to "signed out" once the
// server has confirmed the session was deleted. The session cookie is
// HttpOnly, so the browser cannot clear it itself; if /auth/logout fails the
// server session may still be active and the user is told so.

import { ApiError } from "../api/client";

export type SignOutResult = { ok: true } | { ok: false; message: string };

export interface SignOutState {
  busy: boolean;
  error: string | null;
}

export const idleSignOut: SignOutState = { busy: false, error: null };

export async function performSignOut(logoutFn: () => Promise<unknown>): Promise<SignOutResult> {
  try {
    await logoutFn();
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      // The server already has no valid session for this browser.
      return { ok: true };
    }
    const why =
      e instanceof ApiError && e.status === 0
        ? "the backend could not be reached"
        : e instanceof ApiError
          ? `the backend answered ${e.code}`
          : "of an unexpected error";
    return {
      ok: false,
      message: `Sign-out failed because ${why}. Your server session may still be active, so you are still signed in here.`,
    };
  }
}

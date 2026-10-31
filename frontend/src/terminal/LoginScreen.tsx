import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { Mark } from "../components/icons";
import { login } from "./api";
import { StatusBadge } from "./components/ui";

function message(e: unknown): string {
  if (!(e instanceof ApiError)) return "Sign-in failed.";
  if (e.status === 0) return "Backend unreachable. Check your connection and try again.";
  if (e.code === "RATE_LIMITED") return "Too many attempts. Wait 15 minutes and try again.";
  if (e.status === 401) return "Wrong passphrase.";
  return `${e.code}: ${e.message}`;
}

/**
 * The dashboard passphrase is sent once to /auth/login and never stored in the browser.
 * "Remember this device" only asks the server for a longer (30-day) read-only session;
 * the browser keeps nothing but the server's HttpOnly cookie.
 */
export function LoginScreen({
  onSignedIn,
  offline = false,
  expired = false,
}: {
  onSignedIn: () => void;
  offline?: boolean;
  expired?: boolean;
}) {
  const [pass, setPass] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    offline ? "Backend unreachable. Check your connection and try again." : expired ? "Session expired. Sign in again." : null,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pass || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(pass, remember);
      setPass("");
      onSignedIn();
    } catch (err) {
      setPass("");
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tlogin">
      <form className="tlogin-card m-rise" onSubmit={submit}>
        <div className="tlogin-brand">
          <Mark size={34} />
          <h1>ALPHA TERMINAL</h1>
        </div>
        <div className="tlogin-badges">
          <StatusBadge tone="info">PAPER DESK</StatusBadge>
          <StatusBadge tone="warn">DRY RUN</StatusBadge>
        </div>
        <label htmlFor="pass">Dashboard passphrase</label>
        <input
          id="pass"
          type="password"
          autoComplete="current-password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoFocus
        />

        <label className="remember" htmlFor="remember">
          <input id="remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span className="remember-switch" aria-hidden />
          <span className="remember-text">
            <b>Remember this device</b>
            <span>Keep this device signed in for 30 days.</span>
          </span>
        </label>

        {error ? <p className="tlogin-err m-fade" role="alert">{error}</p> : null}
        <button type="submit" className="btn btn-primary" disabled={busy || !pass}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="tlogin-note">
          Read-only PAPER dashboard. Your session is an HttpOnly cookie; the passphrase is not stored in this browser.
        </p>
      </form>
    </div>
  );
}

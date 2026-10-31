import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { login } from "./api";

function message(e: unknown): string {
  if (!(e instanceof ApiError)) return "Sign-in failed.";
  if (e.status === 0) return "Backend unreachable. Check your connection and try again.";
  if (e.code === "RATE_LIMITED") return "Too many attempts. Wait 15 minutes and try again.";
  if (e.status === 401) return "Wrong passphrase.";
  return `${e.code}: ${e.message}`;
}

/** The passphrase is sent once to /auth/login and never stored in the browser. */
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
      await login(pass);
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
      <form className="tlogin-card" onSubmit={submit}>
        <div className="tlogin-brand">
          <span className="th-logo" aria-hidden="true">α</span>
          <h1>ALPHA TERMINAL</h1>
        </div>
        <div className="tlogin-badges">
          <span className="tb tb-info">PAPER</span>
          <span className="tb tb-warn">DRY RUN</span>
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
        {error ? <p className="tlogin-err" role="alert">{error}</p> : null}
        <button type="submit" className="tbtn tbtn-primary" disabled={busy || !pass}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="tlogin-note">
          Read-only PAPER dashboard. Your session is an HttpOnly cookie; the passphrase is not stored in this browser.
        </p>
      </form>
    </div>
  );
}

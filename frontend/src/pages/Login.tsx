import { useState } from "react";
import { api, ApiError } from "../api/client";
import { HeroOrb } from "../components/icons";

export function LoginPage({ offline, onSignedIn, onRetry }: { offline: boolean; onSignedIn: () => void; onRetry: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(offline ? "Backend unreachable" : null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/login", { password });
      setPassword("");
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 0 ? "Backend unreachable" : err.message) : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="hero login-hero">
        <HeroOrb />
        <div className="hero-main">
          <div className="hero-title">Alpha Terminal</div>
          <span className="hero-badge">PAPER DESK</span>
          <div className="hero-label">STOCKS + CRYPTO PAPER TRADING</div>
          <div className="login-lock">Private</div>
        </div>
      </section>
      <form className="login-form" onSubmit={submit}>
        <label htmlFor="pw">Admin passphrase</label>
        <input id="pw" className="input" type="password" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" />
        {error && <div className="error-state"><span className="dot" />{error}</div>}
        <button className="btn primary block" disabled={busy || !password}>{busy ? "SIGNING IN…" : "SIGN IN"}</button>
        {offline && <button type="button" className="btn ghost block" onClick={onRetry}>RETRY CONNECTION</button>}
        <p className="footnote">Simulated PAPER balances only. No real money, no withdrawals.</p>
      </form>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { ApiError, onUnauthorized } from "./api/client";
import { checkSession } from "./terminal/api";
import { LoginScreen } from "./terminal/LoginScreen";
import { Terminal } from "./terminal/Terminal";

// v1.2.0: the dashboard is the Cloudflare Worker terminal (src/terminal).
// The v1.1.0 mobile pages in src/pages target the FastAPI backend's API and
// are kept in the repo for reference, but are not routed here.

type AuthState = "checking" | "in" | "out" | "expired" | "offline";

export function App() {
  const [auth, setAuth] = useState<AuthState>("checking");

  const check = useCallback(async () => {
    try {
      await checkSession();
      setAuth("in");
    } catch (e) {
      setAuth(e instanceof ApiError && e.status === 0 ? "offline" : "out");
    }
  }, []);

  useEffect(() => {
    void check();
    return onUnauthorized(() => setAuth((a) => (a === "in" ? "expired" : a)));
  }, [check]);

  if (auth === "checking") {
    return (
      <div className="tsplash" aria-label="Loading">
        <span className="th-logo">α</span>
      </div>
    );
  }
  if (auth !== "in") {
    return <LoginScreen key={auth} offline={auth === "offline"} expired={auth === "expired"} onSignedIn={() => setAuth("in")} />;
  }
  return <Terminal onSignedOut={() => setAuth("out")} onExpired={() => setAuth("expired")} />;
}

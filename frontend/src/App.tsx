import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, onUnauthorized } from "./api/client";
import { AppShell } from "./components/AppShell";
import { Mark } from "./components/icons";
import { ToastProvider } from "./components/ToastManager";
import { ActivityPage } from "./pages/Activity";
import { AlertDetailPage } from "./pages/AlertDetail";
import { EnginePage } from "./pages/Engine";
import { HomePage } from "./pages/Home";
import { LoginPage } from "./pages/Login";
import { SettingsPage } from "./pages/Settings";
import { TradeDetailPage } from "./pages/TradeDetail";
import { TradesPage } from "./pages/Trades";
import { DataProvider } from "./store/DataProvider";

type AuthState = "checking" | "in" | "out" | "offline";

export function App() {
  const [auth, setAuth] = useState<AuthState>("checking");

  const check = useCallback(async () => {
    try {
      await api.get("/auth/session");
      setAuth("in");
    } catch (e) {
      setAuth(e instanceof ApiError && e.status === 0 ? "offline" : "out");
    }
  }, []);

  useEffect(() => {
    void check();
    return onUnauthorized(() => setAuth("out"));
  }, [check]);

  if (auth === "checking") {
    return <div className="splash"><Mark size={44} /></div>;
  }
  if (auth !== "in") return <LoginPage offline={auth === "offline"} onSignedIn={() => setAuth("in")} onRetry={check} />;

  return (
    <BrowserRouter>
      <ToastProvider>
        <DataProvider>
          <AppShell>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/trades" element={<TradesPage />} />
              <Route path="/trades/:id" element={<TradeDetailPage />} />
              <Route path="/alerts/:id" element={<AlertDetailPage />} />
              <Route path="/engine" element={<EnginePage />} />
              <Route path="/activity" element={<ActivityPage />} />
              <Route path="/settings" element={<SettingsPage onSignedOut={() => setAuth("out")} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AppShell>
        </DataProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}

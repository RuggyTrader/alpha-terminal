import { PortfolioPage, StrategyPage } from "./pages/Portfolio";
import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { ActivityPage } from "./pages/Activity";
import { EnginePage } from "./pages/Engine";
import { HomePage } from "./pages/Home";
import { SettingsPage } from "./pages/Settings";
import { TradesPage } from "./pages/Trades";
import { DashboardProvider } from "./store";

/** Page routes, shared by the app and tests (tests supply their own router). */
export function TerminalRoutes(): ReactNode {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/trades" element={<TradesPage />} />
        <Route path="/engine" element={<EnginePage />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/portfolio/:symbol" element={<StrategyPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

export function Terminal({ onSignedOut, onExpired }: { onSignedOut: () => void; onExpired: () => void }) {
  return (
    <BrowserRouter>
      <DashboardProvider onSignedOut={onSignedOut} onExpired={onExpired}>
        <TerminalRoutes />
      </DashboardProvider>
    </BrowserRouter>
  );
}

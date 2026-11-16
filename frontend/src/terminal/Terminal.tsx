import { PortfolioPage, StrategyPage } from "./pages/Portfolio";
import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./AppShell";
import { EnginePage } from "./pages/Engine";
import { HomePage } from "./pages/Home";
import { SettingsPage } from "./pages/Settings";
import { TradesHub } from "./pages/TradesHub";
import { ResearchTrialPage } from "./pages/ResearchTrial";
import { TradeProofPage } from "./pages/TradeProof";
import { DashboardProvider } from "./store";
import { MirrorPage, MirrorTradePage } from "./pages/Mirror";
import { BotsPage } from "./pages/Bots";
import { BotChartPage } from "./pages/BotChart";
import { BotTradeProofPage } from "./pages/BotTradeProof";

/** An old top-level page that now lives inside Trades & Performance: same view, same query parameters. */
function MovedTo({ view }: { view: "performance" | "activity" }) {
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  q.set("view", view);
  return <Navigate to={`/trades?${q.toString()}`} replace />;
}

/** Page routes, shared by the app and tests (tests supply their own router). */
export function TerminalRoutes(): ReactNode {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/trades" element={<TradesHub />} />
        <Route path="/trades/:id" element={<TradeProofPage />} />
        {/* Results and Activity moved into Trades; old links keep working (their filters are carried over). */}
        <Route path="/performance" element={<MovedTo view="performance" />} />
        <Route path="/engine" element={<EnginePage />} />
        <Route path="/mirror" element={<MirrorPage />} />
        <Route path="/research" element={<MirrorPage />} />
        <Route path="/bots" element={<BotsPage />} />
        <Route path="/bots/:id/chart" element={<BotChartPage />} />
        <Route path="/bots/trade/:id" element={<BotTradeProofPage />} />
        <Route path="/mirror/trade/:id" element={<MirrorTradePage />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/portfolio/:symbol" element={<StrategyPage />} />
        <Route path="/activity" element={<MovedTo view="activity" />} />
        <Route path="/research/trial" element={<ResearchTrialPage />} />
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

// Trades & Performance: one tab for every trading record. Sections:
//   Performance (the former Results page, unchanged) · Completed · Open · Pending · Rejected / Cancelled (the all-bot
//   records, each trade once) · Activity (the full recorded event log, formerly its own tab) · Records (the signal,
//   risk and order-intent records, and the per-bot / per-signal filters that older links use).
// The section is in the URL (?view=…), so Home's links, old /performance and /activity links and the back button work.

import { Link, useSearchParams } from "react-router-dom";
import { AllBotTrades } from "../components/AllBotTrades";
import { PerformancePage } from "./Performance";
import { ActivityPage } from "./Activity";
import { TradesPage } from "./Trades";
import { PositionsSection } from "./Home";

export const VIEWS = [
  { id: "performance", label: "Performance" },
  { id: "completed", label: "Completed" },
  { id: "open", label: "Open" },
  { id: "pending", label: "Pending" },
  { id: "rejected", label: "Rejected / Cancelled" },
  { id: "activity", label: "Activity" },
  { id: "records", label: "Signals & records" },
] as const;
export type TradesView = (typeof VIEWS)[number]["id"];

/** The section to show: ?view=…; an older link with ?bot= or ?signal= (and no view) opens the records it filters. */
export function viewOf(params: URLSearchParams): TradesView {
  const v = params.get("view");
  if (VIEWS.some((x) => x.id === v)) return v as TradesView;
  if (params.get("signal") || params.get("bot")) return "records";
  return "completed";
}

export function TradesHub() {
  const [params] = useSearchParams();
  const view = viewOf(params);
  const link = (id: TradesView) => {
    const q = new URLSearchParams(params);
    q.set("view", id);
    if (id !== "records" && id !== "performance") { q.delete("signal"); q.delete("bot"); }
    return `/trades?${q.toString()}`;
  };
  return (
    <div className="th">
      <header className="th-h">
        <h1>Trades &amp; Performance</h1>
        <p>Funded PAPER records only · Strategy Mirror and research are kept separate</p>
      </header>
      <nav className="th-tabs" aria-label="Trades sections">
        {VIEWS.map((v) => (
          <Link key={v.id} to={link(v.id)} replace className={`th-tab m-press${view === v.id ? " on" : ""}`} aria-current={view === v.id ? "page" : undefined}>{v.label}</Link>
        ))}
      </nav>
      <div className="th-body" key={view}>
        {view === "performance" ? <PerformancePage />
          : view === "activity" ? <ActivityPage />
          : view === "records" ? <TradesPage />
          : view === "open" ? <PositionsSection />
          : <AllBotTrades tab={view} />}
      </div>
    </div>
  );
}

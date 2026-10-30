import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useData } from "../store/DataProvider";
import { BottomNav } from "./BottomNav";
import { Mark } from "./icons";
import { Celebration } from "./motion";
import { Badge, statusTone } from "./ui";

export function TopStatus({ title }: { title?: string }) {
  const { engine, summary } = useData();
  const state = engine.data?.engine.state ?? summary.data?.engine.state ?? null;
  const killed = engine.data?.engine.kill_switch ?? summary.data?.engine.kill_switch;
  // If the latest engine/summary requests failed, the last known state is not shown as current.
  const failed = !!engine.error && !!summary.error;
  const offline = failed && engine.error?.status === 0;
  return (
    <header className="top">
      <span className="top-id">
        <Mark size={24} />
        <b>{title ?? "Alpha Terminal"}</b>
      </span>
      <span className="top-right">
        {offline ? <Badge tone="red" dot>OFFLINE</Badge> : failed ? <Badge tone="red" dot>DATA ERROR</Badge>
          : killed ? <Badge tone="red" dot>KILL SWITCH</Badge>
          : state ? <Badge tone={statusTone(state)} dot>{state}</Badge> : null}
        <Badge tone="dark">PAPER</Badge>
      </span>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const { engine, summary, celebrate } = useData();
  const state = engine.data?.engine.state ?? summary.data?.engine.state ?? null;
  return (
    <>
      <main className="app">
        <div className="route" key={loc.pathname.split("/")[1] || "home"}>{children}</div>
      </main>
      <BottomNav engineState={state} />
      <Celebration trigger={celebrate} />
    </>
  );
}

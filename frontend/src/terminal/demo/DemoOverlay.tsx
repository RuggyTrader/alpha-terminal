// DEMO_UI_REPLAY controls — development builds only.
//
// Loaded only when `import.meta.env.DEV && VITE_DEMO_UI === "1"` (see AppShell), so
// production builds contain none of this. It talks to tools/demo-replay/server.mjs
// through the Vite dev proxy; the deployed Worker has no /api/__demo routes.

import { useEffect, useRef, useState } from "react";
import { useDash } from "../store";

interface DemoState {
  step: number;
  total: number;
  label: string;
  playing: boolean;
}

async function call(path: string, method: "GET" | "POST" = "GET"): Promise<DemoState | null> {
  try {
    const r = await fetch(path, { method, headers: { "X-Alpha-Terminal": "1" } });
    if (path.endsWith("/state")) return (await r.json()) as DemoState;
    return null;
  } catch {
    return null;
  }
}

export default function DemoOverlay() {
  const { refresh } = useDash();
  const [st, setSt] = useState<DemoState | null>(null);
  const last = useRef(-1);
  // refresh is recreated on every render; keep the latest in a ref so the poll loop runs once.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Follow the replay: refresh the dashboard as soon as the demo step changes.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await call("/api/__demo/state");
      if (!alive || !s) return;
      setSt(s);
      if (s.step !== last.current) {
        last.current = s.step;
        refreshRef.current();
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 900);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const act = (path: string) => async () => {
    await call(path, "POST");
    const s = await call("/api/__demo/state");
    if (s) {
      setSt(s);
      last.current = s.step;
    }
    refreshRef.current();
  };

  return (
    <div className="demo-bar" role="region" aria-label="Demo mode">
      <style>{CSS}</style>
      <div className="demo-tags">
        <b>DEMO MODE</b>
        <span>PAPER SIMULATION</span>
        <span>NO BROKER ORDER SUBMITTED</span>
        <span>SIMULATED DEMO PRICE</span>
      </div>
      <div className="demo-step">
        {st ? (
          <>
            Step {st.step}/{st.total} · {st.label}
            {st.playing ? <i className="demo-live">playing</i> : null}
          </>
        ) : (
          "Demo server not reachable"
        )}
      </div>
      <div className="demo-ctrl">
        <button type="button" onClick={act("/api/__demo/start?scenario=resume")}>START DEMO</button>
        <button type="button" onClick={act("/api/__demo/start?scenario=full")}>FULL REPLAY</button>
        <button type="button" onClick={act("/api/__demo/start?scenario=winner")}>WINNING TRADE</button>
        <button type="button" onClick={act("/api/__demo/start?scenario=loser")}>LOSING TRADE</button>
        <button type="button" onClick={act("/api/__demo/stop")}>PAUSE</button>
        <button type="button" onClick={act("/api/__demo/reset")}>RESET DEMO</button>
      </div>
    </div>
  );
}

const CSS = `
.demo-bar { position: sticky; top: 0; z-index: 30; margin: 0 -14px 12px; padding: calc(var(--safe-top) + 8px) 14px 10px;
  background: repeating-linear-gradient(135deg, #2a1d0e 0 12px, #20170c 12px 24px); color: #ffd9b0; font-size: 12px; }
.demo-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.demo-tags b, .demo-tags span { padding: 2px 7px; border-radius: 999px; font-size: 10px; font-weight: 800; letter-spacing: .06em; }
.demo-tags b { background: var(--orange); color: #fff; }
.demo-tags span { background: rgba(255,255,255,.1); }
.demo-step { margin-top: 6px; font-weight: 600; color: #fff; overflow-wrap: anywhere; }
.demo-live { margin-left: 6px; font-style: normal; color: #7dffb0; }
.demo-ctrl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
@media (min-width: 640px) { .demo-ctrl { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
.demo-ctrl button { height: 32px; border: 0; border-radius: 8px; background: rgba(255,255,255,.12); color: #fff; font-size: 10px; font-weight: 800; }
.demo-ctrl button:first-child { background: var(--orange); }
@media (min-width: 980px) { .demo-bar { margin: 0 -28px 14px; padding-left: 28px; padding-right: 28px; } }
`;

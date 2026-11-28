// MFFU research page. The published snapshot file is checked as-is; the inline fixture exists only in this test.

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import published from "../../public/research/mffu-dashboard.json";
import { fetchMffuSnapshot, validSnapshot, type MffuSnapshot } from "./mffu";
import { MffuView } from "./pages/Mffu";
import { initialFeedState } from "./poller";
import { idleSignOut } from "./signOut";
import { DashboardContext } from "./store";
import { TerminalRoutes } from "./Terminal";

const html = (s: MffuSnapshot) => renderToStaticMarkup(<MemoryRouter><MffuView s={s} /></MemoryRouter>);
const route = (path: string) => renderToStaticMarkup(
  <MemoryRouter initialEntries={[path]}>
    <DashboardContext.Provider value={{ state: initialFeedState, refresh: () => {}, signOut: idleSignOut, doSignOut: () => {}, dismissSignOut: () => {}, reconnected: false }}>
      <TerminalRoutes />
    </DashboardContext.Provider>
  </MemoryRouter>,
);

describe("MFFU research page", () => {
  it("accepts the published snapshot and renders it as SIMULATED with external execution DISABLED", () => {
    expect(validSnapshot(published)).toBe(true);
    const s = published as unknown as MffuSnapshot;
    const h = html(s);
    expect(h).toContain("SIMULATED · NOT AN MFFU ACCOUNT · NOT APPROVED BY MFFU");
    expect(h).toContain("EXTERNAL EXECUTION DISABLED");
    expect(h).toContain("Never added to funded ALPHA PAPER");
    if (s.demo) expect(h).toContain("DEMO DATA");
    for (const r of s.results) expect(h).toContain(`data-run="${r.run}"`);
    for (const x of s.sources) expect(h).toContain(x.url);
    for (const c of s.contradictions) expect(h).toContain(c.topic);
    expect(h).toContain("Virtual account (end of replay)");
    expect(h).toContain("REMAINING DRAWDOWN");
  });

  it("refuses snapshots that are not marked simulated or that enable external execution", () => {
    const s = published as unknown as MffuSnapshot;
    expect(validSnapshot({ ...s, external_execution: "ENABLED" })).toBe(false);
    expect(validSnapshot({ ...s, simulated: false })).toBe(false);
    expect(validSnapshot({ ...s, schema: "other" })).toBe(false);
  });

  it("times out instead of hanging and explains a missing snapshot", async () => {
    const never = ((_u: string, o: { signal: AbortSignal }) => new Promise((_r, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(fetchMffuSnapshot(10, never)).rejects.toThrow("aborted");
    const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchMffuSnapshot(1000, missing)).rejects.toThrow("No MFFU research snapshot");
    const bad = (async () => new Response(JSON.stringify({ schema: "x" }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchMffuSnapshot(1000, bad)).rejects.toThrow("Snapshot rejected");
  });

  it("is reachable: Settings links to it and the route opens the page", () => {
    expect(route("/settings")).toContain('href="/research/mffu"');
    expect(route("/research/mffu")).toContain("Research · MFFU (simulated)");
  });
});

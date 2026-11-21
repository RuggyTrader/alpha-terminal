// The S3 shadow panel: clearly a separate simulated account; the one-time activation is offered only while proposed and
// sends ONLY the S3 account to the existing activation endpoint. (TEST values.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { S3ShadowView, activateS3, type S3Report } from "./components/S3ShadowPanel";

const proposed: S3Report = {
  available: true,
  account: { status: "PROPOSED", activated_at: null, last_run_at: null, last_error: null, last_daily_t: null },
  alerts: { drawdown_levels_pct: [2, 30], note: "alerts only" },
  equity: { start_usd: 100, equity_usd: 100, net_usd: 0, max_drawdown_pct: 0, current_drawdown_pct: 0, days: 0 },
  latest_signals: [], orders: { filled: 0, skipped_below_minimum: 0, missed_after_outage: 0, pending: 0, fees_usd: 0 }, events: [],
};
const active: S3Report = {
  ...proposed,
  account: { status: "ACTIVE", activated_at: "2026-11-21T23:00:00Z", last_run_at: "2026-11-22T00:01:00Z", last_error: null, last_daily_t: Date.UTC(2026, 10, 21) },
  equity: { start_usd: 100, equity_usd: 99.4, net_usd: -0.6, max_drawdown_pct: 2.4, current_drawdown_pct: 1.1, days: 3 },
  latest_signals: [{ asset: "BTC", day_t: Date.UTC(2026, 10, 21), close: 60000, sma: 72000, target: 0, actual_weight: 0 }, { asset: "ETH", day_t: Date.UTC(2026, 10, 21), close: 1700, sma: 2100, target: 0, actual_weight: 0 }],
  orders: { filled: 2, skipped_below_minimum: 1, missed_after_outage: 0, pending: 0, fees_usd: 0.12 },
  events: [{ at: "2026-11-22T00:01:00Z", kind: "DRAWDOWN_ALERT", detail_json: "{}" }],
};
const html = (t: S3Report) => renderToStaticMarkup(<S3ShadowView t={t} />);

describe("S3 shadow panel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("while proposed: says it is separate and simulated, explains the alerts, and offers the passphrase + Activate S3 Shadow button", () => {
    const out = html(proposed);
    expect(out).toContain("Not part of your bots, your PAPER portfolio");
    expect(out).toContain("Nothing is sent to an exchange");
    expect(out).toContain("not risk limits for your funded PAPER trading");
    expect(out).toContain("Activate S3 Shadow");
    expect(out).toMatch(/type="password"/);
    expect(out).toMatch(/<button[^>]*disabled/); // disabled until a passphrase is typed
    expect(out).not.toContain("Simulated equity");
  });

  it("once active: no button; shows simulated results, signals, skipped orders and alerts as information only", () => {
    const out = html(active);
    expect(out).not.toContain("Activate S3 Shadow");
    expect(out).toContain("Running");
    expect(out).toContain("$99.40");
    expect(out).toContain("2.4% · 1.1%");
    expect(out).toContain("2 · 1");
    expect(out).toContain("BTC 2026-11-21");
    expect(out).toContain("information only");
  });

  it("nothing is shown when the report is unavailable", () => {
    expect(html({ available: false })).toBe("");
  });

  it("the activation request goes to the existing endpoint with the S3 account only (never the other trial, never a bot)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, status: "ACTIVE" }), { status: 200, headers: { "Content-Type": "application/json" } }); }));
    const r = await activateS3("TEST-passphrase");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/paper\/trial-activate$/);
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.account).toBe("TRIAL-S3-SHADOW");
    expect(body.passphrase).toBe("TEST-passphrase");
    expect(typeof body.request_id).toBe("string");
    expect(Object.keys(body).sort()).toEqual(["account", "passphrase", "request_id"]);
  });
});

// Home Pipeline/Activity, notifications (client side), theme, icons and the service worker.
// Fixture data exists only in this file and is labelled as test input.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { deviceItem, mergeActivity, SOURCE_LABEL, type ActivityItem } from "./activity";
import { ActivityPanel, PipelinePanel } from "./components/HomePanels";
import { NotificationSettings } from "./components/NotificationSettings";
import type { MirrorOverview } from "./mirror";
import { isIOS, support, urlB64ToBytes, type EnvProbe } from "./notifications";
import { buildPipeline, mirrorSummary, STAGE_TITLES, type Stage, type StageStatus } from "./pipeline";
import { initialFeedState, type FeedState } from "./poller";
import { resolveTheme, THEME_PREFS } from "./theme";
import type { AlertRow, DashboardData, EngineBot, TradeRow } from "./types";

// Files read from disk (Vitest empties CSS imports). Typed loosely: no @types/node in the app's type environment.
const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as {
  readFileSync: (u: URL, e?: string) => string & { [i: number]: number; length: number };
  existsSync: (u: URL) => boolean;
};
const at = (p: string) => new URL(p, import.meta.url);
const text = (p: string): string => fs.readFileSync(at(p), "utf8");
const exists = (pub: string) => fs.existsSync(at(`../../public/${pub}`));

const html = (n: ReactElement) => renderToStaticMarkup(<MemoryRouter>{n}</MemoryRouter>);
const NOW = Date.parse("2026-11-10T14:03:00Z");
const ALL: StageStatus[] = ["Processing", "Waiting for candle", "Setup found", "Order pending", "Entry filled", "Exit recorded", "Refused", "Catching up", "Stale", "Offline"];

function bot(over: Partial<EngineBot> = {}, status: Partial<NonNullable<EngineBot["status"]>> = {}): EngineBot {
  return {
    state: "ONLINE", age_seconds: 20,
    status: {
      symbol: "SOLUSD", timeframe: "5", status_text: "Waiting for a swing", risk_usd: 10, last_candle_time: "2026-11-10T13:55:00Z", last_candle_close: 151.23,
      position: null, trades: null, outbox: { pending: 0, rejected: 0, late: 0 }, last_error: null, ...status,
    },
    ...over,
  };
}
function dash(over: Partial<DashboardData> = {}): DashboardData {
  return {
    generated_at: "2026-11-10T14:03:00Z", mode: "PAPER", execution: "DRY_RUN_ONLY", broker_submission: false, enable_trading: false, engine: null,
    broker: { mode: "PAPER", read_only: true, errors: [], account: null, positions: [], clock: null } as unknown as DashboardData["broker"],
    counts: { alerts: { total: 0, dry_run: 0, rejected: 0, processing: 0, duplicates: 0 }, risk: { total: 0, approved: 0, rejected: 0 }, orders: { total: 0, dry_run_accepted: 0, unknown: 0, failed: 0 }, trades: { total: 0, open: 0, closed: 0, realized_pnl: 0 } },
    recent: { alerts: [], risk: [], orders: [], trades: [], activity: [] },
    paper: { label: "ALPHA PAPER", simulated: true, broker_positions: false, positions: [], performance: { realized_pnl: 0, unrealized_pnl: 0, total_pnl: 0, marks_stale: false, open_positions: 0, closed_trades: 0 } },
    bot: bot(),
    ...over,
  };
}
const ok = (data: DashboardData): FeedState => ({ ...initialFeedState, status: "ok", data, lastSuccessAt: NOW - 3000 });
const stages = (data: DashboardData, mirror: MirrorOverview | null = null) => buildPipeline({ feed: ok(data), mirror, now: NOW });
const by = (s: Stage[], k: Stage["key"]) => s.find((x) => x.key === k)!;
const alertRow = (over: Partial<AlertRow>): AlertRow => ({
  id: 1, alert_id: "test-1", received_at: "2026-11-10T14:00:00Z", processed_at: null, symbol: "SOLUSD", action: "buy", strategy: "TEST", order_type: "limit",
  requested_qty: "1", accepted_qty: null, status: "dry_run", validation_result: null, response_code: "DRY_RUN_ACCEPTED", http_status: 200, rejection_reason: null,
  duplicate_count: 0, last_duplicate_at: null, ...over,
});
function market(over: Partial<MirrorOverview["markets"][number]> = {}): MirrorOverview["markets"][number] {
  const z = { trades: 0, longs: 0, shorts: 0, wins: 0, gross_pnl: 0, net_modelled_pnl: 0, last_exit_at: null };
  return {
    account_id: "MIRROR-ETHUSD-5m-test", symbol: "ETHUSD", timeframe: "5m", profile: null, inputs_hash: "test", engine_release: null, activated_at: null, last_seen_at: null,
    last_candle_time: null, last_candle_close: null, health: { state: "OK", issues: [], last_seen_age_seconds: 10, observation_gaps: [] }, reconciled: true, open_position: null,
    categories: { live: z, catch_up: z, historical: z }, ...over,
  };
}

describe("pipeline: real statuses from the Worker's data only", () => {
  it("always the five stages in order, each with one of the allowed statuses", () => {
    const s = stages(dash());
    expect(s.map((x) => x.title)).toEqual(Object.values(STAGE_TITLES));
    expect(s.map((x) => x.title)).toEqual(["Market Data", "Strategy", "Signals", "Risk", "Execution / Mirror"]);
    for (const x of s) expect(ALL).toContain(x.status);
  });

  it("no data: Offline everywhere (Worker unreachable); loading is not shown as activity", () => {
    const off = buildPipeline({ feed: { ...initialFeedState, status: "error", data: null }, now: NOW });
    expect(new Set(off.map((x) => x.status))).toEqual(new Set(["Offline"]));
    expect(off.every((x) => !x.active)).toBe(true);
    const loading = buildPipeline({ feed: initialFeedState, now: NOW });
    expect(loading.every((x) => !x.active)).toBe(true);
  });

  it("stale feed: every stage Stale, with the age of the last good data", () => {
    const s = buildPipeline({ feed: { ...ok(dash()), status: "stale", lastSuccessAt: NOW - 120_000 }, now: NOW });
    expect(new Set(s.map((x) => x.status))).toEqual(new Set(["Stale"]));
    expect(s[0].detail).toMatch(/2m ago/);
  });

  it("engine offline / stale / never reported", () => {
    expect(by(stages(dash({ bot: bot({ state: "OFFLINE", age_seconds: 900 }) })), "market").status).toBe("Offline");
    expect(by(stages(dash({ bot: bot({ state: "STALE", age_seconds: 200 }) })), "market").status).toBe("Stale");
    expect(by(stages(dash({ bot: bot({ state: "NOT_RUNNING", status: null }) })), "strategy").status).toBe("Offline");
    expect(by(stages(dash({ bot: undefined })), "market").status).toBe("Offline");
  });

  it("market data: waiting for the next candle with its real time and close; far behind = Catching up", () => {
    const m = by(stages(dash()), "market");
    expect(m.status).toBe("Waiting for candle");
    expect(m.detail).toContain("13:55 candle closed 151.23");
    expect(m.detail).toMatch(/next close in ~2m/);
    const lag = by(stages(dash({ bot: bot({}, { last_candle_time: "2026-11-10T13:30:00Z" }) })), "market");
    expect(lag.status).toBe("Catching up");
    expect(lag.detail).toMatch(/candles behind/);
  });

  it("a recent mirror observation gap shows Catching up", () => {
    const gap = market({ health: { state: "DEGRADED", issues: [], last_seen_age_seconds: 5, observation_gaps: [{ from: "2026-11-10T13:20:00Z", to: "2026-11-10T13:50:00Z", candles: 7 }] } });
    expect(by(stages(dash(), { label: "", disclosure: "", note: "", markets: [gap] }), "market").status).toBe("Catching up");
  });

  it("strategy: the engine's own status text, mapped", () => {
    const at = (t: string) => by(stages(dash({ bot: bot({}, { status_text: t }) })), "strategy");
    expect(at("Waiting for a swing").status).toBe("Waiting for candle");
    expect(at("Need more confluence").status).toBe("Waiting for candle");
    expect(at("Waiting for OTE tap").status).toBe("Setup found");
    expect(at("ORDER PLACED - waiting fill").status).toBe("Order pending");
    expect(at("IN TRADE (trailing SL)").status).toBe("Entry filled");
    expect(at("ORDER SKIPPED - risk").status).toBe("Refused");
    expect(at("Outside trading hours").detail).toContain("Outside trading hours");
  });

  it("signals: queued, accepted, refused (recent), then back to waiting", () => {
    expect(by(stages(dash({ bot: bot({}, { outbox: { pending: 2, rejected: 0, late: 0 } }) })), "signals").status).toBe("Processing");
    expect(by(stages(dash({ recent: { ...dash().recent, alerts: [alertRow({ status: "rejected", response_code: "RISK_REJECTED" })] } })), "signals").status).toBe("Refused");
    expect(by(stages(dash({ recent: { ...dash().recent, alerts: [alertRow({})] } })), "signals").status).toBe("Setup found");
    const old = by(stages(dash({ recent: { ...dash().recent, alerts: [alertRow({ received_at: "2026-11-10T10:00:00Z" })] } })), "signals");
    expect(old.status).toBe("Waiting for candle");
    expect(old.detail).toMatch(/Last signal/);
  });

  it("risk: ledger refusal, accepted position, sizing skip, fixed risk", () => {
    const pos = (status: string, reason: string | null = null) => bot({}, { position: { side: "LONG", qty: 1, entry: 150, stop: 149, tp2: 155, unrealized_at_last_close: 0, ledger: { status, reason } } });
    expect(by(stages(dash({ bot: pos("NOT_IN_LEDGER", "insufficient PAPER balance") })), "risk")).toMatchObject({ status: "Refused" });
    expect(by(stages(dash({ bot: pos("NOT_IN_LEDGER", "insufficient PAPER balance") })), "risk").detail).toContain("insufficient PAPER balance");
    expect(by(stages(dash({ bot: pos("MIRRORED") })), "risk").status).toBe("Entry filled");
    expect(by(stages(dash()), "risk").detail).toContain("$10 fixed risk");
  });

  it("execution: open PAPER position, resting order, recent exit with the ledger P&L, mirror line labelled hypothetical", () => {
    const p = { id: 1, label: "ALPHA PAPER", symbol: "SOLUSD", side: "long", qty: 0.62, avg_entry_price: 150.1, multiplier: 1, cost_basis: 93, mark_price: null, mark_at: null, mark_source: null,
      mark_age_seconds: null, mark_status: "UNAVAILABLE", mark_error: null, market_value: null, unrealized_pnl: null, unrealized_pct: null, realized_pnl: 0, strategy: null, opened_at: "", open_alert_id: "", open_order_id: "" };
    const withPos = dash({ paper: { ...dash().paper!, positions: [p] } });
    const mirror = { label: "", disclosure: "", note: "", markets: [market({ open_position: { trade_id: "t", side: "SHORT", qty: 1, entry_time: null, entry_price: 3100, initial_stop: null, current_stop: null, tp2: null, notional_usd: null, unrealized_at_last_close: null, classification: "live" } })] };
    const e = by(stages(withPos, mirror), "execution");
    expect(e.status).toBe("Entry filled");
    expect(e.detail).toContain("ALPHA PAPER · SOLUSD LONG 0.62 @ 150.10.");
    expect(e.sub).toBe("Strategy Mirror (hypothetical) · ETHUSD SHORT open");
    expect(by(stages(dash({ bot: bot({}, { status_text: "ORDER PLACED - waiting fill" }) })), "execution").status).toBe("Order pending");
    const tr = { id: 3, symbol: "SOLUSD", direction: "long", status: "closed", strategy: null, entry_qty: "1", entry_avg_price: "150", exit_qty: "1", exit_avg_price: "152.45",
      open_qty: "0", realized_pnl: "2.45", return_pct: null, opened_at: "2026-11-10T13:00:00Z", closed_at: "2026-11-10T13:50:00Z" } as TradeRow;
    const ex = by(stages(dash({ recent: { ...dash().recent, trades: [tr] } })), "execution");
    expect(ex.status).toBe("Exit recorded");
    expect(ex.detail).toContain("+$2.45 PAPER P&L");
  });

  it("never invents numbers: no percentages, no progress, no totals of its own", () => {
    for (const x of stages(dash())) expect(`${x.detail} ${x.sub ?? ""}`).not.toMatch(/%|progress|scann(ed|ing) \d/i);
    expect(mirrorSummary(null)).toBeNull();
  });

  it("renders the panel with accessible labels; reduced motion handled in CSS", () => {
    const out = html(<PipelinePanel state={ok(dash({ bot: bot({}, { status_text: "ORDER PLACED - waiting fill" }) }))} mirror={null} />);
    expect(out).toContain('aria-label="Pipeline"');
    expect(out).toContain('aria-label="Strategy: Order pending"');
    expect(out).toContain("is-active");
    const css = text("./home.css");
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*pl-stage\.is-active \.pl-dot::after \{ animation: none/);
  });
});

describe("activity feed", () => {
  const item = (id: string, at: string, source: ActivityItem["source"] = "funded"): ActivityItem => ({ id, at, source, symbol: "SOLUSD", title: id, outcome: "", tone: "ok", url: null });
  it("merges newest first, without duplicates, capped", () => {
    const out = mergeActivity([item("a", "2026-11-10T10:00:00Z"), item("b", "2026-11-10T11:00:00Z"), item("a", "2026-11-10T10:00:00Z")], [item("d", "2026-11-10T10:30:00Z", "device")], 3);
    expect(out.map((x) => x.id)).toEqual(["b", "d", "a"]);
    expect(mergeActivity(Array.from({ length: 80 }, (_, i) => item(`x${i}`, `2026-11-10T10:${String(i % 60).padStart(2, "0")}:00Z`))).length).toBe(30);
  });
  it("connection changes are labelled as seen by this device", () => {
    expect(deviceItem("back", "2026-11-10T10:00:00Z")).toMatchObject({ source: "device", title: "Worker reconnected" });
    expect(SOURCE_LABEL.device).toBe("THIS DEVICE");
    expect(SOURCE_LABEL.mirror).toBe("STRATEGY MIRROR");
  });
  it("renders empty, error and populated states truthfully", () => {
    expect(html(<ActivityPanel activity={{ items: [], error: null, mirror: null, at: 1 }} />)).toContain("No recorded activity yet");
    expect(html(<ActivityPanel activity={{ items: null, error: "OFFLINE", mirror: null, at: null }} />)).toContain("Activity unavailable");
    const out = html(<ActivityPanel activity={{ items: [{ ...item("m", "2026-11-10T10:00:00Z", "mirror"), url: "/mirror", classification: "catch_up" }], error: null, mirror: null, at: 1 }} />);
    expect(out).toContain("STRATEGY MIRROR");
    expect(out).toContain("catch-up");
    expect(out).toContain('href="/mirror"');
  });
});

describe("notifications on this device", () => {
  const base: EnvProbe = { ua: "", maxTouchPoints: 0, standalone: false, secure: true, hasSW: true, hasPush: true, hasNotification: true };
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
  it("iPhone in a Safari tab: must be added to the Home Screen; installed app: supported", () => {
    expect(support({ ...base, ua: IPHONE, hasPush: false })).toEqual({ ok: false, why: "needs-home-screen" });
    expect(support({ ...base, ua: IPHONE })).toEqual({ ok: false, why: "needs-home-screen" });
    expect(support({ ...base, ua: IPHONE, standalone: true })).toEqual({ ok: true });
    expect(isIOS({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari", maxTouchPoints: 5 })).toBe(true); // iPad
    expect(support({ ...base, ua: "Chrome desktop" })).toEqual({ ok: true });
    expect(support({ ...base, hasPush: false })).toEqual({ ok: false, why: "unsupported" });
    expect(support({ ...base, secure: false })).toEqual({ ok: false, why: "insecure" });
  });
  it("decodes the VAPID public key", () => {
    const b = urlB64ToBytes("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    expect(b.length).toBe(65);
    expect(b[0]).toBe(4);
  });
  it("renders a neutral checking state first (no claim about delivery)", () => {
    const out = html(<NotificationSettings />);
    expect(out).toContain("Checking this device");
    expect(out).toMatch(/Delivery depends on this device/);
  });
});

describe("theme", () => {
  it("System follows the device; explicit choices win", () => {
    expect(THEME_PREFS).toEqual(["light", "dark", "system"]);
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("index.html applies the stored theme before first paint", () => {
    const idx = text("../../index.html");
    const head = idx.slice(0, idx.indexOf("</head>"));
    expect(head).toMatch(/localStorage\.getItem\("at-theme"\)/);
    expect(head.indexOf("at-theme")).toBeLessThan(head.indexOf('type="module"') === -1 ? Infinity : head.indexOf('type="module"'));
    expect(head).toMatch(/name="theme-color"[^>]*prefers-color-scheme: light|prefers-color-scheme: light[^>]*name="theme-color"/);
  });
  it("dark tokens exist for every light-only token", () => {
    const css = text("./theme.css");
    const light = css.slice(0, css.indexOf('[data-theme="dark"]'));
    const dark = css.slice(css.indexOf('[data-theme="dark"]'));
    for (const t of Array.from(light.matchAll(/(--[a-z0-9-]+):/g), (m: RegExpMatchArray) => m[1])) expect(dark, t).toContain(`${t}:`);
  });
});

describe("icons, manifest and service worker", () => {
  const png = (f: string) => {
    const b = fs.readFileSync(at(`../../public/${f}`)); // bytes
    const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    expect([b[1], b[2], b[3]]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    return { w: u32(16), h: u32(20) };
  };
  it("every icon asset exists at its declared size", () => {
    expect(png("apple-touch-icon.png")).toEqual({ w: 180, h: 180 });
    expect(png("icon-192.png")).toEqual({ w: 192, h: 192 });
    expect(png("icon-512.png")).toEqual({ w: 512, h: 512 });
    expect(png("icon-maskable-512.png")).toEqual({ w: 512, h: 512 });
    expect(png("favicon-32.png")).toEqual({ w: 32, h: 32 });
    expect(exists("favicon.ico")).toBe(true);
    const svg = text("../../public/icon.svg");
    expect(svg).toMatch(/#15130F/i);
    expect(svg).toMatch(/#F2661B/i);
    expect(svg).not.toMatch(/>A</);
  });
  it("manifest: stable id, standalone, theme colours, any + maskable icons", () => {
    const m = JSON.parse(text("../../public/manifest.webmanifest"));
    expect(m.id).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toMatch(/^#/);
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
    for (const i of m.icons) expect(exists(i.src.replace(/^\//, "")), i.src).toBe(true);
  });
  it("service worker: push and notificationclick only; no fetch handler and no cache reads", () => {
    const sw = text("../../public/sw.js");
    const code = sw.replace(/\/\/.*$/gm, "");
    expect(code).toMatch(/addEventListener\("push"/);
    expect(code).toMatch(/addEventListener\("notificationclick"/);
    expect(code).not.toMatch(/addEventListener\("fetch"/);
    expect(code).not.toMatch(/respondWith|caches\.match|caches\.open|cache\.put/);
    // only same-origin paths are opened
    expect(sw).toContain('u.startsWith("/") && !u.startsWith("//")');
  });
  it("_headers: the manifest, sw.js and apple-touch icons are never served stale", () => {
    const h = text("../../public/_headers");
    for (const p of ["/manifest.webmanifest", "/sw.js", "/apple-touch-icon.png"]) expect(h).toMatch(new RegExp(`${p.replace(/\./g, "\\.")}\\s+Cache-Control: no-cache`));
  });
  it("the app does not register a service worker at start-up", () => {
    const main = text("../main.tsx").replace(/\/\/.*$/gm, "");
    expect(main).not.toMatch(/serviceWorker\.register/);
  });
});

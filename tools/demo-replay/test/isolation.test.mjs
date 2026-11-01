// Proves the DEMO_UI_REPLAY harness stays isolated and can never reach production.
//
//   node --test tools/demo-replay/test/
//
// 1. Static: the demo server binds to 127.0.0.1, has no outbound/network/DB code.
// 2. Runtime: run the server in-process with fetch/http/https trapped; walk every step.
// 3. Frontend: production builds (with and without VITE_DEMO_UI=1) contain no demo code.
// 4. Worker: source and the deploy bundle contain no demo route or marker.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, "..");
const ROOT = join(DEMO, "..", "..");
const FRONTEND = join(ROOT, "frontend");
const WORKER = join(ROOT, "worker");
const WIN = process.platform === "win32";

// Markers that must never appear in anything shipped to production.
const MARKERS = ["DEMO_UI_REPLAY", "SIM_TEST", "START DEMO", "RESET DEMO", "FULL REPLAY", "WINNING TRADE", "LOSING TRADE",
  "SIMULATED DEMO PRICE", "__demo", "DemoOverlay", "demo-bar"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function scan(dir) {
  const hits = [];
  for (const f of walk(dir)) {
    const text = readFileSync(f).toString("utf8");
    for (const m of MARKERS) if (text.includes(m)) hits.push(`${m} in ${f}`);
  }
  return hits;
}

function npx(args, cwd, env = {}) {
  return execFileSync(WIN ? "npx.cmd" : "npx", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, env: { ...process.env, ...env },
  });
}

// ---------------------------------------------------------------- 1. static

describe("demo server source", () => {
  const src = readFileSync(join(DEMO, "server.mjs"), "utf8");

  it("binds only to 127.0.0.1", () => {
    assert.match(src, /export const HOST = "127\.0\.0\.1";/);
    assert.match(src, /server\.listen\(PORT, HOST,/);
    assert.ok(!/0\.0\.0\.0|"::"|listen\(PORT\)/.test(src), "no wildcard bind");
  });

  it("has no outbound network, database or broker code", () => {
    for (const bad of [/\bfetch\(/, /http\.request|https\.request|http\.get\(|https\.get\(/, /node:https/, /node:net|node:dgram|node:tls/,
      /D1Database|wrangler|sqlite|better-sqlite/i, /alpaca\.markets/, /workers\.dev/, /process\.env\.(ALPACA|ADMIN|WEBHOOK|DASHBOARD)/]) {
      assert.ok(!bad.test(src), `server.mjs must not contain ${bad}`);
    }
  });
});

// ---------------------------------------------------------------- 2. runtime

describe("demo server at runtime", () => {
  const calls = [];
  const orig = { fetch: globalThis.fetch, httpRequest: http.request, httpsRequest: https.request };
  let mod;
  let port;

  before(async () => {
    // Trap every way the server could reach the network. The test's own requests go to
    // 127.0.0.1 through the original http.request and are not recorded.
    globalThis.fetch = (...a) => { calls.push(["fetch", String(a[0])]); throw new Error("outbound fetch blocked"); };
    https.request = (...a) => { calls.push(["https", String(a[0]?.host ?? a[0])]); throw new Error("https blocked"); };
    http.request = (...a) => { calls.push(["http", String(a[0]?.host ?? a[0]?.hostname ?? a[0])]); return orig.httpRequest(...a); };
    process.env.DEMO_PORT = "0";
    mod = await import(pathToFileURL(join(DEMO, "server.mjs")).href);
    if (!mod.server.listening) await new Promise((r) => mod.server.once("listening", r));
    port = mod.server.address().port;
  });

  after(() => {
    mod?.server.close();
    globalThis.fetch = orig.fetch;
    http.request = orig.httpRequest;
    https.request = orig.httpsRequest;
  });

  const get = (path, method = "GET") => new Promise((resolve, reject) => {
    const req = orig.httpRequest({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end();
  });

  it("listens on loopback only", () => {
    assert.equal(mod.server.address().address, "127.0.0.1");
  });

  it("serves only demo routes; the dashboard payload is PAPER, dry-run and marked", async () => {
    const r = await get("/api/dashboard");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.demo, "DEMO_UI_REPLAY");
    assert.equal(r.json.data.mode, "PAPER");
    assert.equal(r.json.data.enable_trading, false);
    assert.equal(r.json.data.broker_submission, false);
    assert.equal((await get("/webhook", "POST")).status, 404);
    assert.equal((await get("/engine/start", "POST")).status, 404);
  });

  it("marks every simulated record across the whole replay", () => {
    for (let s = 0; s < mod.STEPS.length; s++) {
      const d = mod.snapshot(s);
      assert.equal(d.enable_trading, false);
      for (const a of d.recent.alerts) {
        assert.ok(a.alert_id.startsWith("DEMO_UI_REPLAY-"), a.alert_id);
        assert.equal(a.strategy, "DEMO_UI_REPLAY");
      }
      for (const o of d.recent.orders) {
        assert.equal(o.broker_request_sent, false);
        assert.equal(o.alpaca_order_id, null);
        assert.ok(o.client_order_id.startsWith("DEMO_UI_REPLAY-"));
      }
      for (const r of d.recent.risk) assert.match(r.reason, /SIM_TEST/);
      for (const t of d.recent.trades) assert.match(t.strategy, /DEMO PAPER TRADE · SIMULATED FOR UI TESTING · DEMO_UI_REPLAY/);
      for (const e of d.recent.activity) {
        assert.ok(e.message.startsWith("[SIM_TEST] "), e.message);
        if (e.category === "price" || /fill/i.test(e.message)) assert.match(e.message, /SIMULATED DEMO PRICE/);
      }
    }
  });

  it("produces the documented P&L path", () => {
    const upl = (s) => mod.snapshot(s).broker.positions[0]?.unrealized_pl;
    assert.deepEqual([5, 6, 7, 8, 9].map(upl), [0, 4.2, 8.75, 13.4, 18.6]);
    assert.deepEqual([16, 17, 18, 19].map(upl), [-2.1, -5.3, -8.4, -12.7]);
    assert.equal(mod.snapshot(20).broker.account.equity, 25005.9);
  });

  it("made no outbound network calls", () => {
    const outbound = calls.filter(([kind, host]) => kind !== "http" || !/^127\.0\.0\.1(:\d+)?$/.test(host));
    assert.deepEqual(outbound, []);
  });
});

// ---------------------------------------------------------------- 3. frontend production build

describe("production frontend build", () => {
  for (const [label, env] of [["normal", {}], ["with VITE_DEMO_UI=1", { VITE_DEMO_UI: "1" }]]) {
    it(`contains no demo code (${label})`, () => {
      const out = mkdtempSync(join(tmpdir(), "alpha-demo-scan-"));
      try {
        npx(["vite", "build", "--outDir", out, "--emptyOutDir"], FRONTEND, { NODE_ENV: "production", ...env });
        assert.ok(existsSync(join(out, "index.html")), "build produced index.html");
        assert.deepEqual(scan(out), []);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  }

  it("only loads the overlay in a dev server, on localhost", () => {
    const shell = readFileSync(join(FRONTEND, "src", "terminal", "AppShell.tsx"), "utf8");
    assert.match(shell, /const DemoOverlay = import\.meta\.env\.DEV && import\.meta\.env\.VITE_DEMO_UI === "1" \? lazy\(\(\) => import\("\.\/demo\/DemoOverlay"\)\) : null;/);
    assert.match(shell, /\{DemoOverlay && demoHost \?/);
    const imports = walk(join(FRONTEND, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(`${join("terminal", "demo")}`))
      .filter((f) => readFileSync(f, "utf8").includes("demo/DemoOverlay"));
    assert.deepEqual(imports.map((f) => f.split(/[\\/]/).pop()), ["AppShell.tsx"], "demo module is imported only behind the DEV guard");
  });
});

// ---------------------------------------------------------------- 4. worker

describe("deployed Worker", () => {
  it("has no demo route or marker in its source", () => {
    assert.deepEqual(scan(join(WORKER, "src")), []);
  });

  it("deploy bundle (dry run) has no demo route, and ENABLE_TRADING is false", () => {
    const out = mkdtempSync(join(tmpdir(), "alpha-worker-scan-"));
    try {
      const log = npx(["wrangler", "deploy", "--dry-run", "--outdir", out], WORKER);
      assert.match(log, /env\.ENABLE_TRADING \("false"\)/);
      assert.deepEqual(scan(out), []);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("has no broker order submission path", () => {
    for (const f of walk(join(WORKER, "src"))) {
      const text = readFileSync(f, "utf8");
      assert.ok(!/\/v2\/orders/.test(text), `${f} references /v2/orders`);
      assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(text), `${f} makes a non-GET fetch`);
    }
  });
});

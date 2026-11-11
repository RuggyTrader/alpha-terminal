// Worker auth + safety integration tests.
//
// Runs the real Worker with `wrangler dev --local` against a throwaway D1
// database in a temp directory. Secrets are random values generated here for
// this run only (never printed). Requires the frontend build to exist:
//   npm --prefix ../frontend run build && npm test

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(WORKER_DIR, "..", "frontend", "dist");
const WIN = process.platform === "win32";

const secret = () => randomBytes(24).toString("base64url");
const DASHBOARD_PASSPHRASE = secret();
const ADMIN_SECRET = secret();
const WEBHOOK_SECRET = secret();
assert.notEqual(DASHBOARD_PASSPHRASE, ADMIN_SECRET);

const persist = mkdtempSync(join(tmpdir(), "alpha-worker-test-"));
const persistNoPass = mkdtempSync(join(tmpdir(), "alpha-worker-test-nopass-"));

function wrangler(args, opts = {}) {
  return execFileSync(WIN ? "npx.cmd" : "npx", ["wrangler", ...args], {
    cwd: WORKER_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: WIN,
    ...opts,
  });
}

function startWorker(port, inspectorPort, dir, vars) {
  const args = ["wrangler", "dev", "--local", "--port", String(port), "--inspector-port", String(inspectorPort),
    "--ip", "127.0.0.1", "--persist-to", dir];
  // Blank the broker keys so these tests never depend on (or call) a real Alpaca account,
  // even when worker/.dev.vars holds PAPER keys.
  for (const [k, v] of Object.entries({ ALPACA_KEY: "", ALPACA_SECRET: "", PAPER_COST_PROFILE: "none", ...vars })) args.push("--var", `${k}:${v}`);
  const child = spawn(WIN ? "npx.cmd" : "npx", args, { cwd: WORKER_DIR, stdio: "ignore", shell: WIN, detached: !WIN });
  return child;
}

function stopWorker(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (WIN) execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

async function waitFor(base, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Worker at ${base} did not start`);
}

const H = { "X-Alpha-Terminal": "1", "Content-Type": "application/json" };

function d1(sql) {
  // shell:true on Windows joins args with spaces, so quote the SQL there.
  const out = wrangler(["d1", "execute", "alpha-terminal-db", "--local", "--persist-to", persist, "--json",
    "--command", WIN ? `"${sql}"` : sql]);
  return JSON.parse(out)[0].results;
}

/** SHA-256 hex of the cookie token: the value the Worker stores in auth_sessions. */
const tokenHash = (cookie) => createHash("sha256").update(cookie.split("=")[1]).digest("hex");

function sessionCount() {
  const sql = "SELECT COUNT(*) AS n FROM auth_sessions";
  // shell:true on Windows joins args with spaces, so quote the SQL there.
  const out = wrangler(["d1", "execute", "alpha-terminal-db", "--local", "--persist-to", persist, "--json",
    "--command", WIN ? `"${sql}"` : sql]);
  return JSON.parse(out)[0].results[0].n;
}

async function login(base, passphrase, extra = {}) {
  const r = await fetch(`${base}/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ passphrase, ...extra }) });
  const body = await r.json();
  const setCookie = r.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("at_session=")) ?? null;
  return { status: r.status, body, setCookie, cookie };
}

const BASE = "http://127.0.0.1:8790";
const BASE_NO_PASS = "http://127.0.0.1:8791";
let main;
let noPass;

before(async () => {
  assert.ok(existsSync(join(DIST, "index.html")), "frontend/dist missing: run `npm --prefix ../frontend run build` first");
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persist]);
  wrangler(["d1", "migrations", "apply", "alpha-terminal-db", "--local", "--persist-to", persistNoPass]);
  main = startWorker(8790, 9390, persist, { DASHBOARD_PASSPHRASE, ADMIN_SECRET, WEBHOOK_SECRET, DASHBOARD_ORIGINS: "http://localhost:5173" });
  // Same admin secret, but no dashboard passphrase configured.
  noPass = startWorker(8791, 9391, persistNoPass, { DASHBOARD_PASSPHRASE: "", ADMIN_SECRET, WEBHOOK_SECRET, DASHBOARD_ORIGINS: "http://localhost:5173" });
  await Promise.all([waitFor(BASE), waitFor(BASE_NO_PASS)]);
});

after(() => {
  stopWorker(main);
  stopWorker(noPass);
  try {
    rmSync(persist, { recursive: true, force: true });
    rmSync(persistNoPass, { recursive: true, force: true });
  } catch {
    /* temp dir may still be locked on Windows */
  }
});

describe("dashboard login uses DASHBOARD_PASSPHRASE only", () => {
  it("correct DASHBOARD_PASSPHRASE logs in with a hardened cookie", async () => {
    const r = await login(BASE, DASHBOARD_PASSPHRASE);
    assert.equal(r.status, 200);
    assert.equal(r.body.read_only, true);
    assert.ok(r.cookie, "session cookie set");
    const c = r.setCookie.find((x) => x.startsWith("at_session="));
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(c.includes(flag), `cookie has ${flag}`);
    assert.ok(!/Domain=/i.test(c), "cookie is host-only");
  });

  it("wrong dashboard passphrase fails", async () => {
    const r = await login(BASE, "definitely-wrong");
    assert.equal(r.status, 401);
    assert.equal(r.body.code, "INVALID_PASSPHRASE");
    assert.equal(r.cookie, null);
  });

  it("ADMIN_SECRET does not log in to /auth/login", async () => {
    const r = await login(BASE, ADMIN_SECRET);
    assert.equal(r.status, 401);
    assert.equal(r.cookie, null);
  });

  it("missing DASHBOARD_PASSPHRASE returns AUTH_NOT_CONFIGURED, even for ADMIN_SECRET", async () => {
    for (const p of [ADMIN_SECRET, "", "anything"]) {
      const r = await login(BASE_NO_PASS, p);
      assert.equal(r.status, 503);
      assert.equal(r.body.code, "AUTH_NOT_CONFIGURED");
      assert.equal(r.cookie, null);
    }
  });

  it("login requires the CSRF header", async () => {
    const r = await fetch(`${BASE}/auth/login`, { method: "POST", body: JSON.stringify({ passphrase: DASHBOARD_PASSPHRASE }) });
    assert.equal(r.status, 403);
  });
});

describe("dashboard session is read-only", () => {
  let cookie;
  before(async () => {
    cookie = (await login(BASE, DASHBOARD_PASSPHRASE)).cookie;
    assert.ok(cookie);
  });

  it("can GET /api/dashboard", async () => {
    const r = await fetch(`${BASE}/api/dashboard?limit=5`, { headers: { cookie } });
    assert.equal(r.status, 200);
    const { data } = await r.json();
    assert.equal(data.mode, "PAPER");
    assert.equal(data.execution, "DRY_RUN_ONLY");
    assert.equal(data.broker_submission, false);
    assert.equal(data.enable_trading, false);
  });

  it("cannot POST /api/dashboard", async () => {
    const r = await fetch(`${BASE}/api/dashboard`, { method: "POST", headers: { ...H, cookie } });
    assert.equal(r.status, 405);
  });

  for (const path of ["/engine/start", "/engine/pause", "/engine/resume", "/engine/stop", "/kill", "/kill/reset"]) {
    it(`cannot POST ${path}`, async () => {
      const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { ...H, cookie } });
      assert.equal(r.status, 401);
    });
  }

  for (const path of ["/api/broker/account", "/api/broker/positions", "/api/broker/clock", "/api/broker/price/SPY"]) {
    it(`cannot GET ${path}`, async () => {
      const r = await fetch(`${BASE}${path}`, { headers: { cookie } });
      assert.equal(r.status, 401);
    });
  }

  for (const path of ["/api/risk/preview", "/api/dry-run/order", "/api/dry-run/unknown", "/api/dry-run/reconcile"]) {
    it(`cannot POST ${path}`, async () => {
      const r = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { ...H, cookie },
        body: JSON.stringify({ symbol: "SPY", action: "buy", qty: 1, id: "session-probe" }),
      });
      assert.equal(r.status, 401);
    });
  }

  for (const path of ["/webhook", "/webhook/dry-run"]) {
    it(`cannot use ${path} without WEBHOOK_SECRET`, async () => {
      const r = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { ...H, cookie },
        body: JSON.stringify({ id: `session-probe-${path}`, symbol: "SPY", action: "buy", qty: 1 }),
      });
      assert.ok([400, 401, 403].includes(r.status), `rejected (${r.status})`);
      const body = await r.json();
      assert.notEqual(body.code, "DRY_RUN_ACCEPTED");
    });
  }

  it("engine is still STOPPED after all attempts", async () => {
    const h = await (await fetch(`${BASE}/health`)).json();
    assert.equal(h.engine.state, "STOPPED");
    assert.equal(h.engine.kill_switch, 0);
    assert.equal(h.enable_trading, false);
  });
});

describe("x-admin-secret behaviour is unchanged", () => {
  it("admin header reads the dashboard", async () => {
    const r = await fetch(`${BASE}/api/dashboard?limit=1`, { headers: { "x-admin-secret": ADMIN_SECRET } });
    assert.equal(r.status, 200);
  });

  it("admin header passes auth on admin routes (broker not configured, start refused by ENABLE_TRADING)", async () => {
    const b = await fetch(`${BASE}/api/broker/account`, { headers: { "x-admin-secret": ADMIN_SECRET } });
    assert.equal(b.status, 503);
    assert.equal((await b.json()).code, "BROKER_NOT_CONFIGURED");
    const s = await fetch(`${BASE}/engine/start`, { method: "POST", headers: { "x-admin-secret": ADMIN_SECRET } });
    assert.equal(s.status, 409);
    assert.equal((await s.json()).code, "EXECUTION_DISABLED");
  });

  it("DASHBOARD_PASSPHRASE is not accepted as x-admin-secret", async () => {
    for (const path of ["/api/dashboard", "/api/broker/account"]) {
      const r = await fetch(`${BASE}${path}`, { headers: { "x-admin-secret": DASHBOARD_PASSPHRASE } });
      assert.equal(r.status, 401);
    }
    const s = await fetch(`${BASE}/engine/start`, { method: "POST", headers: { "x-admin-secret": DASHBOARD_PASSPHRASE } });
    assert.equal(s.status, 401);
  });

  it("wrong admin header is rejected", async () => {
    const r = await fetch(`${BASE}/api/dashboard`, { headers: { "x-admin-secret": "wrong" } });
    assert.equal(r.status, 401);
  });
});

describe("logout", () => {
  it("invalidates the D1 session", async () => {
    const { cookie } = await login(BASE, DASHBOARD_PASSPHRASE);
    assert.equal((await fetch(`${BASE}/auth/session`, { headers: { cookie } })).status, 200);

    const out = await fetch(`${BASE}/auth/logout`, { method: "POST", headers: { ...H, cookie } });
    assert.equal(out.status, 200);
    const cleared = (out.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("at_session="));
    assert.ok(cleared && /Max-Age=0/.test(cleared), "cookie cleared");

    // Replaying the old cookie no longer works: the hash is gone from D1.
    assert.equal((await fetch(`${BASE}/auth/session`, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(`${BASE}/api/dashboard`, { headers: { cookie } })).status, 401);

    // Check D1 directly: logout removes exactly the session it was given.
    const before = sessionCount();
    assert.ok(before >= 1, "earlier test sessions still present");
    const { cookie: c2 } = await login(BASE, DASHBOARD_PASSPHRASE);
    assert.equal(sessionCount(), before + 1);
    await fetch(`${BASE}/auth/logout`, { method: "POST", headers: { ...H, cookie: c2 } });
    assert.equal(sessionCount(), before, "logout removed exactly the session it was given");
  });
});

// ---------------------------------------------------------------- static safety checks

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe("static safety", () => {
  it("frontend bundle contains no secret names or values", () => {
    const values = [DASHBOARD_PASSPHRASE, ADMIN_SECRET, WEBHOOK_SECRET];
    const devVars = join(WORKER_DIR, ".dev.vars");
    if (existsSync(devVars)) {
      for (const line of readFileSync(devVars, "utf8").split(/\r?\n/)) {
        const [k, ...v] = line.split("=");
        if (/SECRET|PASSPHRASE|KEY/.test(k) && v.join("=").trim()) values.push(v.join("=").trim());
      }
    }
    for (const file of walk(DIST)) {
      const text = readFileSync(file).toString("utf8");
      for (const name of ["ADMIN_SECRET", "DASHBOARD_PASSPHRASE", "WEBHOOK_SECRET", "ALPACA_SECRET", "x-admin-secret"]) {
        assert.ok(!text.includes(name), `${name} found in ${file}`);
      }
      for (const v of values) assert.ok(!text.includes(v), `a secret value was found in ${file}`);
    }
  });

  it("ENABLE_TRADING is false and no secret is a plaintext var", () => {
    const raw = readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8");
    const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
    assert.equal(cfg.vars.ENABLE_TRADING, "false");
    for (const k of ["ADMIN_SECRET", "DASHBOARD_PASSPHRASE", "WEBHOOK_SECRET", "ALPACA_KEY", "ALPACA_SECRET"]) {
      assert.ok(!(k in cfg.vars), `${k} must be a Cloudflare secret, not a var`);
    }
  });

  it("no Alpaca order submission path exists", () => {
    const src = walk(join(WORKER_DIR, "src")).filter((f) => f.endsWith(".ts"));
    for (const f of src) {
      const text = readFileSync(f, "utf8");
      assert.ok(!/\/v2\/orders/.test(text), `${f} references /v2/orders`);
      assert.ok(!/https:\/\/api\.alpaca\.markets|live-api\.alpaca/.test(text), `${f} references a live Alpaca host`);
      // The one exception: Web Push delivery (webpush.ts) POSTs to a push service, and only to an allowlisted one.
      if (f.endsWith("webpush.ts")) {
        assert.match(text, /if \(!allowedEndpoint\(sub\.endpoint\)\) return/, "push POSTs only to allowlisted push services");
        assert.ok(!/alpaca/i.test(text), "no broker host in push delivery");
        continue;
      }
      assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(text), `${f} makes a non-GET fetch`);
      const hosts = text.match(/https:\/\/[a-z.-]*alpaca\.markets/g) ?? [];
      for (const h of hosts) assert.ok(["https://paper-api.alpaca.markets", "https://data.alpaca.markets"].includes(h), `${f}: ${h}`);
    }
  });
});

// ---------------------------------------------------------------- remember this device

describe("remember this device", () => {
  const maxAge = (r) => Number(/Max-Age=(\d+)/.exec(r.setCookie.find((c) => c.startsWith("at_session=")))?.[1]);
  const expiresInHours = (cookie) => {
    const [row] = d1(`SELECT expires_at FROM auth_sessions WHERE token_hash = '${tokenHash(cookie)}'`);
    return (Date.parse(row.expires_at) - Date.now()) / 3600000;
  };

  it("unchecked keeps the 12-hour session", async () => {
    const r = await login(BASE, DASHBOARD_PASSPHRASE, { remember_device: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.remembered, false);
    assert.equal(maxAge(r), 12 * 3600);
    const h = expiresInHours(r.cookie);
    assert.ok(h > 11.9 && h <= 12, `expires in ${h} h`);
  });

  it("omitted or non-boolean values do not opt in", async () => {
    for (const extra of [{}, { remember_device: "true" }, { remember_device: 1 }]) {
      const r = await login(BASE, DASHBOARD_PASSPHRASE, extra);
      assert.equal(maxAge(r), 12 * 3600, JSON.stringify(extra));
    }
  });

  it("checked creates a 30-day session with the same hardened cookie", async () => {
    const r = await login(BASE, DASHBOARD_PASSPHRASE, { remember_device: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.remembered, true);
    assert.equal(r.body.read_only, true);
    assert.equal(maxAge(r), 30 * 24 * 3600);
    const days = expiresInHours(r.cookie) / 24;
    assert.ok(days > 29.9 && days <= 30, `expires in ${days} days`);
    const c = r.setCookie.find((x) => x.startsWith("at_session="));
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(c.includes(flag), flag);
  });

  it("does not remember a wrong passphrase or ADMIN_SECRET", async () => {
    for (const p of ["definitely-wrong", ADMIN_SECRET]) {
      const r = await login(BASE, p, { remember_device: true });
      assert.equal(r.status, 401);
      assert.equal(r.cookie, null);
    }
  });

  it("a remembered session is still read-only", async () => {
    const { cookie } = await login(BASE, DASHBOARD_PASSPHRASE, { remember_device: true });
    assert.equal((await fetch(`${BASE}/api/dashboard?limit=1`, { headers: { cookie } })).status, 200);
    for (const path of ["/engine/start", "/engine/stop", "/kill", "/kill/reset", "/api/risk/preview", "/api/dry-run/order", "/api/dry-run/reconcile"]) {
      const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { ...H, cookie }, body: "{}" });
      assert.equal(r.status, 401, path);
    }
    for (const path of ["/api/broker/account", "/api/broker/positions", "/api/broker/price/SPY"]) {
      assert.equal((await fetch(`${BASE}${path}`, { headers: { cookie } })).status, 401, path);
    }
    for (const path of ["/webhook", "/webhook/dry-run"]) {
      const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ id: `remember-probe-${path}`, symbol: "SPY", action: "buy", qty: 1 }) });
      assert.ok([400, 401, 403].includes(r.status), `${path} ${r.status}`);
    }
  });

  it("logout invalidates a remembered session", async () => {
    const { cookie } = await login(BASE, DASHBOARD_PASSPHRASE, { remember_device: true });
    const out = await fetch(`${BASE}/auth/logout`, { method: "POST", headers: { ...H, cookie } });
    assert.equal(out.status, 200);
    assert.equal(d1(`SELECT COUNT(*) AS n FROM auth_sessions WHERE token_hash = '${tokenHash(cookie)}'`)[0].n, 0);
    assert.equal((await fetch(`${BASE}/api/dashboard`, { headers: { cookie } })).status, 401);
  });

  it("an expired remembered session is rejected", async () => {
    const { cookie } = await login(BASE, DASHBOARD_PASSPHRASE, { remember_device: true });
    assert.equal((await fetch(`${BASE}/auth/session`, { headers: { cookie } })).status, 200);
    d1(`UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = '${tokenHash(cookie)}'`);
    assert.equal((await fetch(`${BASE}/auth/session`, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(`${BASE}/api/dashboard`, { headers: { cookie } })).status, 401);
  });
});

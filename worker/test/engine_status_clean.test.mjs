// The engine heartbeat is cleaned before storage: only known fields survive. The engine's own entry pause
// (ENGINE_PAUSED_BOTS) is kept so the dashboard can show a paused bot; nothing else from the engine leaks through.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = createRequire(import.meta.url)(join(ROOT, "node_modules", "esbuild"));
const work = mkdtempSync(join(tmpdir(), "alpha-clean-")); after(() => rmSync(work, { recursive: true, force: true }));
let M;
before(async () => {
  const out = join(work, "es.mjs");
  await esbuild.build({ stdin: { contents: `export { clean } from "./src/engine_status";`, resolveDir: ROOT, loader: "ts" }, bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
  M = await import(pathToFileURL(out).href);
});
describe("engine heartbeat cleaning", () => {
  const base = { engine: "alpha-engine", symbol: "SOLUSD", timeframe: "1m", bot_id: "ALPHA-01" };
  it("keeps the engine's entries_paused flag only when it is exactly true", () => {
    assert.equal(M.clean({ ...base, ledger_check: { status: "OK", issues: [], entries_paused: true } }).ledger_check.entries_paused, true);
    assert.equal(M.clean({ ...base, ledger_check: { status: "OK", issues: [] } }).ledger_check.entries_paused, undefined);
    assert.equal(M.clean({ ...base, ledger_check: { status: "OK", issues: [], entries_paused: "yes" } }).ledger_check.entries_paused, undefined);
  });
  it("still drops unknown fields and invalid statuses", () => {
    const c = M.clean({ ...base, ledger_check: { status: "OK", issues: [], secret: "x", blocking: true } });
    assert.deepEqual(Object.keys(c.ledger_check).sort(), ["at", "issues", "status"]);
    assert.equal(M.clean({ ...base, ledger_check: { status: "WEIRD" } }).ledger_check, null);
  });
});

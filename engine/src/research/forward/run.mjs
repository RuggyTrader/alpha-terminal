#!/usr/bin/env node
// RESEARCH forward shadow CLI (no keys, no orders, no ledger, no Worker):
//   node src/research/forward/run.mjs collect  [--state data/forward] [--registry ../docs/research/forward/registry.json]
//   node src/research/forward/run.mjs evaluate [--state data/forward] [--out ../docs/research/forward/report.json]
//   node src/research/forward/run.mjs verify   [--state data/forward]      (checks the audit hash chain)
// Safe to run at any time and any number of times: collection only appends completed candles, evaluation is a
// deterministic replay. A missed day is caught up on the next run.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { collectMarket } from "./collect.mjs";
import { parseAssetPairs } from "../r8/kraken-minimums.mjs";
import { existsSync, readdirSync } from "node:fs";
import { evaluateForward } from "./shadow.mjs";
import { audit, verifyAudit } from "./store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const cmd = process.argv[2], state = arg("state", join(here, "../../../data/forward"));
const regFile = arg("registry", join(here, "../../../../docs/research/forward/registry.json"));
const registry = JSON.parse(readFileSync(regFile, "utf8"));
mkdirSync(state, { recursive: true });

/** Refuses to run against anything that looks like production state (defence in depth; it never reads them). */
for (const bad of ["engine-prod", "engine.env", "AlphaTerminal"]) if (state.includes(bad)) throw new Error(`refusing research state path ${state}`);

if (cmd === "collect") {
  const markets = [...new Set(registry.candidates.flatMap((c) => c.basket))].sort();
  try { // Kraken order minimums snapshot (public); one file per UTC day, never overwritten
    const day = new Date().toISOString().slice(0, 10), f = join(state, "minimums", `${day}.json`);
    if (!existsSync(f)) {
      const res = await fetch("https://api.kraken.com/0/public/AssetPairs", { headers: { "User-Agent": "research-client/1.0" } }), j = await res.json();
      if (!res.ok || j.error?.length) throw new Error(`Kraken ${res.status} ${j.error}`);
      mkdirSync(join(state, "minimums"), { recursive: true });
      writeFileSync(f, JSON.stringify({ fetched_at: new Date().toISOString(), source: "Kraken public AssetPairs", markets: parseAssetPairs(j.result) }));
      audit(state, { kind: "MINIMUMS", file: `minimums/${day}.json` });
    }
  } catch (e) { audit(state, { kind: "MINIMUMS_FAILED", error: String(e.message).slice(0, 200) }); console.error(`minimums: FAILED ${e.message}`); }
  const warm = registry.warmup_from;
  for (const m of markets) for (const g of [3600, 86400]) {
    try { const r = await collectMarket(state, m, g, { warmupFrom: warm[g] }); audit(state, { kind: "COLLECT", market: m, granularity: g, ...r }); console.error(`${m} ${g}: +${r.added} (revised ${r.revised})`); }
    catch (e) { audit(state, { kind: "COLLECT_FAILED", market: m, granularity: g, error: String(e.message).slice(0, 200) }); console.error(`${m} ${g}: FAILED ${e.message}`); }
  }
} else if (cmd === "evaluate") {
  let rev = null; try { rev = execSync("git rev-parse --short HEAD", { encoding: "utf8", cwd: here }).trim(); } catch { /* not a checkout */ }
  const mdir = join(state, "minimums"), snaps = existsSync(mdir) ? readdirSync(mdir).filter((f) => f.endsWith(".json")).sort() : [];
  const latest = snaps.length ? JSON.parse(readFileSync(join(mdir, snaps.at(-1)), "utf8")) : { markets: {}, fetched_at: null };
  const reports = registry.candidates.map((reg) => evaluateForward(state, { ...reg, minimums: latest.markets, minimums_fetched_at: latest.fetched_at }));
  const out = { label: "RESEARCH FORWARD SHADOW REPORT (hypothetical; never funded PAPER)", code_version: rev, registry: regFile.split("/").slice(-3).join("/"), generated_at: new Date().toISOString(), reports };
  audit(state, { kind: "EVALUATE", code_version: rev, summary: reports.map((r) => ({ id: r.id, net: r.selected_costs.net_marked, trades: r.selected_costs.trades_closed, days: r.forward_days })) });
  writeFileSync(arg("out", join(state, "report.json")), JSON.stringify(out, null, 1));
  for (const r of reports) console.error(`${r.id}: ${r.status} | days ${r.forward_days} | net ${r.selected_costs.net_marked} (${r.selected_costs.trades_closed} closed, ${r.open_positions.length} open)`);
} else if (cmd === "verify") {
  console.log(JSON.stringify(verifyAudit(state)));
} else {
  console.error("usage: run.mjs collect|evaluate|verify [--state dir] [--registry file] [--out file]"); process.exit(2);
}

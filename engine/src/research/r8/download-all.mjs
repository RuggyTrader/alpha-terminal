#!/usr/bin/env node
// Downloads every round-8 dataset (1h and daily) with the existing provenance-recording downloader. Skips files that
// already exist (never overwrites saved data). Public Coinbase endpoints only; no key.
//   node src/research/r8/download-all.mjs --dir data/research8 [--set untouched|examined|all]
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EXAMINED, UNTOUCHED, PERIOD } from "./markets.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const dir = arg("dir", "data/research8"), set = arg("set", "all");
const markets = set === "untouched" ? UNTOUCHED : set === "examined" ? EXAMINED : [...UNTOUCHED, ...EXAMINED];
mkdirSync(dir, { recursive: true });
const dl = join(dirname(fileURLToPath(import.meta.url)), "..", "download.mjs");
for (const m of markets) for (const g of [3600, 86400]) {
  const out = join(dir, `${m}-USD-${g}.json`);
  if (existsSync(out)) { console.error(`keep ${out}`); continue; }
  try { execFileSync(process.execPath, [dl, "--product", `${m}-USD`, "--granularity", String(g), "--from", PERIOD.dataFrom, "--to", PERIOD.to, "--out", out], { stdio: ["ignore", "inherit", "inherit"] }); }
  catch (e) { console.error(`FAILED ${m} ${g}: ${e.message.split("\n")[0]} (recorded; the eligibility screen will exclude it)`); }
}

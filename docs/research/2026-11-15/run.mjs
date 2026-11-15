// Research queue: every candidate under the production execution model (exec-eval.mjs), 3 at a time.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ENGINE = "C:/Users/hujhj/AppData/Local/Temp/claude/76fbb51ecb31bce8/4752cd24-e3f0-4842-890e-33de4c4a6630/scratchpad/final-wt/engine";
const DATA = "C:/Users/hujhj/Documents/Codex/2026-10-18/ok-should-i-make-a-completly/outputs/alpha-terminal/engine/data";
const OUT = "C:/Users/hujhj/AppData/Local/Temp/claude/76fbb51ecb31bce8/4752cd24-e3f0-4842-890e-33de4c4a6630/scratchpad/research2/out";
mkdirSync(OUT, { recursive: true });
const SOL1 = `${DATA}/SOLUSD-1m-2026-08-01_2026-10-29.json,${DATA}/SOLUSD-1m-2026-10-29_2026-11-12.json`;
const BTC1 = `${DATA}/BTCUSD-1m-2026-08-01_2026-11-12.json`;
const FEES = "0,0.2,0.4";
const ALL = "ALPHA-01,ALPHA-02,ALPHA-03,ALPHA-04", FIVE = "ALPHA-02,ALPHA-04";
const C = { researchCostPct: 0.2 };
const jobs = [
  ["base", ALL, 5, {}],
  ["netrr05", ALL, 5, { ...C, minNetRR: 0.5 }],
  ["netrr10", ALL, 5, { ...C, minNetRR: 1.0 }],
  ["netrr15", ALL, 5, { ...C, minNetRR: 1.5 }],
  ["netrr20", ALL, 5, { ...C, minNetRR: 2.0 }],
  ["netrr10slip", ALL, 5, { ...C, researchSlipPct: 0.05, minNetRR: 1.0 }],
  ["score2", ALL, 5, { minScore: 2 }],
  ["score2_netrr10", ALL, 5, { ...C, minScore: 2, minNetRR: 1.0 }],
  ["tp100", ALL, 5, { tp2Ext: -1.0 }],
  ["tp162", ALL, 5, { tp2Ext: -1.618 }],
  ["tp162_netrr10", ALL, 5, { ...C, tp2Ext: -1.618, minNetRR: 1.0 }],
  ["ema200", ALL, 5, { trendEma: 200 }],
  ["ema200_netrr10", ALL, 5, { ...C, trendEma: 200, minNetRR: 1.0 }],
  ["atr", FIVE, 5, { minAtrPct: 0.25 }],
  ["tf15", FIVE, 15, {}],
  ["tf15_netrr10", FIVE, 15, { ...C, minNetRR: 1.0 }],
  ["tf30", FIVE, 30, {}],
  ["tf30_netrr10", FIVE, 30, { ...C, minNetRR: 1.0 }],
  ["tf60", FIVE, 60, {}],
  ["tf60_netrr10", FIVE, 60, { ...C, minNetRR: 1.0 }],
  ["tf60_ema200_netrr10", FIVE, 60, { ...C, trendEma: 200, minNetRR: 1.0 }],
  ["base_slip05", ALL, 5, { }, 0.05],
];
let i = 0, running = 0;
const next = () => {
  while (running < 3 && i < jobs.length) {
    const [name, bots, tf, variant, slip = 0] = jobs[i++];
    const out = join(OUT, `${name}.json`);
    if (existsSync(out)) continue;
    running++;
    const t0 = Date.now();
    const p = spawn(process.execPath, ["src/cli/exec-eval.mjs", "--sol1", SOL1, "--btc1", BTC1, "--fees", FEES, "--bots", bots, "--tf", String(tf), "--slip", String(slip), "--variant", JSON.stringify(variant), "--out", out], { cwd: ENGINE, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => { running--; console.log(`${name} exit ${code} ${Math.round((Date.now() - t0) / 1000)}s${code ? " " + err.slice(-300) : ""}`); next(); if (!running && i >= jobs.length) console.log("ALL DONE"); });
  }
};
next();

// Generate the candle screening tables from screen-results.json (no hand transcription).
//   node make-report-tables.mjs <docs/research/candles dir>   -> TABLES.md
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const D = process.argv[2], j = JSON.parse(readFileSync(join(D, "screen-results.json"), "utf8"));
const P = j.rows.filter((x) => x.family === "primary"), fails = (x) => ["holm", "cost", "periods", "breadth"].filter((k) => !x.screen[k]).join(", ") || "none";
const line = (x) => `| ${x.sym} | ${x.tf} | ${x.event} | ${x.h} | ${x.n} | ${x.clusters} | ${x.mean_raw_bps} | ${x.mean_effect_bps} | ${x.ci95_effect_bps ? x.ci95_effect_bps.join(" / ") : "–"} | ${x.p_holm === null || x.p_holm === undefined ? "–" : x.p_holm.toExponential(1)} | ${Object.values(x.periods_raw_bps).join(" / ")} | ${x.mae_p90_bps} | ${fails(x)} |`;
const head = "| Asset | TF | Event | h (bars) | n | Clusters | Mean raw (bps, trade direction) | Effect vs controls (bps) | 95 % CI effect | Holm p | P1 / P2 / P3 raw | MAE 10th pct (bps) | Failed |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
let s = `# Candle screening tables (generated from screen-results.json)\n\n${JSON.stringify(j.summary)}\n\n## Every Holm-significant primary test (${P.filter((x) => x.screen.holm).length})\n\n` + head + P.filter((x) => x.screen.holm).sort((a, b) => Math.abs(b.mean_raw_bps) - Math.abs(a.mean_raw_bps)).map(line).join("\n");
s += `\n\n## Every primary test with mean raw > 30 bps in the trade direction (${P.filter((x) => x.screen.cost).length})\n\n` + head + P.filter((x) => x.screen.cost).sort((a, b) => b.mean_raw_bps - a.mean_raw_bps).map(line).join("\n");
const t = {}; for (const x of P) t[fails(x)] = (t[fails(x)] ?? 0) + 1;
s += `\n\n## Failure reasons across all ${P.length} primary cells\n\n| Failed conditions | Cells |\n|---|---|\n` + Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join("\n") + "\n";
s += `\n## Event counts per asset and timeframe (h = 1)\n\n| Event | ${["BTC", "ETH", "SOL"].flatMap((a) => ["5m", "15m", "1h", "4h"].map((tf) => `${a} ${tf}`)).join(" | ")} |\n|---|${"---|".repeat(12)}\n`;
for (const e of [...new Set(P.map((x) => x.event))]) s += `| ${e} | ${["BTC", "ETH", "SOL"].flatMap((a) => ["5m", "15m", "1h", "4h"].map((tf) => P.find((x) => x.sym === a && x.tf === tf && x.event === e && x.h === 1)?.n ?? "–")).join(" | ")} |\n`;
writeFileSync(join(D, "TABLES.md"), s); console.log("written", s.length);

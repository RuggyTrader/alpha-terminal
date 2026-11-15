import { readFileSync } from "node:fs";
const R = JSON.parse(readFileSync(new URL("./r2.json", import.meta.url), "utf8"));
const only = process.argv[2] ?? "validated";
const sel = R.results.filter((r) => r.chosen && (only === "all" || r.passes_validation));
for (const r of sel) {
  const t = r.test;
  console.log(`\n${r.asset} ${r.tf} ${r.family} ${r.mode} ${JSON.stringify(r.chosen)} | dev ${r.dev.net} pf ${r.dev.profit_factor} n ${r.dev.trades} | val ${r.val.net} pf ${r.val.profit_factor} n ${r.val.trades} ${r.passes_validation ? "PASS" : "fail"}`);
  console.log(`  TEST net ${t.net} gross ${t.gross} fees ${t.fees} n ${t.trades} (L${t.long}/S${t.short}) win ${t.win_rate} PF ${t.profit_factor} avg ${t.avg_net} CI ${JSON.stringify(t.avg_net_ci95)} DD ${t.max_dd} (${t.max_dd_pct}%) hold ${t.avg_hold_h}h streak ${t.longest_losing_streak} skipped ${t.skipped_min_size}`);
  console.log("  costs", r.test_costs.map((c) => `${c.fee}/${c.slip}:${c.net}`).join("  "), "| risk1%", r.test_risk1.net, "| capital", r.test_capital.map((c) => `$${c.capital}:${c.net}(skip ${c.skipped_min_size})`).join(" "));
  console.log("  test neighbours", r.test_neighbours.map((n) => `${JSON.stringify(n.c)}:${n.net}`).join(" "));
  console.log("  val neighbours", r.val_neighbours.map((n) => `${JSON.stringify(n.c)}:${n.net}`).join(" "));
  console.log("  walk-forward", r.walk_forward.map((w) => `${w.from}:${w.net}(${w.trades})`).join(" "));
  console.log("  regimes", JSON.stringify(r.regimes_all_periods));
}
for (const [p, b] of Object.entries(R.benchmarks)) console.log(p, Object.entries(b).map(([k, v]) => `${k}: ${v.net} (${v.return_pct}%, DD ${v.max_dd_pct ?? "-"}%)`).join(" | "));

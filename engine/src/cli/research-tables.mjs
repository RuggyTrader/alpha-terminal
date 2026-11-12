// Renders the research JSON outputs as Markdown tables (no new numbers: every cell is copied from the run files).
//   node src/cli/research-tables.mjs --economics runs/economics-nov-warm/economics.json --fleet runs/fleet-parity-warm/fleet-backtest.json \
//        --research runs/research-sol5m-150d.json,runs/research-btcusd-1m.json,runs/research-btcusd-5m.json,runs/research-solusd-1m.json \
//        --long runs/alpha02-150d-economics.json --out ../docs/research/2026-11-12-tables.md

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const J = (f) => JSON.parse(readFileSync(f, "utf8"));
const f2 = (v) => (v === null || v === undefined ? "–" : Number(v).toFixed(2));
const f4 = (v) => (v === null || v === undefined ? "–" : Number(v).toFixed(4));
const pct = (v) => (v === null || v === undefined ? "–" : `${(Number(v) * 100).toFixed(0)}%`);
const out = [];
const t = (head, rows) => { out.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`), ""); };

const eco = J(arg("economics"));
out.push(`# Research tables — 2026-11-12`, "", `RESEARCH. ${eco.label}.`, "",
  `Window ${eco.window.from} → ${eco.window.to}, with real Kraken 1m candles (warm-up from 2026-10-29, which is converged; see parity-convergence). The 5m bots use candles aggregated from 1m. Reference trades are the exact original-profile trades with TradingView semantics, $10 risk and no capital limit.`, "");

out.push("## 1. Trade economics per bot at the official Ndax 0.20% per fill (reference trades)", "");
const E = (id, s) => eco.bots[id].reference_economics_at_0_20[s];
t(["Bot", "Side", "Trades", "Entry notional", "Exit notional", "Avg notional", "Gross", "Fees", "Net", "Avg gross/trade", "Avg net/trade", "Avg win", "Avg loss", "Win rate",
  "Avg move %", "Median move %", "Avg stop %", "Avg target %", "Avg hold (min)", "Break-even fee/fill %", "Break-even round trip %", "Fees ÷ gross", "Fee ÷ planned risk"],
  Object.keys(eco.bots).flatMap((id) => ["all", "LONG", "SHORT"].map((s) => { const e = E(id, s); return [id, s, e.trades, f2(e.total_entry_notional), f2(e.total_exit_notional), f2(e.avg_position_notional),
    f2(e.gross), f2(e.fees), f2(e.net), f2(e.avg_gross_per_trade), f2(e.avg_net_per_trade), f2(e.avg_win), f2(e.avg_loss), pct(e.win_rate), f4(e.avg_move_pct), f4(e.median_move_pct),
    f4(e.avg_stop_pct), f4(e.avg_tp_pct), f2(e.avg_hold_min), f4(e.break_even_fee_pct_per_fill), f4(e.break_even_round_trip_pct), f2(e.fee_to_gross_profit), f2(e.avg_fee_to_planned_risk)]; })));

out.push("## 2. Fee sensitivity (reference trades; rates other than 0.20% are hypothetical research scenarios, not offers)", "");
for (const id of Object.keys(eco.bots)) {
  out.push(`### ${id} (${eco.bots[id].symbol} ${eco.bots[id].timeframe})`, "");
  t(["Fee per fill", "Trades", "Gross", "Fees", "Net", "Net PF", "Max DD (net)", "Net expectancy"],
    eco.bots[id].reference_fee_sensitivity.map((r) => [`${r.fee_pct_per_fill}%`, r.trades, f2(r.gross), f2(r.fees), f2(r.net), f2(r.net_profit_factor), f2(r.max_drawdown_net), f2(r.net_expectancy)]));
}

out.push("## 3. Funded PAPER: each bot ALONE in its own wallet, by allocation (production-style wallet, reduce-to-fit, fees per fill, profit sweep)", "",
  "Net P&L in USD by per-fill fee (columns). The 0.20% column is the official benchmark; the others are research only.", "");
for (const id of Object.keys(eco.bots)) {
  const M = eco.bots[id].funded_matrix;
  out.push(`### ${id}`, "");
  const fees = [...new Set(M.map((r) => r.fee_pct_per_fill))];
  t(["Allocation", ...fees.map((x) => `net @${x}%`), "trades @0.20", "fees @0.20", "return @0.20", "max DD @0.20", "PF @0.20", "swept to MAIN @0.20", "skipped @0.20", "reduced-to-fit"],
    [...new Set(M.map((r) => r.allocation))].map((a) => {
      const at = (fee, slip = 0) => M.find((r) => r.allocation === a && r.fee_pct_per_fill === fee && r.slippage_pct_per_side === slip);
      const b = at(0.2);
      return [`$${a}`, ...fees.map((x) => f2(at(x)?.net)), b.trades, f2(b.fees), `${f2(b.return_on_allocation_pct)}%`, f2(b.max_drawdown), f2(b.net_profit_factor), f2(b.swept_to_main), JSON.stringify(b.skipped).replace(/[{}"]/g, "") || "–", b.reduced_to_fit];
    }));
  out.push("Slippage/spread scenarios at 0.20% (research): net by slippage per side.", "");
  const slips = [...new Set(M.filter((r) => r.fee_pct_per_fill === 0.2).map((r) => r.slippage_pct_per_side))];
  t(["Allocation", ...slips.map((s) => `slip ${s}%/side`)], [...new Set(M.map((r) => r.allocation))].map((a) => [`$${a}`, ...slips.map((s) => f2(M.find((r) => r.allocation === a && r.fee_pct_per_fill === 0.2 && r.slippage_pct_per_side === s)?.net))]));
}

const fleet = J(arg("fleet"));
out.push("## 4. Combined fleet (all four bots at once, equal allocation per bot, 0.20% per fill)", "");
t(["Per bot", "Slippage/side", "Combined net", "Fees", "Swept to MAIN", "MAIN at end", "Peak concurrent", "Reconciles", ...Object.keys(fleet.results[0].per_bot).map((b) => `${b} net (L/S)`)],
  fleet.results.map((r) => [`$${r.allocation_per_bot}`, `${r.slippage_pct_per_side}%`, f2(r.combined.funded.net), f2(r.combined.funded.fees), f2(r.combined.funded.swept_to_main), f2(r.combined.funded.main_end),
    r.combined.peak_concurrent_positions, r.combined.reconciles, ...Object.values(r.per_bot).map((b) => `${f2(b.funded.net)} (${b.funded.long_trades}/${b.funded.short_trades})`)]));

if (arg("long", null)) {
  const L = J(arg("long"));
  out.push("## 5. ALPHA-02 SOL 5m, 150 days: exact break-even commission", "", `Window ${L.window[0]} → ${L.window[1]}.`, "");
  t(["Side", "Trades", "Gross", "Entry notional", "Exit notional", "Break-even fee per fill", "Break-even round trip"],
    ["all", "LONG", "SHORT"].map((s) => { const e = L.economics[s]; return [s, e.trades, f2(e.gross), f2(e.total_entry_notional), f2(e.total_exit_notional), `${f4(e.break_even_fee_pct_per_fill)}%`, `${f4(e.break_even_round_trip_pct)}%`]; }));
  t(["Fee per fill", "Net", "Net PF", "Max DD"], L.sensitivity.map((r) => [`${r.fee}%`, f2(r.net), f2(r.net_profit_factor), f2(r.max_drawdown_net)]));
}

out.push("## 6. RESEARCH variants (separate ids; the original profiles are unchanged)", "",
  "IS = in-sample, OOS = out-of-sample. A variant is chosen on IS only; OOS is reported, never used to choose.", "");
for (const f of (arg("research", "") || "").split(",").filter(Boolean)) {
  const R = J(f);
  out.push(`### ${R.profile} (${R.timeframe}) — data ${R.data.first} → ${R.data.last}`, "", `IS ${R.split.in_sample} · OOS ${R.split.out_of_sample}`, "");
  t(["Variant", "IS trades", "IS gross (0%)", "IS net @0.20", "OOS trades", "OOS gross (0%)", "OOS net @0.20", "OOS break-even fee/fill", "Verdict"],
    R.variants.map((v) => v.skipped ? [v.id, "–", "–", "–", "–", "–", "–", "–", v.skipped] : [v.id, v.in_sample.ndax_0_20.trades, f2(v.in_sample.zero_cost.gross), f2(v.in_sample.ndax_0_20.net),
      v.out_of_sample.ndax_0_20.trades, f2(v.out_of_sample.zero_cost.gross), f2(v.out_of_sample.ndax_0_20.net), `${f4(v.out_of_sample.zero_cost.break_even_fee_pct_per_fill)}%`, v.verdict ?? "control (original)"]));
  if (R.regimes?.length) t(["Month", "Change %", "Mean bar range %", "Trend", "Volatility", "Original gross", "Original net @0.20"],
    R.regimes.map((g) => { const o = R.variants.find((v) => v.id === "RESEARCH-ORIG"); return [g.month, f2(g.change_pct), f4(g.mean_range_pct), g.trend, g.volatility, f2(o?.by_month_gross?.[g.month]), f2(o?.by_month_net_0_20?.[g.month])]; }));
}
const file = arg("out");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, out.join("\n"));
console.log(file, out.length, "lines");

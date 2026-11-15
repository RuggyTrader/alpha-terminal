// Summary of every research candidate: development (selection) vs untouched out-of-sample (verdict), at 0.20 % and
// 0.40 % per fill, plus regimes at 0.20 %. Prints a table and writes summary.json.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const rows = [];
for (const f of readdirSync(OUT).filter((x) => x.endsWith(".json")).sort()) {
  const r = JSON.parse(readFileSync(join(OUT, f), "utf8"));
  for (const [id, b] of Object.entries(r.bots)) {
    const P = b.periods, s = (p, fee) => P[p].strategy_fills[fee];
    const reg = Object.entries(b.regimes_full_at_0_20 ?? {}).filter(([, g]) => g.trades > 0);
    rows.push({
      candidate: f.replace(".json", ""), bot: id, tf: b.timeframe, data: `${b.data.from.slice(0, 10)}..${b.data.to.slice(0, 10)}`, split: b.data.split.slice(0, 10),
      dev_trades: s("development", "0%").trades, dev_gross: s("development", "0%").gross, dev_net20: s("development", "0.2%").net,
      oos_trades: s("out_of_sample", "0%").trades, oos_gross: s("out_of_sample", "0%").gross,
      oos_net20: s("out_of_sample", "0.2%").net, oos_net40: s("out_of_sample", "0.4%").net,
      oos_pf20: s("out_of_sample", "0.2%").profit_factor, oos_win20: s("out_of_sample", "0.2%").win_rate,
      oos_avg20: s("out_of_sample", "0.2%").expectancy, oos_dd20: s("out_of_sample", "0.2%").max_drawdown, oos_fees20: s("out_of_sample", "0.2%").fees,
      full_net20: s("full", "0.2%").net, full_trades: s("full", "0%").trades, be_full: P.full.break_even_fee_pct_per_fill, be_oos: P.out_of_sample.break_even_fee_pct_per_fill,
      regimes_pos20: `${reg.filter(([, g]) => g.net > 0).length}/${reg.length}`,
      regimes: Object.fromEntries(reg.map(([k, g]) => [k, { weeks: g.weeks, trades: g.trades, net: g.net }])),
    });
  }
}
writeFileSync(join(OUT, "..", "summary.json"), JSON.stringify(rows, null, 1));
const pad = (v, n) => String(v ?? "-").padStart(n);
console.log("candidate".padEnd(22), "bot".padEnd(9), "tf ", pad("devN", 5), pad("devNet.2", 9), pad("oosN", 5), pad("oosGross", 9), pad("oosNet.2", 9), pad("oosNet.4", 9), pad("PF", 6), pad("win", 6), pad("avg", 8), pad("DD", 7), pad("fees", 7), pad("BE%", 7), "regimes+");
for (const r of rows) console.log(r.candidate.padEnd(22), r.bot.padEnd(9), r.tf.padEnd(3), pad(r.dev_trades, 5), pad(r.dev_net20, 9), pad(r.oos_trades, 5), pad(r.oos_gross, 9), pad(r.oos_net20, 9), pad(r.oos_net40, 9), pad(r.oos_pf20, 6), pad(r.oos_win20, 6), pad(r.oos_avg20, 8), pad(r.oos_dd20, 7), pad(r.oos_fees20, 7), pad(r.be_oos, 7), r.regimes_pos20);

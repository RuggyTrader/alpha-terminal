// Strategy Mirror V2: independent 14-day historical backtests of the mirror-only markets BTCUSD and ETHUSD.
// Data: Kraken 5m candles 2026-10-28T00:00Z .. 2026-11-11T00:00Z rebuilt from Kraken's public trade list
// (src/cli/history-chunks.mjs), committed as test/fixtures/<SYM>-5m-14d.rows.json.gz with a checksum.
//   * data integrity, and an exact match with Kraken's own OHLC candles (test/fixtures/<SYM>-5m-kraken.json) where
//     the two overlap
//   * the Strategy Mirror replay equals the strategy's backtest trade by trade
//   * results reported and pinned as regression values. They are HYPOTHETICAL (margin 0, touch fills), use the SOLUSD
//     strategy inputs unchanged (not tuned for these markets), have no TradingView reference, and 14 days is a small
//     sample. SOLUSD's results say nothing about these markets.
//   node --test test/markets-backtest.test.mjs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { runBacktest } from "../src/cli/backtest.mjs";
import { metrics, tradeCosts, verifyCandles } from "../src/cli/baseline.mjs";
import { VENUES } from "../src/costs.mjs";
import { createMirror, mirrorStep } from "../src/mirror.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "..");
const STEP = 300_000;
const FROM = Date.parse("2026-10-28T00:00:00Z"), TO = Date.parse("2026-11-11T00:00:00Z");
const r2 = (v) => Math.round(v * 100) / 100;

// Regression values from the first verified run (2026-11-11). If the data or the strategy code changes, these change.
const PINNED = {
  BTCUSD: {"trades":63,"longs":34,"shorts":29,"winners":27,"gross":-2.58,"profit_factor":0.989,"max_drawdown":73.01,"long_gross":15.35,"short_gross":-17.93,"ndax_net":-1940.32,"kraken_net":-4592.55,"max_notional":22487.51,"exits":{"tp2":13,"stop_loss":20,"trailing_stop":24,"break_even":3,"time_exit":0,"same_bar":3}},
  ETHUSD: {"trades":57,"longs":30,"shorts":27,"winners":23,"gross":51.18,"profit_factor":1.31,"max_drawdown":67.48,"long_gross":29.38,"short_gross":21.79,"ndax_net":-1258.79,"kraken_net":-3063.26,"max_notional":14420.91,"exits":{"tp2":9,"stop_loss":8,"trailing_stop":29,"break_even":4,"time_exit":0,"same_bar":7}},
};

for (const symbol of ["BTCUSD", "ETHUSD"]) {
  describe(`${symbol}: 14-day backtest on Kraken data (hypothetical; SOLUSD inputs, not tuned)`, () => {
    const doc = JSON.parse(gunzipSync(readFileSync(join(HERE, "fixtures", `${symbol}-5m-14d.rows.json.gz`))).toString("utf8"));
    const candles = doc.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
    const cfg = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m", ENGINE_SYMBOL: symbol, ENGINE_FUNDED: "off", ENGINE_MIRROR: "on" }, ENGINE);

    it("data: checksum, complete grid, no duplicates or invalid candles; equal to Kraken's own OHLC where they overlap", (t) => {
      assert.equal(createHash("sha256").update(JSON.stringify(doc.rows)).digest("hex"), doc.rows_sha256);
      assert.equal(doc.symbol, symbol);
      const v = verifyCandles(candles, { from: FROM, to: TO });
      assert.deepEqual([v.duplicates, v.unordered, v.offGrid, v.invalidOHLC, v.nonPositive], [0, 0, 0, 0, 0]);
      assert.equal(candles[0].t >= FROM && candles.at(-1).t < TO, true);
      assert.equal(v.candles + v.missing_intervals, v.expected_intervals, "every interval is a candle or a period without trades");
      const ohlc = JSON.parse(readFileSync(join(HERE, "fixtures", `${symbol}-5m-kraken.json`), "utf8")).candles;
      const byT = new Map(candles.map((k) => [k.t, k]));
      const overlap = ohlc.filter((k) => byT.has(k.t));
      const mismatched = overlap.filter((k) => { const m = byT.get(k.t); return m.o !== k.o || m.h !== k.h || m.l !== k.l || m.c !== k.c; });
      assert.ok(overlap.length > 300, `overlap ${overlap.length}`);
      assert.equal(mismatched.length, 0, "trade-built candles equal Kraken's OHLC candles");
      t.diagnostic(`${symbol}: ${v.candles} candles of ${v.expected_intervals} intervals; ${v.missing_intervals} without trades in ${v.gaps.length} gaps; ${overlap.length} overlap Kraken OHLC exactly`);
    });

    it("the Strategy Mirror replay equals the strategy's backtest, trade by trade", () => {
      const A = runBacktest({ candles, symbol, intervalMin: 5, inputs: cfg.inputs }).trades;
      const ctx = { lateMs: 2 * STEP, symbol, intervalMin: 5, inputs: cfg.inputs, inputsHash: "0123456789abcdef" };
      const M = createMirror({ ...ctx, nowMs: candles[0].t });
      for (const k of candles) mirrorStep(M, k, { ...ctx, nowMs: k.t + STEP + 5_000 });
      const T = M.outbox.filter((x) => x.type === "TRADE");
      const key = (a) => [a.side, a.qty, a.entryTime.replace(".000Z", "Z"), a.entryPrice, a.exitTime.replace(".000Z", "Z"), a.exitPrice, a.exitKind, a.result ?? "TIME_EXIT", Number(a.pnl.toFixed(4))];
      const mkey = (m) => [m.side, m.qty, m.entry_time, m.entry_price, m.exit_time, m.exit_price, m.exit_kind, m.result, Number(m.gross_pnl.toFixed(4))];
      assert.deepEqual(T.map(mkey), A.map(key));
      assert.ok(T.every((x) => x.trade_id.startsWith(`MIR-${symbol}-5-`) && x.risk_usd === 10));
    });

    it("results (reported and pinned): trades, LONG/SHORT, gross, PF, drawdown, modelled costs, largest notional", (t) => {
      const A = runBacktest({ candles, symbol, intervalMin: 5, inputs: cfg.inputs }).trades;
      const m = metrics(A);
      const net = (venue) => r2(A.reduce((s, x) => s + x.pnl - tradeCosts(x, venue).total, 0));
      const got = {
        trades: m.trades, longs: m.longs, shorts: m.shorts, winners: m.winners, gross: m.net, profit_factor: m.profit_factor, max_drawdown: m.max_drawdown,
        long_gross: r2(A.filter((x) => x.side === "LONG").reduce((s, x) => s + x.pnl, 0)), short_gross: r2(A.filter((x) => x.side === "SHORT").reduce((s, x) => s + x.pnl, 0)),
        ndax_net: net(VENUES.ndax), kraken_net: net(VENUES.kraken), max_notional: r2(Math.max(...A.map((x) => x.qty * x.entryPrice))),
        exits: m.exits,
      };
      t.diagnostic(`${symbol} ${JSON.stringify(got)}`);
      if (PINNED[symbol]) assert.deepEqual(got, PINNED[symbol]);
    });
  });
}

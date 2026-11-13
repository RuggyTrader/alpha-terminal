// PERMANENT parity gate: the engine's reference replay (original profiles; TradingView Properties: zero commission,
// unlimited buying power, limit orders at the requested price) must reproduce the owner's TradingView "List of trades"
// screenshots (engine/parity/*.json) trade by trade, from real Kraken 1m candles (test/fixtures). The screenshots are an
// external reference only; they never feed the engine. A failure here means the port no longer matches the Pine script
// (2026-11-13: this gate would have caught the research loader dropping STRAT_TP2_EXT).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { compare, engineTrades } from "../src/cli/tv-parity.mjs";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const candles = (s) => JSON.parse(readFileSync(join(ENGINE, "test", "fixtures", `${s}-1m-2026-11-09_2026-11-13T0020.json`), "utf8")).rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const fixture = (f) => JSON.parse(readFileSync(join(ENGINE, "parity", f), "utf8"));

for (const [sym, file, tick, sum] of [["SOLUSD", "tv-solusd-1m-2026-11-08_12.json", 0.01, 185.22], ["BTCUSD", "tv-btcusd-1m-2026-11-08_12.json", 0.1, 77.36]]) {
  describe(`TradingView parity: ${sym} 1m, 9–12 Nov 2026 (history from 9 Nov 00:00 UTC)`, () => {
    const fx = fixture(file);
    const c = candles(sym);
    const eng = engineTrades({ symbol: sym, profile: fx.profile, candles: c, startMs: c[0].t, toMs: c.at(-1).t + 60_000, dir: ENGINE });
    const r = compare(fx.trades, eng, { tick });
    it("every TradingView trade is reproduced (side, entry, exit, prices, displayed quantity, P&L); none missing, none extra", () => {
      const bad = r.rows.filter((x) => !/MATCH/.test(x.status));
      assert.deepEqual(bad, [], JSON.stringify(bad.slice(0, 3)));
      assert.deepEqual(r.extra, [], JSON.stringify(r.extra.slice(0, 3)));
      assert.equal(r.rows.length, fx.trades.length);
    });
    it(`the closed trades' P&L reconciles with the screenshots ($${sum})`, () => {
      const total = r.rows.filter((x) => typeof x.engine_pnl === "number").reduce((s, x) => s + x.engine_pnl, 0);
      assert.ok(Math.abs(total - sum) <= 0.05, `engine ${total.toFixed(2)} vs screenshots ${sum}`);
    });
  });
}

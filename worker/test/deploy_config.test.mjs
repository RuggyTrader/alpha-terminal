// The deploy configuration (wrangler.jsonc) must keep production's safety settings exactly, and must never switch on
// simulated fees by itself. The expected values are those of the production Worker version 2cd0119d, read with
// `wrangler versions view` on 2026-11-10 (variables, D1 binding, compatibility date). Secrets are not in the config:
// a deploy keeps the 5 existing secrets (ADMIN_SECRET, ALPACA_KEY, ALPACA_SECRET, DASHBOARD_PASSPHRASE, WEBHOOK_SECRET).
//   node --test test/deploy_config.test.mjs   (no Worker needed)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// JSONC: drop // comments outside strings, then parse.
const jsonc = (text) => JSON.parse(text.split("\n").map((l) => {
  let inStr = false;
  for (let i = 0; i < l.length; i++) {
    if (l[i] === '"' && l[i - 1] !== "\\") inStr = !inStr;
    if (!inStr && l[i] === "/" && l[i + 1] === "/") return l.slice(0, i);
  }
  return l;
}).join("\n"));
const cfg = jsonc(readFileSync(join(HERE, "..", "wrangler.jsonc"), "utf8"));

const PRODUCTION_VARS = {
  ENABLE_TRADING: "false",
  ALLOWED_SYMBOLS: "MES,MNQ,GOLD,BTCUSD,ETHUSD,SOLUSD,HYPEUSD,KAITOUSD",
  MAX_ORDER_QTY: "10",
  MAX_ORDER_NOTIONAL: "5000",
  MAX_FUTURES_ORDER_NOTIONAL: "75000",
  MAX_POSITION_EXPOSURE: "10000",
  MAX_TOTAL_EXPOSURE: "25000",
  MAX_OPEN_POSITIONS: "5",
  SHORT_SELLING_ENABLED: "false",
  DAILY_LOSS_LIMIT: "2000",
};

describe("deploy configuration preserves production", () => {
  it("same Worker name, entry point, compatibility date and D1 binding", () => {
    assert.equal(cfg.name, "alpha-terminal-api");
    assert.equal(cfg.main, "src/index.ts");
    assert.equal(cfg.compatibility_date, "2026-10-30");
    assert.deepEqual(cfg.d1_databases.map((d) => [d.binding, d.database_name, d.database_id]), [["DB", "alpha-terminal-db", "40741873-0a98-4b23-b4e2-19ac8acec80c"]]);
  });

  it("every production variable is present with exactly its production value (trading stays off)", () => {
    for (const [k, v] of Object.entries(PRODUCTION_VARS)) assert.equal(cfg.vars[k], v, k);
    assert.equal(cfg.vars.ENABLE_TRADING, "false");
  });

  it("the only new variable is PAPER_COST_PROFILE, and it is 'none' (fees need a separate, deliberate change)", () => {
    assert.deepEqual(Object.keys(cfg.vars).filter((k) => !(k in PRODUCTION_VARS)), ["PAPER_COST_PROFILE"]);
    assert.equal(cfg.vars.PAPER_COST_PROFILE, "none");
  });

  it("no secret is written in the config", () => {
    for (const k of ["WEBHOOK_SECRET", "DASHBOARD_PASSPHRASE", "ADMIN_SECRET", "ALPACA_KEY", "ALPACA_SECRET"]) assert.equal(cfg.vars[k], undefined, k);
  });
});

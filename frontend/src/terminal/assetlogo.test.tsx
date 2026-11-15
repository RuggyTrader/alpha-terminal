// Asset identity: the correct logo for every alias, beside (never replacing) the market name; honest fallback.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AssetLogo, assetOf } from "./components/AssetLogo";
import { TradeStoryCard } from "./components/TradeStoryCard";
import { fromBotTrade } from "./tradeStory";

describe("asset aliases normalise to one asset", () => {
  it("Solana: SOL, SOLUSD, SOL/USD, Solana, KRAKEN:SOLUSD, ALPHA-01, ALPHA-02", () => {
    for (const a of ["SOL", "SOLUSD", "SOL/USD", "Solana", "KRAKEN:SOLUSD", "ALPHA-01", "ALPHA-02", "alpha 02", "solusd"]) expect(assetOf(a), a).toBe("SOL");
  });
  it("Bitcoin: BTC, XBT, BTCUSD, XBTUSD, XXBTZUSD, Bitcoin, ALPHA-03, ALPHA-04", () => {
    for (const a of ["BTC", "XBT", "BTCUSD", "XBTUSD", "XXBTZUSD", "BTC/USD", "Bitcoin", "KRAKEN:BTCUSD", "ALPHA-03", "ALPHA-04"]) expect(assetOf(a), a).toBe("BTC");
  });
  it("unsupported assets get no borrowed logo", () => {
    for (const a of ["ETHUSD", "SPY", "TSLA", "ALPHA-09", "", null]) expect(assetOf(a as string), String(a)).toBeNull();
  });
});

describe("AssetLogo renders the real mark with an accessible name", () => {
  it("Bitcoin and Solana marks, labelled, bundled inline (no image request)", () => {
    const btc = renderToStaticMarkup(<AssetLogo of="XBTUSD" />);
    expect(btc).toContain('aria-label="Bitcoin"'); expect(btc).toContain("#F7931A"); expect(btc).not.toContain("<img");
    const sol = renderToStaticMarkup(<AssetLogo of="SOLUSD" />);
    expect(sol).toContain('aria-label="Solana"'); expect(sol).toContain("#00FFA3"); expect(sol).toContain("#DC1FFF");
  });
  it("decorative when the name is written beside it; honest letters for an unknown asset", () => {
    expect(renderToStaticMarkup(<AssetLogo of="BTC" decorative />)).toContain('aria-hidden="true"');
    const eth = renderToStaticMarkup(<AssetLogo of="ETHUSD" />);
    expect(eth).toContain("asset-logo-fallback"); expect(eth).toContain(">ETH<"); expect(eth).not.toContain("#F7931A"); expect(eth).not.toContain("#00FFA3");
  });
});

describe("trade cards show the asset logo beside the market name (the reported generic icon is gone)", () => {
  it("a SOLUSD trade card has the Solana logo and still names SOLUSD", () => {
    const v = fromBotTrade({ trade_id: "T1", bot_id: "ALPHA-02", ledger: "legacy", symbol: "SOLUSD", side: "LONG", status: "CLOSED", qty: 0.12, entry_price: 81.43, exit_price: 81.17,
      opened_at: "2026-11-13T00:35:02Z", closed_at: "2026-11-13T00:40:02Z", gross_usd: -0.03, fees_usd: 0, net_usd: -0.03, swept_usd: 0, stop: null, tp: null, proof_url: "/trades/1" });
    const html = renderToStaticMarkup(<MemoryRouter><TradeStoryCard v={v} /></MemoryRouter>);
    expect(html).toContain('aria-label="Solana"');
    expect(html).toContain(">SOLUSD<");
    expect(html).not.toContain("◎");
  });
});

import { level } from "./fmt";
describe("strategy levels are shown at the market tick", () => {
  it("SOLUSD 0.01, BTCUSD 0.1, unknown 4 decimals; missing stays N/A", () => {
    expect(level(71.25877671421814, "SOLUSD")).toBe("71.26");
    expect(level(70.3075, "SOLUSD")).toBe("70.31");
    expect(level(74012.3456, "BTCUSD")).toBe("74012.3");
    expect(level(1.234567, "ETHUSD")).toBe("1.23");
    expect(level(null, "SOLUSD")).toBe("N/A");
  });
});

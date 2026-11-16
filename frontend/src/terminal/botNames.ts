// Bot display names: a PRESENTATION-ONLY alias for each persistent bot id. The ids (ALPHA-01 …) stay the keys of every
// record, wallet, order, position and route; only the words shown on screen change. A bot without an entry keeps the
// name the Worker reports (or its id), so a new bot needs no redesign: add one line here to give it a name.

export interface BotDisplay { name: string; asset: string }

export const BOT_DISPLAY: Readonly<Record<string, BotDisplay>> = Object.freeze({
  "ALPHA-01": { name: "SOL Flare", asset: "SOL" },
  "ALPHA-02": { name: "SOL Orbit", asset: "SOL" },
  "ALPHA-03": { name: "BTC Hash", asset: "BTC" },
  "ALPHA-04": { name: "BTC Atlas", asset: "BTC" },
});

/** The research trial's display name (shown only inside its own research view). */
export const TRIAL_DISPLAY_NAME = "BTC Titan";

/** "ALPHA-01" → "SOL Flare"; unknown ids fall back to the reported name, then to the id itself. */
export function displayName(botId: string | null | undefined, reported?: string | null): string {
  if (botId && BOT_DISPLAY[botId]) return BOT_DISPLAY[botId].name;
  return (reported && reported.trim()) || botId || "Unknown bot";
}

/** Replaces registered bot names inside text written by the Worker ("ALPHA 02 | SOLUSD 5m …", "ALPHA-03 …").
 *  Only standalone bot references (ALPHA + two digits) are touched: never inside an order, trade or signal id such as
 *  "ENG-ALPHA-01-SOLUSD-1-…" (ids are shown exactly as recorded). "ALPHA PAPER" / "ALPHA TERMINAL" are left alone. */
export function aliasText(text: string): string {
  return text.replace(/(?<![\w-])ALPHA[ -](\d{2})(?![\w-])/g, (m, n: string) => BOT_DISPLAY[`ALPHA-${n}`]?.name ?? m);
}

/** "SOLUSD" → "SOL/USD"; anything else unchanged. */
export function pairLabel(symbol: string | null | undefined): string {
  const s = String(symbol ?? "");
  const m = /^([A-Z0-9]+?)(USD|USDT|USDC|EUR)$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : s;
}

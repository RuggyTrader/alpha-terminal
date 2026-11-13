// "Ask ALPHA about this trade": any card or proof page opens the assistant with that exact trade as context (its
// normalized TradeView), so the owner never has to describe which trade they mean.
import type { TradeView } from "./tradeStory";

export interface AskRequest { trade: TradeView; question?: string }
export const ASK_EVENT = "alpha:ask";
export function askAlpha(req: AskRequest) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<AskRequest>(ASK_EVENT, { detail: req }));
}

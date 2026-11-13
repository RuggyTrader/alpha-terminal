// Trade history card. The detailed field table (alerts, intents, price source, cost profile) lives on the proof page
// (/trades/:id); the card shows the story first (components/TradeStoryCard.tsx).
import { fromLegacyTrade, type TradeStory } from "../tradeStory";
import type { TradeRow } from "../types";
import { TradeStoryCard } from "./TradeStoryCard";

export function TradeCard({ t, defaultOpen = false }: { t: TradeRow & { story?: TradeStory | null }; defaultOpen?: boolean }) {
  return <TradeStoryCard v={fromLegacyTrade(t)} defaultOpen={defaultOpen} />;
}

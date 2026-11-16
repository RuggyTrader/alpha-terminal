import { AlphaPaperPositionCard } from "../components/AlphaPaperPositionCard";
import { PositionCard } from "../components/PositionCard";
import { useFleet } from "../fleetStore";
import { TradeStoryCard } from "../components/TradeStoryCard";
import { fromBotTrade } from "../tradeStory";
import { EmptyState, SectionHeader, SkeletonCards } from "../components/ui";
import { AnimatedList } from "../motion";
import { useDash } from "../store";
import { useVerified } from "../useVerified";
import { useMemo } from "react";
import { useBotTrades } from "../botTrades";
import { closedCards } from "../recentClosed";
import { useActivityStream } from "../activity";
import { HomeHero } from "../components/HomeHero";
import { ClosedTrades } from "../components/ClosedTrades";
import { LiveActivity } from "../components/LiveActivity";

/** Every open ALPHA PAPER position: the legacy ledger's (simulated) AND each fleet bot's own (bot ledger), from the
 *  same records as the Capital card's "reserved" figure, so the two can never disagree. */
export function PositionsSection() {
  const { state } = useDash();
  const { fleet } = useFleet();
  const d = state.data;
  const paper = d?.paper ?? null;
  const legacyRows = paper?.positions ?? [];
  const botRows = (fleet?.available ? fleet.bots : []).filter((b) => b.ledger_api === "bot").flatMap((b) => b.open_positions.map((op) => fromBotTrade({
    trade_id: op.trade_id, bot_id: b.bot_id, ledger: "bot", symbol: op.symbol, side: op.side, status: "OPEN", qty: op.qty, entry_price: op.entry_price, exit_price: null,
    opened_at: op.opened_at, closed_at: null, gross_usd: null, fees_usd: op.entry_fee_usd ?? null, net_usd: null, swept_usd: null, stop: op.stop, tp: op.tp,
    proof_url: `/bots/trade/${encodeURIComponent(op.trade_id)}` })));
  const rows = legacyRows;
  return (
    <section aria-label="Open positions">
      <SectionHeader
        title="Open positions"
        sub="ALPHA PAPER ledger · simulated, not broker positions"
        right={paper || botRows.length ? <span className="count">{rows.length + botRows.length}</span> : null}
      />
      {!d ? (
        state.status === "loading" ? <SkeletonCards count={1} tall /> : <EmptyState title="No data" />
      ) : !paper ? (
        <EmptyState title="ALPHA PAPER ledger unavailable" tone="warn">This Worker does not report the simulated ledger.</EmptyState>
      ) : (
        <>
          {/* Stays mounted when empty so a closing position can fade out. */}
          <AnimatedList items={rows} getKey={(p) => String(p.id)} render={(p) => <AlphaPaperPositionCard p={p} />} />
          {botRows.length ? <div className="tcard-list">{botRows.map((v) => <TradeStoryCard key={v.key} v={v} />)}</div> : null}
          {rows.length + botRows.length === 0 ? (
            <EmptyState title="No open PAPER positions">A filled LONG or SHORT order appears here.</EmptyState>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Positions held in the optional Alpaca PAPER broker account. Shown only when there are any; its errors are in Settings. */
export function BrokerPositionsSection() {
  const { state } = useDash();
  const broker = state.data?.broker ?? null;
  const err = broker?.errors.find((e) => e.source === "positions");
  const rows = broker?.positions ?? [];
  if (!broker || err || rows.length === 0) return null;
  return (
    <section aria-label="Alpaca PAPER account positions">
      <SectionHeader title="Alpaca PAPER account positions" sub="Optional broker account · not the ALPHA PAPER ledger" right={<span className="count">{rows.length}</span>} />
      <AnimatedList items={rows} getKey={(p) => p.symbol} render={(p) => <PositionCard p={p} />} />
    </section>
  );
}

/** Home: a fixed one-screen command center. The talking hero, the latest closed funded trades and ALPHA Activity, which
 *  takes all remaining height and is the only part that scrolls. Wallets, positions, the fleet and research live on
 *  their own pages, so Home stays the same size however many bots there are. */
export function HomePage() {
  const { state, reconnected } = useDash();
  const verified = useVerified();
  const { fleet } = useFleet();
  const trades = useBotTrades({ bot: null, signal: null }, fleet);
  const cards = useMemo(() => closedCards(trades.data?.trades, 4), [trades.data]);
  const offline = state.status === "stale" || state.status === "error";
  const stream = useActivityStream(reconnected, offline);
  return (
    <div className="cc">
      <HomeHero state={state} verified={verified} reconnected={reconnected} closed={cards} />
      <ClosedTrades cards={cards} loading={!trades.data && !trades.error} error={trades.error} stale={trades.stale} />
      <LiveActivity s={stream} loadOlder={stream.loadOlder} feedOk={!offline} />
    </div>
  );
}

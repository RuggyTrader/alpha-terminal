// Home: one live line per bot under the Pipeline, from each bot's OWN engine report and ledger rows (GET
// /api/dashboard/bots). Several bots show at once; nothing rotates through inactive bots; a stale or offline bot stops
// animating; a proposed bot is shown as not running. Reads the shared fleet snapshot (fleetStore.ts).

import { Link } from "react-router-dom";
import { botPhase, botState, STATE_TONE, type Bot } from "../bots";
import { useFleet } from "../fleetStore";
import { SectionHeader, StatusBadge } from "./ui";
import { stamp } from "../fmt";
import { COIN } from "../pages/Bots";

export function BotPipelineRow({ b, nowMs }: { b: Bot; nowMs: number }) {
  const s = botState(b, nowMs);
  const p = botPhase(b, nowMs);
  return (
    <li className="bp-row" aria-label={`${b.name} ${b.symbol} ${b.timeframe}`}>
      <span className="bot-ic bp-ic" aria-hidden="true">{COIN[b.symbol]?.glyph ?? "α"}</span>
      <div className="bp-main">
        <b>{b.name} · {b.symbol} {b.timeframe}</b>
        <span className={`bot-phase ${p.live ? "is-live" : ""}`}>{p.phase}{p.detail ? <span> · {p.detail}</span> : null}</span>
        <span className="bp-meta">Kraken · {b.engine?.last_candle_time ? `candle ${stamp(b.engine.last_candle_time)}` : "no candle yet"}{b.engine?.received_at ? ` · report ${stamp(b.engine.received_at)}` : ""}</span>
      </div>
      <StatusBadge tone={STATE_TONE[s]}>{s.replace("_", " ")}</StatusBadge>
    </li>
  );
}

export function BotPipelinePanel() {
  const { fleet, fetchedAt } = useFleet(); // shared snapshot: no second poller for the same data
  const bots: Bot[] | null = fleet?.available ? fleet.bots.filter((b) => b.status !== "DISABLED") : null;
  const now = fetchedAt ?? Date.now();
  if (!bots || !bots.length) return null;
  return (
    <section className="card hp-card" aria-label="Bots pipeline">
      <SectionHeader title="Bots" sub="What each bot is doing · its own telemetry" right={<Link className="link" to="/bots">All bots</Link>} />
      <ul className="bp-list">{bots.map((b) => <BotPipelineRow key={b.bot_id} b={b} nowMs={now} />)}</ul>
    </section>
  );
}

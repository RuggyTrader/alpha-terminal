import { Link } from "react-router-dom";
import { fleetEngineStatus } from "../bots";
import { useFleet } from "../fleetStore";
import { SectionHeader, StatusBadge } from "./ui";

/**
 * The strategy engine's status for every active bot, from each bot's own heartbeat, last completed candle and ledger
 * check (bots.ts engineStatus). The Alpaca broker route is NOT part of it (Settings → Advanced).
 */
export function EngineStatusCard({ now = Date.now() }: { now?: number }) {
  const { fleet, stale, error } = useFleet();
  const bots = fleet?.available ? fleet.bots : [];
  const { worst, byBot } = fleetEngineStatus(bots, now);
  return (
    <section className="card hp-card" aria-label="Strategy engine">
      <SectionHeader title="Strategy engine" right={worst ? <StatusBadge tone={worst.tone} dot>{worst.label}</StatusBadge> : null} />
      {!fleet ? <p className="sizing-note">{error ? `Engine status unavailable: ${error}` : "Loading engine status…"}</p>
        : !fleet.available ? <p className="sizing-note">This backend has no bot registry yet (schema 6); the engine reports on the Engine page under Settings → Advanced.</p>
        : byBot.length === 0 ? <p className="sizing-note">No bot is active.</p>
        : (
          <div className="es-list">
            {byBot.map(({ bot, status }) => (
              <Link key={bot.bot_id} to={`/bots/${bot.bot_id}/chart`} className="es-row">
                <span><b>{bot.name}</b> {bot.symbol.replace(/USD$/, "")} {bot.timeframe}</span>
                <StatusBadge tone={status.tone} dot>{status.label}</StatusBadge>
                <i>{status.detail}</i>
              </Link>
            ))}
          </div>
        )}
      {stale ? <p className="sizing-note t-warn" role="status">STALE · last engine snapshot kept; refresh failed.</p> : null}
    </section>
  );
}

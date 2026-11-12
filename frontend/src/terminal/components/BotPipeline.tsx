// Home: one live line per bot under the Pipeline, from each bot's OWN engine report and ledger rows (GET
// /api/dashboard/bots). Several bots show at once; nothing rotates through inactive bots; a stale or offline bot stops
// animating; a proposed bot is shown as not running. Polls only while the page is visible.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { botPhase, botState, fetchBots, STATE_TONE, type Bot } from "../bots";
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
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      fetchBots().then((f) => { if (!live) return; setUnavailable(!f.available); setBots(f.bots.filter((b) => b.status !== "DISABLED")); setNow(Date.now()); }).catch(() => { if (live) setUnavailable(true); });
    };
    load();
    const id = setInterval(load, 20_000);
    document.addEventListener("visibilitychange", load);
    return () => { live = false; clearInterval(id); document.removeEventListener("visibilitychange", load); };
  }, []);
  if (unavailable || !bots || !bots.length) return null;
  return (
    <section className="card hp-card" aria-label="Bots pipeline">
      <SectionHeader title="Bots" sub="What each bot is doing · its own telemetry" right={<Link className="link" to="/bots">All bots</Link>} />
      <ul className="bp-list">{bots.map((b) => <BotPipelineRow key={b.bot_id} b={b} nowMs={now} />)}</ul>
    </section>
  );
}

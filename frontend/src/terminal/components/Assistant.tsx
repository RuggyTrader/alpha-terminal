// ALPHA Assistant chat drawer (read-only, deterministic; see ../assistant.ts). A floating button above the bottom
// navigation opens it. Answers come only from the fleet's records, with expandable evidence.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { answer, type Answer } from "../assistant";
import { ASK_EVENT, type AskRequest } from "../askAlpha";
import { answerTrade, isFleetQuestion } from "../tradeAssistant";
import type { TradeView } from "../tradeStory";
import { useFleet } from "../fleetStore";

const SUGGESTED = ["What is SOL 1m doing right now?", "What is BTC 5m waiting for?", "Which bot is making the most money?", "How much did BTC 5m pay in fees?",
  "What is my MAIN balance?", "How much profit has been transferred to MAIN?", "Can my BTC bot afford its minimum order?", "Is my engine offline?"];

interface Msg { q: string; a: Answer }

export function AssistantDrawer() {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  // The same shared snapshot as every other view (fleetStore.ts): the assistant reads exactly what the pages show.
  const { fleet, error, refresh } = useFleet();
  const err = fleet ? null : error;
  const [q, setQ] = useState("");
  const [ctx, setCtx] = useState<string>("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const [trade, setTrade] = useState<TradeView | null>(null); // "Ask ALPHA about this trade": the exact trade in context
  useEffect(() => {
    const on = (e: Event) => {
      const req = (e as CustomEvent<AskRequest>).detail;
      setTrade(req.trade); setOpen(true);
      if (req.question) { const q0 = req.question; setMsgs((m) => [...m, { q: q0, a: answerTrade(q0, req.trade) }].slice(-30)); }
    };
    window.addEventListener(ASK_EVENT, on);
    return () => window.removeEventListener(ASK_EVENT, on);
  }, []);
  useEffect(() => { if (open) refresh(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs]);
  const ask = (text: string) => {
    if (!text.trim()) return;
    setMsgs((m) => [...m, { q: text, a: trade && !isFleetQuestion(text) ? answerTrade(text, trade) : answer(text, fleet, Date.now(), ctx || null) }].slice(-30));
    setQ("");
  };
  return (
    <>
      <button className="asst-fab" aria-label="Open ALPHA Assistant" onClick={() => setOpen(true)}>α</button>
      {open ? (
        <div className={`asst ${full ? "is-full" : ""}`} role="dialog" aria-label="ALPHA Assistant">
          <div className="asst-h">
            <b>ALPHA Assistant</b>
            <span className="asst-sub">Read-only · answers from your records</span>
            <button className="link" onClick={() => setFull(!full)}>{full ? "Smaller" : "Expand"}</button>
            <button className="link" onClick={() => setMsgs([])}>Clear</button>
            <button className="link" aria-label="Close" onClick={() => setOpen(false)}>Close</button>
          </div>
          {trade ? <p className="asst-trade">About this trade: <b>{trade.botLabel} · {trade.symbol} {trade.side}</b> ({trade.status.toLowerCase()}) <button className="link" type="button" onClick={() => setTrade(null)}>clear</button></p> : null}
          <select className="input asst-ctx" value={ctx} onChange={(e) => setCtx(e.target.value)} aria-label="Bot context">
            <option value="">Any bot</option>
            {(fleet?.bots ?? []).filter((b) => b.status !== "DISABLED").map((b) => <option key={b.bot_id} value={b.bot_id}>{b.name} · {b.symbol} {b.timeframe}</option>)}
          </select>
          <div className="asst-body">
            {err ? <p className="sizing-note t-bad">Offline: {err}</p> : null}
            {!fleet && !err ? <p className="sizing-note">Loading records…</p> : null}
            {!msgs.length ? (
              <div className="asst-sugg">{SUGGESTED.map((s) => <button key={s} className="btn btn-ghost" onClick={() => ask(s)}>{s}</button>)}</div>
            ) : null}
            {msgs.map((m, i) => (
              <div key={i} className="asst-msg">
                <p className="asst-q">{m.q}</p>
                <p className={`asst-a ${m.a.known ? "" : "t-warn"}`}>{m.a.text}</p>
                {m.a.evidence.length ? (
                  <details className="asst-ev"><summary>Evidence</summary>
                    <ul>{m.a.evidence.map((e, j) => <li key={j}><b>{e.label}</b>: {e.value}{e.link ? <> · <Link className="link" to={e.link} onClick={() => setOpen(false)}>open</Link></> : null}</li>)}</ul>
                  </details>
                ) : null}
              </div>
            ))}
            <div ref={end} />
          </div>
          <form className="asst-in" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about a bot…" aria-label="Question" maxLength={300} />
            <button className="btn" type="submit">Ask</button>
          </form>
        </div>
      ) : null}
    </>
  );
}

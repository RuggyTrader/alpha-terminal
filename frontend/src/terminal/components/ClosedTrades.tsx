// Home "Closed trades": up to four of the latest completed funded PAPER trades (two on short screens, by CSS), newest
// first. Cards keep their identity by trade id: a new close slides into the first slot, the others glide to their new
// slots (FLIP, transform + opacity only), the oldest leaves. A poll that changes nothing animates nothing.

import { useLayoutEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { displayName } from "../botNames";
import { holdTime, type ClosedCard } from "../recentClosed";
import { prefersReducedMotion, usePresence, presenceClass } from "../motion";
import { AssetLogo } from "./AssetLogo";

const money = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
const pctText = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`;
const toneOf = (v: number) => (v > 0 ? "pos" : v < 0 ? "neg" : "zero");

export function ClosedTrades({ cards, loading, error, stale }: { cards: ClosedCard[]; loading: boolean; error: string | null; stale: boolean }) {
  const list = usePresence(cards, (c) => c.key);
  // Cards present when the list first loads are not "new"; only a trade that closes while Home is open animates in.
  const firstSeen = useRef<Set<string> | null>(null);
  if (firstSeen.current === null && cards.length) firstSeen.current = new Set(cards.map((c) => c.key));
  const isNew = (k: string) => !!firstSeen.current && !firstSeen.current.has(k);
  const grid = useRef<HTMLDivElement>(null);
  const pos = useRef(new Map<string, DOMRect>());
  const sig = cards.map((c) => c.key).join("|");
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const next = new Map<string, DOMRect>();
    el.querySelectorAll<HTMLElement>("[data-k]").forEach((n) => next.set(n.dataset.k!, n.getBoundingClientRect()));
    if (!prefersReducedMotion()) {
      el.querySelectorAll<HTMLElement>("[data-k]").forEach((n) => {
        const a = pos.current.get(n.dataset.k!), b = next.get(n.dataset.k!);
        if (!a || !b || typeof n.animate !== "function") return;
        const dx = a.left - b.left, dy = a.top - b.top;
        if (Math.abs(dx) + Math.abs(dy) > 1) n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: 420, easing: "cubic-bezier(0.22, 0.8, 0.24, 1)" });
      });
    }
    pos.current = next;
  }, [sig]);

  return (
    <section className="ct" aria-label="Closed trades">
      <header className="ct-h">
        <b>Closed trades</b>
        {stale ? <span className="ct-stale">not refreshed</span> : null}
        <Link className="link" to="/trades?view=completed">View all</Link>
      </header>
      {loading && !cards.length ? <div className="ct-grid"><div className="ct-card ct-skel" /><div className="ct-card ct-skel" /></div>
        : error && !cards.length ? <p className="ct-empty t-warn">Closed trades unavailable: {error}</p>
        : !cards.length ? <p className="ct-empty">No funded PAPER trade has closed yet.</p>
        : (
          <div className="ct-grid" ref={grid}>
            {list.map((p) => {
              const c = p.item;
              const t = toneOf(c.net);
              const held = holdTime(c.openedAt, c.closedAt);
              return (
                <Link key={p.key} data-k={p.key} to={c.url} className={`ct-card ct-${t} ${p.phase === "leaving" ? presenceClass("leaving") : isNew(p.key) ? `m-item is-new ct-flash-${t}` : "m-item"}`}
                  aria-label={`${displayName(c.botId)} ${c.side} closed ${money(c.net)} after fees`}>
                  <span className="ct-top"><AssetLogo of={c.symbol} size={18} /><b>{displayName(c.botId)}</b></span>
                  <span className="ct-mid"><em className={`ct-side ct-side-${c.side.toLowerCase()}`}>{c.side}</em><span className="ct-when">{held ?? c.closedAt.slice(11, 16)}</span></span>
                  <span className="ct-pnl">{money(c.net)}</span>
                  <span className="ct-ret">{c.returnPct === null ? "return n/a" : `${pctText(c.returnPct)} net`}</span>
                </Link>
              );
            })}
          </div>
        )}
    </section>
  );
}

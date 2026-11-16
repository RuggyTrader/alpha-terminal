// Home ALPHA Activity: a chat-style window into the recorded event history. Oldest above, newest at the bottom; it
// opens at the newest event, follows new events only while the reader is at the bottom, keeps their place (with a
// "N new updates ↓" pill) when they have scrolled up, and loads older history at the top without the content jumping.
// The panel scrolls by itself; the Home page never does.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Mark } from "../../components/icons";
import type { ActivityItem, StreamState } from "../activity";
import { hms } from "../fmt";
import { AssetLogo } from "./AssetLogo";

const NEAR_PX = 56;

export function LiveActivity({ s, loadOlder, feedOk }: { s: StreamState; loadOlder: () => void; feedOk: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const seen = useRef<Set<string> | null>(null);       // ids present at first render (no entrance animation)
  const lastNewest = useRef<string | null>(null);
  const anchor = useRef<{ h: number; top: number; firstId: string | null } | null>(null);
  const [unread, setUnread] = useState(0);
  const [away, setAway] = useState(false);          // scrolled up from the newest event
  const items = s.items;
  const newest = items.length ? items[items.length - 1].id : null;
  const first = items.length ? items[0].id : null;
  if (seen.current === null && s.loaded) seen.current = new Set(items.map((x) => x.id));

  // Older history prepended: keep the reader's visible content exactly where it was.
  useLayoutEffect(() => {
    const el = box.current, a = anchor.current;
    if (el && a && a.firstId !== first) { el.scrollTop = a.top + (el.scrollHeight - a.h); anchor.current = null; }
  }, [first]);

  // Newest event changed: follow it if the reader is at the bottom; otherwise count it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !newest) return;
    if (lastNewest.current === null) { el.scrollTop = el.scrollHeight; lastNewest.current = newest; return; } // open at the newest
    if (newest === lastNewest.current) return;
    const prevIdx = items.findIndex((x) => x.id === lastNewest.current);
    const added = prevIdx < 0 ? 1 : items.length - 1 - prevIdx;
    lastNewest.current = newest;
    if (atBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: smooth() });
    else setUnread((u) => u + Math.max(1, added));
  }, [newest]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_PX;
    if (atBottom.current !== !away) setAway(!atBottom.current);
    if (atBottom.current && unread) setUnread(0);
    if (el.scrollTop < 24 && !s.loadingOlder && !s.exhausted && items.length) older();
  };
  const older = () => {
    const el = box.current;
    if (el) anchor.current = { h: el.scrollHeight, top: el.scrollTop, firstId: first };
    loadOlder();
  };
  const toLatest = () => {
    const el = box.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth() });
    atBottom.current = true;
    setAway(false);
    setUnread(0);
  };
  useEffect(() => { if (!s.loaded) atBottom.current = true; }, [s.loaded]);

  const status = !feedOk || s.error ? { cls: "warn", text: s.at ? `STALE · ${new Date(s.at).toISOString().slice(11, 16)} UTC` : "UNAVAILABLE" } : s.at ? { cls: "ok", text: "LIVE" } : { cls: "muted", text: "CONNECTING" };

  return (
    <section className="la" aria-label="ALPHA Activity">
      <header className="la-h">
        <Mark size={20} />
        <b>ALPHA Activity</b>
        <span className={`la-st la-st-${status.cls}`}><i aria-hidden />{status.text}</span>
        <Link className="link la-all" to="/trades?view=activity">All</Link>
      </header>
      <div className="la-box" ref={box} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" tabIndex={0}>
        {!s.loaded ? <p className="la-empty">Loading recorded activity…</p> : null}
        {s.loaded && items.length ? (
          <div className="la-top">
            {s.exhausted ? <span>Start of recorded history</span>
              : <button type="button" className="link" onClick={older} disabled={s.loadingOlder}>{s.loadingOlder ? "Loading older events…" : "Load older events ↑"}</button>}
          </div>
        ) : null}
        {s.loaded && !items.length && !s.error ? <p className="la-empty">No recorded activity yet. Fills, exits, orders and engine events appear here as the Worker records them.</p> : null}
        {s.error && !items.length ? <p className="la-empty t-warn">Activity unavailable: {s.error}</p> : null}
        {items.map((e) => <Row key={e.id} e={e} fresh={!!seen.current && !seen.current.has(e.id)} />)}
        {s.error && items.length ? <p className="la-note t-warn">Not refreshed: {s.error}</p> : null}
      </div>
      {unread ? <button type="button" className="la-new m-press" onClick={toLatest}>{unread} new update{unread === 1 ? "" : "s"} ↓</button>
        : away ? <button type="button" className="la-jump m-press" onClick={toLatest} aria-label="Jump to latest">Latest ↓</button> : null}
    </section>
  );
}

function smooth(): ScrollBehavior {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function Row({ e, fresh }: { e: ActivityItem; fresh: boolean }) {
  // Bot events are titled "SOL Orbit | SOLUSD 5m" (the description is the outcome); others carry their own title.
  const m = /^(.+?) \| (.+)$/.exec(e.title);
  const who = m ? m[1] : e.source === "system" ? "System" : e.source === "device" ? "This device" : "ALPHA PAPER";
  const tag = m ? m[2] : null;
  const what = m ? (e.outcome || m[2]) : e.title;
  const out = m ? null : e.outcome;
  const body = (
    <>
      <span className="la-ico">{e.symbol ? <AssetLogo of={e.symbol} size={18} /> : <i className="la-dot" aria-hidden />}</span>
      <span className="la-txt">
        <span className="la-who"><b>{who}</b>{tag ? <em>{tag}</em> : null}<time dateTime={e.at}>{hms(e.at)}</time></span>
        <span className="la-what">{what}</span>
        {out ? <span className="la-out">{out}</span> : null}
      </span>
    </>
  );
  const cls = `la-row la-${e.tone}${fresh ? " is-new" : ""}`;
  return e.url ? <Link className={cls} to={e.url}>{body}</Link> : <div className={cls}>{body}</div>;
}

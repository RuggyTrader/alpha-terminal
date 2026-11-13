// One bot's chart: real Kraken OHLC for ITS market and timeframe (GET /api/dashboard/candles), with only that bot's own
// recorded levels (pending limit/stop/target, or open position entry/current stop/target). Completed candles come from
// Kraken; the forming candle is drawn separately and labelled; nothing is interpolated between refreshes. Refreshes only
// while the page is visible. Charts: TradingView Lightweight Charts™ (Apache-2.0), attribution below the chart.

import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { EmptyState, SectionHeader, StatusBadge } from "../components/ui";
import { money, NA, signedMoney, stamp } from "../fmt";
import { botState, STATE_TONE, type Bot } from "../bots";
import { useFleet } from "../fleetStore";
import { fetchTradeProof } from "../api";
import { fetchBotTradeProof } from "../botTrades";
import { CONFLUENCE, explainEntry, explainExit, fromBotTrade, fromLegacyTrade, type TradeStory, type TradeView } from "../tradeStory";

/** The four registered bots' markets (engine/src/bots.mjs). Used when the Worker has no bot registry yet (schema 6),
 *  so a chart link always opens the right market and timeframe. */
export const BOT_MARKETS: Record<string, { symbol: string; timeframe: string }> = {
  "ALPHA-01": { symbol: "SOLUSD", timeframe: "1m" }, "ALPHA-02": { symbol: "SOLUSD", timeframe: "5m" },
  "ALPHA-03": { symbol: "BTCUSD", timeframe: "1m" }, "ALPHA-04": { symbol: "BTCUSD", timeframe: "5m" },
};

/** Lines and markers for ONE completed or open trade, from its recorded story and ledger fills only. */
export function tradeOverlay(v: TradeView, tfMin: number) {
  const pl = v.story?.plan ?? null, ex = v.story?.exit ?? null;
  const bucket = (iso: string | null) => candleBucket(iso, tfMin);
  const lines: { price: number; title: string; color: string; dashed: boolean }[] = [];
  const add = (price: number | null | undefined, title: string, color: string, dashed = false) => { if (price !== null && price !== undefined && Number.isFinite(price)) lines.push({ price, title, color, dashed }); };
  add(pl?.planned_entry, "Planned entry", "#f08c00", true);
  add(pl?.initial_stop, "Initial stop", "#d64545");
  add(pl?.tp2, "Target", "#1f9d55");
  for (const h of ex?.stop_history ?? []) add(h.stop, h.reason === "BREAK_EVEN" ? "Stop → break-even" : "Trailing stop", "rgba(214,69,69,0.55)", true);
  const markers: { time: number; position: "belowBar" | "aboveBar"; color: string; shape: "arrowUp" | "arrowDown" | "circle"; text: string }[] = [];
  const t0 = bucket(v.openedAt), t1 = v.status === "CLOSED" ? bucket(v.closedAt) : null;
  if (t0 !== null) markers.push({ time: t0, position: v.side === "LONG" ? "belowBar" : "aboveBar", color: "#f08c00", shape: v.side === "LONG" ? "arrowUp" : "arrowDown", text: `${v.side} filled ${v.entry ?? ""}` });
  if (t1 !== null) markers.push({ time: t1, position: v.side === "LONG" ? "aboveBar" : "belowBar", color: (v.net ?? 0) >= 0 ? "#1f9d55" : "#d64545", shape: "circle", text: `exit ${v.exit ?? ""}` });
  return { lines, markers };
}

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
interface Candles { source: string; symbol: string; pair: string; timeframe_min: number; fetched_at: string; candles: Candle[]; forming: Candle | null }

/** Do not place a fill on a nearby or missing candle. */
export function candleBucket(iso: string | null, tfMin: number): number | null {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) && Number.isFinite(tfMin) && tfMin > 0 ? Math.floor(ms / 1000 / (tfMin * 60)) * tfMin * 60 : null;
}
export function chartMarkersInCandles<T extends { time: number }>(markers: T[], candles: Pick<Candle, "t">[]): T[] {
  const times = new Set(candles.map((c) => c.t));
  return markers.filter((m) => times.has(m.time));
}
/** A trade opened from a link must belong to THIS chart's bot, market and timeframe; never draw a BTC trade on a SOL chart. */
export function tradeMatchesChart(t: Pick<TradeView, "botId" | "symbol" | "timeframe">, botId: string, symbol: string | null, timeframe: string | null): boolean {
  const norm = (x: string | null) => String(x ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^XBT/, "BTC").replace(/^KRAKEN/, "");
  if (t.botId !== null && t.botId !== botId) return false;
  if (!symbol || norm(t.symbol) !== norm(symbol)) return false;
  if (t.timeframe !== null && timeframe !== null && t.timeframe !== timeframe) return false;
  return true;
}
export function chartDataMatches(data: Pick<Candles, "symbol" | "timeframe_min">, symbol: string, timeframe: string): boolean {
  return data.symbol === symbol && data.timeframe_min === Number(timeframe.replace(/\D/g, ""));
}
const css = (name: string, fallback: string) => (typeof window === "undefined" ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
const FEE = 0.002; // Ndax-equivalent 0.20% per fill (estimates only; recorded fees come from the ledger)

/** The levels a bot really has (recorded), never reconstructed from text. */
export function botLevels(b: Bot) {
  const p = b.open_positions[0] ?? null;
  const st = b.engine?.strategy_state ?? null;
  if (p) return { kind: "position" as const, side: p.side, entry: p.entry_price, stop: st?.current_stop ?? p.stop, initialStop: p.stop, tp: p.tp, qty: p.qty, tradeId: p.trade_id, openedAt: p.opened_at, entryFee: p.entry_fee_usd ?? null, risk: p.risk_usd ?? b.risk_usd };
  if (st?.pending_order) { const o = st.pending_order; return { kind: "pending" as const, side: o.side, entry: o.limit, stop: o.stop, initialStop: o.stop, tp: o.tp, qty: o.qty, tradeId: null, openedAt: null, entryFee: null, risk: b.risk_usd }; }
  return null;
}

/** Figures from real quantities and a real mark; null when they cannot be computed truthfully. */
export function chartFigures(lv: NonNullable<ReturnType<typeof botLevels>>, mark: number | null) {
  const dir = lv.side === "LONG" ? 1 : -1;
  const stopRisk = lv.entry !== null && lv.stop !== null ? Math.abs(lv.entry - lv.stop) * lv.qty : null;
  const rr = lv.entry !== null && lv.stop !== null && lv.tp !== null && lv.entry !== lv.stop ? Math.abs(lv.tp - lv.entry) / Math.abs(lv.entry - lv.stop) : null;
  const gross = lv.kind === "position" && mark !== null && lv.entry !== null ? (mark - lv.entry) * lv.qty * dir : null;
  const estNet = gross !== null && lv.entryFee !== null ? gross - lv.entryFee - mark! * lv.qty * FEE : null;
  const toLimit = lv.kind === "pending" && mark !== null && lv.entry !== null ? lv.entry - mark : null;
  const atTarget = lv.entry !== null && lv.tp !== null ? (lv.tp - lv.entry) * lv.qty * dir : null;
  // Estimates at the Ndax-equivalent 0.20% per fill (recorded fees replace them once filled): the entry fee (recorded
  // when the position exists) plus the exit fee at the level in question.
  const notional = lv.entry !== null ? lv.entry * lv.qty : null;
  const entryFee = lv.entryFee ?? (notional !== null ? notional * FEE : null);
  const feesAtTarget = entryFee !== null && lv.tp !== null ? entryFee + lv.tp * lv.qty * FEE : null;
  const netAtTarget = atTarget !== null && feesAtTarget !== null ? atTarget - feesAtTarget : null;
  const lossAtStop = stopRisk !== null && entryFee !== null && lv.stop !== null && lv.entry !== null
    ? (lv.stop - lv.entry) * lv.qty * dir - entryFee - lv.stop * lv.qty * FEE : null;
  const toLimitPct = toLimit !== null && mark ? (toLimit / mark) * 100 : null;
  return { stopRisk, rr, gross, estNet, toLimit, toLimitPct, atTarget, notional, feesAtTarget, netAtTarget, lossAtStop };
}

export function BotChartPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const tradeRef = params.get("trade"), ledger = params.get("ledger") === "legacy" ? "legacy" : "bot";
  // A new route starts a fresh chart and cancels the previous route's asynchronous results.
  return <BotChartContent key={JSON.stringify([id, ledger, tradeRef])} id={id} ledger={ledger} tradeRef={tradeRef} />;
}
function BotChartContent({ id, ledger, tradeRef }: { id: string; ledger: "legacy" | "bot"; tradeRef: string | null }) {
  const [trade, setTrade] = useState<TradeView | null>(null);
  const [full, setFull] = useState(false);
  const [fit, setFit] = useState(false);
  // The bot's levels come from the shared fleet snapshot (the same record Bots and Home show: current stop and target).
  const { fleet } = useFleet();
  const bot = fleet?.bots.find((x) => x.bot_id === id) ?? null;
  const sym = bot?.symbol ?? BOT_MARKETS[id]?.symbol ?? null, tf = bot?.timeframe ?? BOT_MARKETS[id]?.timeframe ?? null;
  // A specific trade (from a trade card, proof page or Activity link): its recorded levels and fills.
  useEffect(() => {
    if (!tradeRef) { setTrade(null); return; }
    let live = true;
    (ledger === "legacy"
      ? fetchTradeProof(Number(tradeRef)).then((pr) => fromLegacyTrade({ ...pr.trade, story: (pr as { story?: TradeStory | null }).story ?? null }))
      : fetchBotTradeProof(tradeRef).then((pr) => pr ? fromBotTrade({ trade_id: pr.position.trade_id, bot_id: pr.position.bot_id, ledger: "bot", symbol: String(pr.position.symbol), side: pr.position.side,
          status: pr.position.status, qty: pr.position.qty, entry_price: pr.position.entry_price, exit_price: pr.position.exit_price, opened_at: pr.position.opened_at, closed_at: pr.position.closed_at,
          gross_usd: pr.position.gross_usd, fees_usd: (pr.position.entry_fee_usd ?? 0) + (pr.position.exit_fee_usd ?? 0), net_usd: pr.position.net_usd, swept_usd: pr.position.swept_usd,
          stop: pr.position.stop, tp: pr.position.tp, proof_url: `/bots/trade/${encodeURIComponent(pr.position.trade_id)}`, story: pr.story ?? null }) : null))
      .then((v) => {
        if (!live) return;
        if (v && !tradeMatchesChart(v, id, sym, tf)) { setTrade(null); setErr(`Trade ${tradeRef} belongs to ${v.botId ?? v.symbol}${v.timeframe ? ` ${v.timeframe}` : ""}, not ${id}${sym ? ` (${sym} ${tf})` : ""}. It is not drawn on this chart.`); return; }
        setTrade(v);
      }).catch((e) => { if (live) setErr(String((e as Error).message)); });
    return () => { live = false; };
  }, [tradeRef, ledger, id, sym, tf]);
  const [data, setData] = useState<Candles | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const forming = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    let live = true;
    let inFlight = false;
    const load = async () => {
      if (!live || inFlight || document.visibilityState !== "visible" || !sym || !tf) return;
      inFlight = true;
      try {
        const env = await api.get<{ ok: boolean; data?: Candles; code?: string; message?: string }>(`/api/dashboard/candles?symbol=${sym}&tf=${tf.replace(/\D/g, "")}`);
        if (!live) return;
        if (env?.ok && env.data && chartDataMatches(env.data, sym, tf)) { setData(env.data); setMarketError(null); setRefreshedAt(Date.now()); }
        else setMarketError(env?.code ?? "Market data unavailable or does not match this chart");
      } catch (e) { if (live) setMarketError(String((e as Error).message)); }
      finally { inFlight = false; }
    };
    load();
    const id2 = setInterval(load, 15_000);
    document.addEventListener("visibilitychange", load);
    return () => { live = false; clearInterval(id2); document.removeEventListener("visibilitychange", load); };
  }, [sym, tf]);
  useEffect(() => { if (fleet && !bot && !BOT_MARKETS[id]) setErr(`${id} is not a registered bot`); }, [fleet, bot, id]);

  useEffect(() => {
    if (!box.current || chart.current) return;
    const c = createChart(box.current, {
      autoSize: true, layout: { background: { color: css("--surface", "#ffffff") }, textColor: css("--ink", "#111111") },
      grid: { vertLines: { color: css("--line", "#eeeeee") }, horzLines: { color: css("--line", "#eeeeee") } },
      timeScale: { timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 },
      handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: true }, handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    series.current = c.addCandlestickSeries({ upColor: "#1f9d55", downColor: "#d64545", borderVisible: false, wickUpColor: "#1f9d55", wickDownColor: "#d64545" });
    forming.current = c.addCandlestickSeries({ upColor: "rgba(31,157,85,0.35)", downColor: "rgba(214,69,69,0.35)", borderVisible: true, borderUpColor: "#1f9d55", borderDownColor: "#d64545", wickUpColor: "#888", wickDownColor: "#888", lastValueVisible: false, priceLineVisible: false });
    chart.current = c;
    return () => { c.remove(); chart.current = null; series.current = null; forming.current = null; };
  }, []);

  const lv = useMemo(() => (bot && !tradeRef ? botLevels(bot) : null), [bot, tradeRef]);
  const levels = useMemo(() => {
    const ps: number[] = [];
    if (trade && data) for (const l of tradeOverlay(trade, data.timeframe_min).lines) ps.push(l.price);
    if (lv) for (const v of [lv.entry, lv.stop, lv.tp, lv.initialStop]) if (v !== null && v !== undefined && Number.isFinite(v)) ps.push(v);
    return ps;
  }, [trade, lv, data]);
  // "Fit levels": the price scale includes the entry, stop and target, so none is off-screen.
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.applyOptions({ autoscaleInfoProvider: (orig: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
      const r = orig();
      if (!fit || !levels.length || !r) return r;
      return { priceRange: { minValue: Math.min(r.priceRange.minValue, ...levels), maxValue: Math.max(r.priceRange.maxValue, ...levels) } };
    } });
  }, [fit, levels]);
  useEffect(() => {
    const s = series.current;
    if (!s || !data) return;
    s.setData(data.candles.map((k) => ({ time: k.t as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c })));
    forming.current?.setData(data.forming ? [{ time: data.forming.t as UTCTimestamp, open: data.forming.o, high: data.forming.h, low: data.forming.l, close: data.forming.c }] : []);
    for (const pl of (s as unknown as { __lines?: ReturnType<typeof s.createPriceLine>[] }).__lines ?? []) s.removePriceLine(pl);
    const lines: ReturnType<typeof s.createPriceLine>[] = [];
    s.setMarkers([]); // A former open trade must not leave a marker on a pending order.
    if (lv) {
      const add = (price: number | null, color: string, title: string, style = 0) => { if (price !== null && Number.isFinite(price)) lines.push(s.createPriceLine({ price, color, lineWidth: 2, lineStyle: style, axisLabelVisible: true, title })); };
      add(lv.entry, "#f08c00", lv.kind === "pending" ? "Limit" : "Entry", lv.kind === "pending" ? 2 : 0);
      add(lv.stop, "#d64545", lv.kind === "position" && lv.stop !== lv.initialStop ? "Stop (moved)" : "Stop");
      if (lv.kind === "position" && lv.initialStop !== null && lv.initialStop !== lv.stop) add(lv.initialStop, "rgba(214,69,69,0.45)", "Initial stop", 2);
      add(lv.tp, "#1f9d55", "Target");
      const entryBar = candleBucket(lv.openedAt, data.timeframe_min);
      if (entryBar !== null && data.candles.some((c) => c.t === entryBar)) s.setMarkers([{ time: entryBar as UTCTimestamp, position: lv.side === "LONG" ? "belowBar" : "aboveBar", color: "#f08c00", shape: lv.side === "LONG" ? "arrowUp" : "arrowDown", text: `${lv.side} entry` }]);
    }
    if (trade) {
      const o = tradeOverlay(trade, data.timeframe_min);
      for (const l of o.lines) lines.push(s.createPriceLine({ price: l.price, color: l.color, lineWidth: 2, lineStyle: l.dashed ? 2 : 0, axisLabelVisible: true, title: l.title }));
      // Only markers inside the candles shown: a fill outside them would otherwise be drawn on the wrong candle.
      s.setMarkers(chartMarkersInCandles(o.markers, data.candles).map((m) => ({ ...m, time: m.time as UTCTimestamp })));
    } else if (!lv) s.setMarkers([]);
    (s as unknown as { __lines?: unknown[] }).__lines = lines;
  }, [data, lv, trade]);

  const now = Date.now();
  const lastClose = data && data.candles.length ? data.candles[data.candles.length - 1].c : null;
  const ageSec = data ? Math.round((now - Date.parse(data.fetched_at)) / 1000) : null;
  const fresh = !data && !marketError ? "LOADING"
    : !marketError && ageSec !== null && ageSec >= 0 && ageSec < 90 ? "FRESH" : ageSec !== null && ageSec >= 0 && ageSec < 600 ? "STALE" : "OFFLINE";
  const f = lv ? chartFigures(lv, fresh === "FRESH" ? lastClose : null) : null;
  return (
    <div className="page-narrow bots-page">
      <SectionHeader title={bot ? `${bot.name} · ${bot.symbol} ${bot.timeframe}` : id} sub={<Link className="link" to="/bots">← Bots</Link>}
        right={bot ? <StatusBadge tone={STATE_TONE[botState(bot, now)]} dot>{botState(bot, now)}</StatusBadge> : null} />
      {err ? <EmptyState title="Trade details unavailable" tone="bad">{err}</EmptyState> : null}
      {marketError ? <EmptyState title={data ? "Market refresh failed — last snapshot" : "Chart unavailable"} tone="bad">{marketError}</EmptyState> : null}
      <div className={`bot-chart-wrap ${full ? "is-full" : ""}`}>
        {full ? <div className="chart-tools"><b>{sym} {tf}</b><button className="btn btn-ghost" type="button" onClick={() => setFull(false)}>Exit full screen</button></div> : null}
        <div className="bot-chart" ref={box} aria-label="Price chart" />
      </div>
      <div className="chart-tools">
        <button className="btn btn-ghost" type="button" onClick={() => chart.current?.timeScale().fitContent()}>Reset zoom</button>
        <button className={`btn btn-ghost ${fit ? "is-on" : ""}`} type="button" aria-pressed={fit} onClick={() => setFit(!fit)}>{fit ? "Fit candles" : "Fit trade levels"}</button>
        <button className="btn btn-ghost" type="button" onClick={() => setFull(true)}>Full screen</button>
      </div>
      <p className="sizing-note">
        Source: {data?.source ?? "Kraken"} ({data?.pair ?? NA}) · {data ? `${data.candles.length} completed ${data.timeframe_min}m candles` : NA} · forming candle shown faded ·
        last refresh {refreshedAt ? stamp(new Date(refreshedAt).toISOString()) : NA} · <StatusBadge tone={fresh === "FRESH" ? "ok" : fresh === "STALE" ? "warn" : fresh === "LOADING" ? "muted" : "bad"}>{fresh}</StatusBadge>

      </p>
      {lv && fresh !== "FRESH" && fresh !== "LOADING" ? <p className="sizing-note t-warn">Market data is {fresh}: current price, distance to limit and unrealized P&amp;L are hidden until a fresh refresh succeeds.</p> : null}
      {bot && lv && f ? (() => { const st = bot.engine?.strategy_state ?? null; return (
        <section className="card">
          <SectionHeader title={lv.kind === "pending" ? "Pending limit order" : `Open PAPER ${lv.side}`} sub={`${bot.bot_id} · ${bot.profile} · config ${bot.inputs_hash}`} />
          <div className="sizing-grid">
            <div><span>{lv.kind === "pending" ? "Limit" : "Entry"}</span><b>{lv.entry ?? NA}</b></div>
            <div><span>{lv.kind === "position" ? "Stop (current)" : "Stop"}</span><b>{lv.stop ?? NA}</b></div>
            {lv.kind === "position" ? <div><span>Initial stop</span><b>{lv.initialStop ?? NA}</b></div> : null}
            <div><span>Target</span><b>{lv.tp ?? NA}</b></div>
            {lv.kind === "position" ? <div><span>Stop management</span><b>{st?.trailing ? "Trailing" : st?.break_even_done || (lv.stop !== null && lv.stop === lv.entry) ? "Break-even" : "Initial stop"}</b></div> : null}
            <div><span>Quantity</span><b>{lv.qty}</b></div>
            <div><span>Position value</span><b>{f.notional === null ? NA : money(f.notional)}</b></div>
            <div><span>Dollar-risk target</span><b>{money(lv.risk)}</b></div>
            <div><span>Result at stop (est., after fees)</span><b>{f.lossAtStop === null ? NA : signedMoney(f.lossAtStop)}</b></div>
            <div><span>Reward : risk</span><b>{f.rr === null ? NA : f.rr.toFixed(2)}</b></div>
            {lv.kind === "pending" ? <div><span>Distance to limit</span><b>{f.toLimit === null ? NA : `${f.toLimit > 0 ? "+" : ""}${f.toLimit.toFixed(2)} (${f.toLimitPct!.toFixed(2)}%)`}</b></div> : null}
            {lv.kind === "position" ? <div><span>Gross unrealized (est., last close)</span><b>{f.gross === null ? NA : signedMoney(f.gross)}</b></div> : null}
            {lv.kind === "position" ? <div><span>Net unrealized (est. after fees)</span><b>{f.estNet === null ? NA : signedMoney(f.estNet)}</b></div> : null}
            <div><span>At target: gross · fees</span><b>{f.atTarget === null ? NA : `${signedMoney(f.atTarget)} · ${f.feesAtTarget === null ? NA : money(f.feesAtTarget)}`}</b></div>
            <div><span>At target: net (est.)</span><b>{f.netAtTarget === null ? NA : signedMoney(f.netAtTarget)}</b></div>
          </div>
          {lv.kind === "pending" && bot.engine?.strategy_state?.pending_order ? (() => { const po = bot.engine.strategy_state.pending_order;
            const conf = (po.confluence ?? []).map((t) => CONFLUENCE[t] ?? t);
            return <p className="sizing-note"><b>Why:</b> {po.side} OTE limit at the 70.5% retracement{po.ote_705 !== null && po.ote_705 !== undefined ? ` (${po.ote_705})` : ""} of the {po.side === "LONG" ? "bullish" : "bearish"} swing {bot.engine.strategy_state.leg_start} → {bot.engine.strategy_state.leg_end}{conf.length ? `, with ${conf.join(" and ")} confluence` : ""}{po.score !== null && po.score !== undefined ? ` (score ${po.score})` : ""}{po.placed_at ? `; placed ${stamp(po.placed_at)}` : ""}{bot.engine.strategy_state.setup_bars !== null && bot.engine.strategy_state.max_age_bars ? `; setup valid for ${Math.max(0, bot.engine.strategy_state.max_age_bars - bot.engine.strategy_state.setup_bars)} more candles` : ""}.</p>; })() : null}
          <p className="sizing-note">{lv.tradeId ? `Trade ${lv.tradeId} · opened ${stamp(lv.openedAt!)} · ` : ""}Fee estimates use the Ndax-equivalent 0.20% per fill. Unrealized figures are estimates at the last completed candle, not realized profit. A stop does not guarantee the loss (gaps, fees).</p>
        </section>
      ); })() : trade ? (
        <section className="card" aria-label="This trade">
          <SectionHeader title={`${trade.side} · ${trade.status === "CLOSED" ? "closed" : "open"} trade`} sub={<Link className="link" to={trade.proofUrl}>Full trade proof →</Link>} />
          <p className="sizing-note"><b>Why it entered:</b> {explainEntry(trade) ?? "not recorded for this trade."}</p>
          {trade.status === "CLOSED" ? <p className="sizing-note"><b>Why it exited:</b> {explainExit(trade) ?? "not recorded for this trade."}</p> : null}
          {data && data.candles.length && trade.openedAt && Date.parse(trade.openedAt) / 1000 < data.candles[0].t
            ? <p className="sizing-note t-warn">This trade is older than the {data.candles.length} most recent completed candles this chart receives from Kraken, so its fill markers are not drawn (no archived candles are available here). The levels are still drawn.</p> : null}
          {data && data.candles.length && trade.openedAt && Date.parse(trade.openedAt) / 1000 > data.candles[data.candles.length - 1].t + data.timeframe_min * 60
            ? <p className="sizing-note t-warn">This trade is newer than the latest candle received, so its fill markers are not drawn yet. The levels are drawn.</p> : null}
        </section>
      ) : bot ? (
        <p className="sizing-note">{bot.engine?.strategy_state?.direction
          ? `Setup developing: ${bot.engine.strategy_state.direction} swing ${bot.engine.strategy_state.leg_start} → ${bot.engine.strategy_state.leg_end}; no order has been placed yet.`
          : "Scanning — no valid setup yet."}</p>
      ) : null}
      <p className="sizing-note">Charts by <a className="link" href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a></p>
    </div>
  );
}

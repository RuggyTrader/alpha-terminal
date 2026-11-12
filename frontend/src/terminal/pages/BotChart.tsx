// One bot's chart: real Kraken OHLC for ITS market and timeframe (GET /api/dashboard/candles), with only that bot's own
// recorded levels (pending limit/stop/target, or open position entry/current stop/target). Completed candles come from
// Kraken; the forming candle is drawn separately and labelled; nothing is interpolated between refreshes. Refreshes only
// while the page is visible. Charts: TradingView Lightweight Charts™ (Apache-2.0), attribution below the chart.

import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { EmptyState, SectionHeader, StatusBadge } from "../components/ui";
import { money, NA, signedMoney, stamp } from "../fmt";
import { botState, STATE_TONE, type Bot } from "../bots";
import { useFleet } from "../fleetStore";

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
interface Candles { source: string; symbol: string; pair: string; timeframe_min: number; fetched_at: string; candles: Candle[]; forming: Candle | null }

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
  return { stopRisk, rr, gross, estNet, toLimit, atTarget };
}

export function BotChartPage() {
  const { id = "" } = useParams();
  // The bot's levels come from the shared fleet snapshot (the same record Bots and Home show: current stop and target).
  const { fleet } = useFleet();
  const bot = fleet?.bots.find((x) => x.bot_id === id) ?? null;
  const sym = bot?.symbol ?? null, tf = bot?.timeframe ?? null;
  const [data, setData] = useState<Candles | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const forming = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      if (!sym || !tf) return;
      try {
        const env = await api.get<{ ok: boolean; data?: Candles; code?: string; message?: string }>(`/api/dashboard/candles?symbol=${sym}&tf=${tf.replace(/\D/g, "")}`);
        if (!live) return;
        if (env?.ok && env.data) { setData(env.data); setErr(null); setRefreshedAt(Date.now()); } else setErr(env?.code ?? "Market data unavailable");
      } catch (e) { if (live) setErr(String((e as Error).message)); }
    };
    load();
    const id2 = setInterval(load, 15_000);
    document.addEventListener("visibilitychange", load);
    return () => { live = false; clearInterval(id2); document.removeEventListener("visibilitychange", load); };
  }, [sym, tf]);
  useEffect(() => { if (fleet && !bot) setErr(`${id} is not a registered bot`); }, [fleet, bot, id]);

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

  const lv = useMemo(() => (bot ? botLevels(bot) : null), [bot]);
  useEffect(() => {
    const s = series.current;
    if (!s || !data) return;
    s.setData(data.candles.map((k) => ({ time: k.t as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c })));
    forming.current?.setData(data.forming ? [{ time: data.forming.t as UTCTimestamp, open: data.forming.o, high: data.forming.h, low: data.forming.l, close: data.forming.c }] : []);
    for (const pl of (s as unknown as { __lines?: ReturnType<typeof s.createPriceLine>[] }).__lines ?? []) s.removePriceLine(pl);
    const lines: ReturnType<typeof s.createPriceLine>[] = [];
    if (lv) {
      const add = (price: number | null, color: string, title: string, style = 0) => { if (price !== null && Number.isFinite(price)) lines.push(s.createPriceLine({ price, color, lineWidth: 2, lineStyle: style, axisLabelVisible: true, title })); };
      add(lv.entry, "#f08c00", lv.kind === "pending" ? "Limit" : "Entry", lv.kind === "pending" ? 2 : 0);
      add(lv.stop, "#d64545", lv.kind === "position" && lv.stop !== lv.initialStop ? "Stop (moved)" : "Stop");
      if (lv.kind === "position" && lv.initialStop !== null && lv.initialStop !== lv.stop) add(lv.initialStop, "rgba(214,69,69,0.45)", "Initial stop", 2);
      add(lv.tp, "#1f9d55", "Target");
      if (lv.openedAt) s.setMarkers([{ time: Math.floor(Date.parse(lv.openedAt) / 1000 / (data.timeframe_min * 60)) * data.timeframe_min * 60 as UTCTimestamp, position: lv.side === "LONG" ? "belowBar" : "aboveBar", color: "#f08c00", shape: lv.side === "LONG" ? "arrowUp" : "arrowDown", text: `${lv.side} entry` }]);
    }
    (s as unknown as { __lines?: unknown[] }).__lines = lines;
  }, [data, lv]);

  const now = Date.now();
  const lastClose = data && data.candles.length ? data.candles[data.candles.length - 1].c : null;
  const ageSec = data ? Math.round((now - Date.parse(data.fetched_at)) / 1000) : null;
  const fresh = ageSec !== null && ageSec < 90 ? "FRESH" : ageSec !== null && ageSec < 600 ? "STALE" : "OFFLINE";
  const f = lv ? chartFigures(lv, lastClose) : null;
  return (
    <div className="page-narrow bots-page">
      <SectionHeader title={bot ? `${bot.name} · ${bot.symbol} ${bot.timeframe}` : id} sub={<Link className="link" to="/bots">← Bots</Link>}
        right={bot ? <StatusBadge tone={STATE_TONE[botState(bot, now)]} dot>{botState(bot, now)}</StatusBadge> : null} />
      {err ? <EmptyState title="Chart unavailable" tone="bad">{err}</EmptyState> : null}
      <div className="bot-chart" ref={box} aria-label="Price chart" />
      <p className="sizing-note">
        Source: {data?.source ?? "Kraken"} ({data?.pair ?? NA}) · {data ? `${data.candles.length} completed ${data.timeframe_min}m candles` : NA} · forming candle shown faded ·
        last refresh {refreshedAt ? stamp(new Date(refreshedAt).toISOString()) : NA} · <StatusBadge tone={fresh === "FRESH" ? "ok" : fresh === "STALE" ? "warn" : "bad"}>{fresh}</StatusBadge>
        {" "}· <button className="link" onClick={() => chart.current?.timeScale().fitContent()}>Reset zoom</button>
      </p>
      {bot && lv && f ? (
        <section className="card">
          <SectionHeader title={lv.kind === "pending" ? "Pending limit order" : `Open PAPER ${lv.side}`} sub={`${bot.bot_id} · ${bot.profile} · config ${bot.inputs_hash}`} />
          <div className="sizing-grid">
            <div><span>{lv.kind === "pending" ? "Limit" : "Entry"}</span><b>{lv.entry ?? NA}</b></div>
            <div><span>Stop (current)</span><b>{lv.stop ?? NA}</b></div>
            <div><span>Target</span><b>{lv.tp ?? NA}</b></div>
            <div><span>Quantity</span><b>{lv.qty}</b></div>
            <div><span>Dollar-risk target</span><b>{money(lv.risk)}</b></div>
            <div><span>Estimated stop risk</span><b>{f.stopRisk === null ? NA : money(f.stopRisk)}</b></div>
            <div><span>Reward : risk</span><b>{f.rr === null ? NA : f.rr.toFixed(2)}</b></div>
            {lv.kind === "pending" ? <div><span>Distance to limit</span><b>{f.toLimit === null ? NA : f.toLimit.toFixed(2)}</b></div> : null}
            {lv.kind === "position" ? <div><span>Gross unrealized (est., last close)</span><b>{f.gross === null ? NA : signedMoney(f.gross)}</b></div> : null}
            {lv.kind === "position" ? <div><span>Net unrealized (est. after fees)</span><b>{f.estNet === null ? NA : signedMoney(f.estNet)}</b></div> : null}
            <div><span>At target (gross)</span><b>{f.atTarget === null ? NA : signedMoney(f.atTarget)}</b></div>
          </div>
          <p className="sizing-note">{lv.tradeId ? `Trade ${lv.tradeId} · opened ${stamp(lv.openedAt!)} · ` : ""}Unrealized figures are estimates at the last completed candle, not realized profit. A stop does not guarantee the loss (gaps, fees).</p>
        </section>
      ) : bot ? <p className="sizing-note">{bot.name} has no pending order or open position right now.</p> : null}
      <p className="sizing-note">Charts by <a className="link" href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a></p>
    </div>
  );
}

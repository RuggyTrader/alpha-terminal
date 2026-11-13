import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { fetchBacktest } from "../api";
import { engineTone } from "../classify";
import { AlphaGlobe } from "../components/AlphaGlobe";
import { EngineBotCard } from "../components/EngineBotCard";
import { MarketsCard, SystemHealthCard } from "../components/SystemHealth";
import { MirrorLinkCard } from "./Mirror";
import { EmptyState, SectionHeader, StatusBadge } from "../components/ui";
import { candleAgeSeconds } from "../health";
import { money, NA, price, stamp, when } from "../fmt";
import { useFlash } from "../motion";
import type { BacktestResult } from "../simulator";
import { useDash } from "../store";

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  const flash = useFlash(v);
  return (
    <div className={`eng-stat ${flash}`}>
      <span>{k}</span>
      <b key={v} className={`m-crossfade ${tone ? `t-${tone}` : ""}`}>{v}</b>
    </div>
  );
}

const BOT_TONE = { ONLINE: "ok", STALE: "warn", OFFLINE: "bad", NOT_RUNNING: "muted" } as const;

/** Readable names for the strategy inputs the engine reported with its verified backtest upload. */
const INPUT_LABELS: [string, string][] = [
  ["swingLen", "Swing length"], ["minLegATR", "Minimum leg (ATR)"], ["maxAge", "Maximum setup age (bars)"],
  ["entryMode", "Entry"], ["slMode", "Stop loss"], ["slBuf", "Stop buffer"], ["tp2Ext", "TP2 extension"],
  ["minScore", "Minimum PD-array score"], ["useFVG", "Fair value gaps"], ["useOB", "Order blocks"], ["useRB", "Rejection blocks"],
  ["allowLong", "Allow longs"], ["allowShort", "Allow shorts"], ["useBE", "Break-even"], ["beFrac", "Break-even at"],
  ["useTrail", "Trailing stop"], ["trailFrac", "Trail start"], ["useHours", "Trading hours"], ["weekendFlat", "Flat on weekends"], ["useSleep", "Sleep window"],
];
const show = (v: unknown) => (typeof v === "boolean" ? (v ? "On" : "Off") : v === null || v === undefined || v === "" ? NA : String(v));

type BtState = { status: "loading" | "ok" | "none" | "error"; cachedAt: string | null; result: BacktestResult | null };

function useBacktestInputs(): BtState {
  const [s, setS] = useState<BtState>({ status: "loading", cachedAt: null, result: null });
  useEffect(() => {
    let live = true;
    fetchBacktest("SOLUSD")
      .then((b) => { if (live) setS(b ? { status: "ok", cachedAt: b.cached_at, result: b.result } : { status: "none", cachedAt: null, result: null }); })
      .catch(() => { if (live) setS({ status: "error", cachedAt: null, result: null }); });
    return () => { live = false; };
  }, []);
  return s;
}

function Cmd({ label, cmd, children }: { label: string; cmd: string; children: ReactNode }) {
  return (
    <div className="ctl">
      <div className="ctl-h"><b>{label}</b><code className="code">{cmd}</code></div>
      <p>{children}</p>
    </div>
  );
}

export function EnginePage({ now = Date.now() }: { now?: number }) {
  const { state, reconnected } = useDash();
  const d = state.data;
  const bot = d?.bot ?? null;
  const s = bot?.status ?? null;
  const e = d?.engine ?? null;
  const c = d?.counts;
  const bt = useBacktestInputs();
  const lim = d?.portfolio?.limits ?? null;
  const risk = d?.portfolio?.strategies?.SOLUSD?.settings ?? null;
  const botState = bot ? bot.state : d ? "NOT_RUNNING" : null;
  const stateText = botState ? (botState === "NOT_RUNNING" ? "NOT RUNNING" : botState) : "N/A";
  const stateFlash = useFlash(botState);
  const age = candleAgeSeconds(d, now);

  return (
    <div className="page-narrow m-stagger">
      <h1 className="page-title">Engine</h1>
      <section className="engine-card" aria-label="Alpha engine">
        <AlphaGlobe className="engine-globe" tiltKey={botState ?? undefined} reconnected={reconnected} />
        <div className="eng-head">
          <div>
            <div className="hero-title">ALPHA ENGINE</div>
            <span className="hero-badge">PAPER EXECUTION</span>
          </div>
        </div>
        <div className="eng-state-label">OTE ENGINE · {s?.symbol ?? "SOLUSD"} {s?.timeframe ?? "5m"} · KRAKEN</div>
        <div className={`eng-state eng-${botState ? (BOT_TONE[botState as keyof typeof BOT_TONE] ?? "muted") : "muted"} ${stateFlash}`}>
          <span key={stateText} className="m-crossfade">● {stateText}</span>
        </div>
        <div className="eng-grid">
          <Stat k="LAST REPORT" v={bot?.age_seconds === null || bot?.age_seconds === undefined ? NA : `${bot.age_seconds}s ago`} tone={bot && bot.state !== "ONLINE" ? "warn" : undefined} />
          <Stat k="LAST CANDLE" v={s ? `${when(s.last_candle_time)} · ${price(s.last_candle_close)}` : NA} tone={age !== null && age > 720 ? "warn" : undefined} />
          <Stat k="LEDGER CHECK" v={s?.ledger_check?.status ?? NA} tone={s?.ledger_check?.status === "DIVERGED" ? "neg" : undefined} />
          <Stat k="LIVE TRADING" v={d ? (d.enable_trading || d.broker_submission ? "ON" : "OFF") : NA} tone={d?.enable_trading || d?.broker_submission ? "neg" : undefined} />
        </div>
      </section>

      <MirrorLinkCard />

      {d && (d.enable_trading || d.broker_submission || d.execution !== "DRY_RUN_ONLY") ? (
        <EmptyState title="Non-dry-run setting reported" tone="bad">Check the Worker configuration.</EmptyState>
      ) : null}

      <section aria-label="Simulation controls">
        <SectionHeader title="Simulation controls" sub="The engine runs on your Windows PC" />
        <div className="card ctl-card">
          <p className="ctl-intro">
            This browser session is read-only, so it cannot start or stop the engine. Use these commands in PowerShell from the
            <code className="code"> engine\deploy </code> folder. They affect only the PAPER simulation.
          </p>
          <Cmd label="Start at sign-in (install)" cmd="windows-task.ps1 install">Registers the sign-in task and starts one engine now.</Cmd>
          <Cmd label="Status" cmd="windows-task.ps1 status">Task, supervisor and engine state, last poll and ledger check.</Cmd>
          <Cmd label="Stop" cmd="windows-task.ps1 stop">Stops the engine until the next sign-in.</Cmd>
          <Cmd label="Resume" cmd="Start-ScheduledTask 'ALPHA TERMINAL Engine'">Starts it again without signing out.</Cmd>
          <div className="ctl-foot">
            Risk per trade is set on the website: <Link className="link" to="/portfolio/SOLUSD">SOL strategy →</Link>{" "}
            · <Link className="link" to="/bots">Bots →</Link>
          </div>
        </div>
      </section>

      <section aria-label="Strategy settings">
        <SectionHeader title="OTE strategy settings" sub={s?.profile ? `Profile ${s.profile}` : undefined} />
        <div className="card list-card">
          <div className="li"><span>Risk per trade (engine reports)</span><b>{s?.risk_usd === null || s?.risk_usd === undefined ? NA : money(s.risk_usd)}</b></div>
          <div className="li">
            <span>Website setting</span>
            <b>{risk?.applied ? <>{money(risk.applied.risk_usd)} · v{risk.applied.version} <StatusBadge tone="ok">APPLIED</StatusBadge></> : NA}</b>
          </div>
          {risk?.pending ? <div className="li"><span>Pending</span><b>{money(risk.pending.risk_usd)} · v{risk.pending.version}</b></div> : null}
          {bt.status === "ok" && bt.result ? (
            <>
              {INPUT_LABELS.filter(([k]) => k in bt.result!.inputs).map(([k, label]) => (
                <div key={k} className="li"><span>{label}</span><b>{show(bt.result!.inputs[k])}</b></div>
              ))}
              <p className="li-note">
                Inputs reported with the verified backtest upload ({bt.result.profile}, {bt.result.config_hash}, uploaded {stamp(bt.cachedAt)}).
                The ALPHA PAPER ledger is long-only: short signals are refused.
              </p>
            </>
          ) : (
            <p className="li-note">{bt.status === "loading" ? "Loading…" : "The engine has not uploaded its strategy inputs (no verified backtest), so only the risk setting is shown."}</p>
          )}
        </div>
      </section>

      <section aria-label="Monitoring">
        <SectionHeader title="Monitoring" />
        {bot ? <EngineBotCard bot={bot} /> : <EmptyState title="The engine has not reported" />}
      </section>

      <SystemHealthCard state={state} now={now} />
      <MarketsCard state={state} />

      <section aria-label="Risk protections">
        <SectionHeader title="Risk protections" sub="Enforced by the Worker on every signal" />
        <div className="card list-card">
          <div className="li"><span>Maximum order size</span><b>{lim?.max_order_notional_usd ? money(lim.max_order_notional_usd) : NA}</b></div>
          <div className="li"><span>Maximum position exposure</span><b>{lim?.max_position_exposure_usd ? money(lim.max_position_exposure_usd) : NA}</b></div>
          <div className="li"><span>Maximum total exposure</span><b>{lim?.max_total_exposure_usd ? money(lim.max_total_exposure_usd) : NA}</b></div>
          <div className="li"><span>Maximum open positions</span><b>{lim?.max_open_positions ?? NA}</b></div>
          <div className="li"><span>Daily loss limit</span><b>{lim?.daily_loss_limit_usd ? money(lim.daily_loss_limit_usd) : NA}</b></div>
          <div className="li"><span>Short selling</span><b>{lim ? (lim.short_selling_enabled ? "Enabled" : "Off (long-only)") : NA}</b></div>
          <div className="li li-wrap"><span>Balance check</span><b className="soft">Entries need enough PAPER capital in the strategy balance</b></div>
          <div className="li li-wrap"><span>Price freshness</span><b className="soft">No fill without a current Kraken price; a failed mark blocks new entries</b></div>
          <div className="li li-wrap"><span>Late signals</span><b className="soft">The engine never sends an entry after its delivery window</b></div>
          <div className="li li-wrap"><span>Duplicates</span><b className="soft">Each signal id applies once</b></div>
          {lim && lim.max_total_exposure_usd === undefined ? <p className="li-note">This backend does not report the remaining limits; they are still enforced.</p> : null}
        </div>
      </section>

      <section aria-label="Broker route">
        <SectionHeader title="Broker route" sub="Separate /webhook route for live orders: kept off" />
        <div className="card list-card">
          <div className="li"><span>State</span><b><StatusBadge tone={e ? engineTone(e.state) : "muted"}>{e ? e.state : NA}</StatusBadge></b></div>
          <div className="li"><span>Kill switch</span><b>{e ? (e.kill_switch ? "ENGAGED" : "OFF") : NA}</b></div>
          <div className="li"><span>ENABLE_TRADING</span><b className={d?.enable_trading ? "t-neg" : ""}>{d ? String(d.enable_trading).toUpperCase() : NA}</b></div>
          <div className="li"><span>Broker submission</span><b className={d?.broker_submission ? "t-neg" : ""}>{d ? (d.broker_submission ? "ON" : "OFF") : NA}</b></div>
          <div className="li"><span>Last change</span><b className="mono-s">{e ? stamp(e.updated_at) : NA}</b></div>
        </div>
      </section>

      <section aria-label="Pipeline totals">
        <SectionHeader title="Pipeline totals" right={<span className="muted-s">D1</span>} />
        {c ? (
          <div className="tiles">
            <div className="tile"><span>Signals</span><b>{c.alerts.total}</b><i>{c.alerts.dry_run} accepted · {c.alerts.rejected} rejected</i></div>
            <div className="tile"><span>Risk decisions</span><b>{c.risk.total}</b><i>{c.risk.approved} approved · {c.risk.rejected} rejected</i></div>
            <div className="tile"><span>Order intents</span><b>{c.orders.total}</b><i>dry run · none sent to broker</i></div>
            <div className="tile"><span>Duplicates</span><b>{c.alerts.duplicates}</b><i>blocked repeat signals</i></div>
          </div>
        ) : (
          <EmptyState title="No data" />
        )}
      </section>
    </div>
  );
}

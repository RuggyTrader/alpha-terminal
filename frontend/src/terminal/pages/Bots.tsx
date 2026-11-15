// Bots control center: the fleet grouped by cryptocurrency. Every number is the bot's own (its wallet, positions and
// ledger results) or its own latest engine report; the hypothetical Strategy Mirror is separate and labelled. Owner
// actions (fleet setup, allocate from MAIN, and the rarely needed per-bot risk / pause) need the passphrase and are recorded
// server-side. Normal operation needs no per-bot control: every approved bot runs automatically, LONG and SHORT.
// There is no long-only/short-only selector: every bot always evaluates both directions.

import { AssetLogo } from "../components/AssetLogo";
import { useState } from "react";
import { Link } from "react-router-dom";
import { newRequestId } from "../api";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { NA, level, money, signedMoney, stamp, tone } from "../fmt";
import {
  allocate, botPhase, engineStatus, fleetSetup, groupTotals, previewAllocation, setBotRisk, setEntriesPaused,
  type Bot, type Fleet,
} from "../bots";
import { invalidateFleet, useFleet } from "../fleetStore";
import { backendErrorMessage, humanReason } from "../tradeStory";

const pct = (v: number | null) => (v === null ? NA : `${(v * 100).toFixed(0)}%`);
const pf = (v: number | null) => (v === null ? NA : v.toFixed(2));

function Passphrase({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input className="input" type="password" autoComplete="current-password" placeholder="Passphrase" aria-label="Passphrase" value={value} onChange={(e) => onChange(e.target.value)} />;
}

function RiskEditor({ b, onDone }: { b: Bot; onDone: () => void }) {
  const [v, setV] = useState(String(b.risk_usd));
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const n = Number(v);
    if (!(n >= 0.01) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) { setMsg("Enter a dollar amount in cents, at least $0.01."); return; }
    setBusy(true);
    try {
      const r = await setBotRisk(b.bot_id, n, newRequestId(), pass);
      setMsg(r.ok ? `Saved as version ${String(r.version)}: pending until ${b.name}'s engine confirms it. New orders only.` : backendErrorMessage(r));
      if (r.ok) { setPass(""); onDone(); }
    } catch (e) { setMsg(backendErrorMessage(e)); } finally { setBusy(false); }
  };
  const s = b.risk_setting;
  return (
    <div className="bot-risk" aria-label={`${b.name} risk per trade`}>
      <label>Risk per trade (USD $)
        <input className="input" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} aria-label={`${b.name} risk per trade in dollars`} />
      </label>
      <Passphrase value={pass} onChange={setPass} />
      <button className="btn" disabled={busy || !pass} onClick={save}>Save</button>
      <p className="sizing-note">
        Applied: {money(b.risk_usd)}{s ? ` · latest request v${s.version} ${money(s.risk_usd)} ${s.status}${s.applied_at ? ` (confirmed ${stamp(s.applied_at)})` : ""}` : ""}.
        This bot only; open positions keep their recorded risk.
      </p>
      {msg ? <p className="sizing-note" role="status">{msg}</p> : null}
    </div>
  );
}

/** The exact transfers a fleet setup would make: each bot's wallet (cash + money in positions) topped up to the target. */
export function fleetSetupPlan(fleet: Fleet, target: number) {
  const bots = fleet.bots.filter((b) => b.status === "ACTIVE" || b.status === "PROPOSED");
  const rows = bots.map((b) => {
    const value = b.balances.available_usd + b.balances.reserved_usd;
    return { b, value, amount: Math.max(0, Math.round((target - value) * 1e6) / 1e6) };
  });
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const main = fleet.main?.available_usd ?? 0;
  return { rows, total, main, mainAfter: main - total, affordable: total <= main + 1e-9 };
}

/** One-time fleet setup: one passphrase activates every registered bot and funds each one from MAIN. Shown only while
 *  a bot still waits for it; afterwards the fleet runs on its own. */
function FleetSetup({ fleet, onDone }: { fleet: Fleet; onDone: () => void }) {
  const [target, setTarget] = useState("20");
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rid] = useState(newRequestId());
  const t = Number(target);
  const valid = t >= 1 && Math.abs(t * 100 - Math.round(t * 100)) < 1e-6;
  const plan = valid ? fleetSetupPlan(fleet, t) : null;
  const waiting = fleet.bots.filter((b) => b.status === "PROPOSED");
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await fleetSetup(t, rid, pass);
      setMsg(r.ok ? `Done: ${waiting.map((b) => b.name).join(", ")} active; ${money(Number(r.total_usd ?? 0))} moved from MAIN. The engine picks the new bots up automatically.` : backendErrorMessage(r));
      if (r.ok) { setPass(""); onDone(); }
    } catch (e) { setMsg(backendErrorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card" aria-label="Start the full fleet">
      <SectionHeader title="Start the full fleet" sub="One-time · one passphrase · then every bot runs on its own, LONG and SHORT" />
      <p className="sizing-note">Activates {waiting.map((b) => b.name).join(", ")} with their registered strategy profiles and tops every bot's PAPER wallet up to the same amount from MAIN. A transfer, never profit; nothing is deposited. All or nothing.</p>
      <div className="bot-alloc">
        <label>Each bot's wallet (USD $)
          <input className="input" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Wallet per bot in dollars" />
        </label>
      </div>
      {plan ? (
        <div className="bot-alloc-preview">
          {plan.rows.map((r) => <p key={r.b.bot_id} className="sizing-note">{r.b.name}: {money(r.value)} → {money(r.value + r.amount)}{r.amount > 0 ? ` (+${money(r.amount)})` : " (already there)"}{r.b.status === "PROPOSED" ? " · activated" : ""}</p>)}
          <p className="sizing-note">MAIN {money(plan.main)} → <b>{money(plan.mainAfter)}</b>{plan.affordable ? "" : " · not enough in MAIN: nothing would change"}</p>
          {plan.affordable ? <div className="bot-alloc"><Passphrase value={pass} onChange={setPass} /><button className="btn btn-primary" disabled={busy || !pass} onClick={confirm}>Start the fleet</button></div> : null}
        </div>
      ) : <p className="sizing-note t-warn">Enter a dollar amount in cents, at least $1.</p>}
      {msg ? <p className="sizing-note" role="status">{msg}</p> : null}
    </section>
  );
}

/** Rarely needed per-bot owner controls (risk target, pause new entries), kept out of normal operation. */
function BotOwnerControls({ b, onDone }: { b: Bot; onDone: () => void }) {
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const togglePause = async () => {
    try {
      const r = await setEntriesPaused(b.bot_id, !b.entries_paused, newRequestId(), pass);
      setMsg(r.ok ? (b.entries_paused ? "New entries resumed." : "New entries paused; the open position keeps its exits.") : backendErrorMessage(r));
      if (r.ok) { setPass(""); onDone(); }
    } catch (err) { setMsg(backendErrorMessage(err)); }
  };
  return (
    <div className="bot-settings" aria-label={`${b.name} owner controls`}>
      <b>{b.name}</b>
      <RiskEditor b={b} onDone={onDone} />
      <div className="bot-pause">
        <Passphrase value={pass} onChange={setPass} />
        <button className="btn" disabled={!pass} onClick={togglePause}>{b.entries_paused ? "Resume new entries" : "Pause new entries"}</button>
        <p className="sizing-note">Pausing stops NEW entries only; an open position keeps its stop, target and exit.</p>
        {msg ? <p className="sizing-note" role="status">{msg}</p> : null}
      </div>
    </div>
  );
}

export function BotCard({ b, nowMs, onChanged }: { b: Bot; nowMs: number; onChanged?: () => void }) {
  const phase = botPhase(b, nowMs);
  const e = b.engine;
  const st = e?.strategy_state ?? null;
  const last = e?.sizing?.last ?? null;
  void onChanged;
  const canChart = b.status !== "DISABLED"; // every bot: scanning, pending order, open position (real Kraken candles)
  const es = engineStatus(b, nowMs);
  return (
    <section className="card bot-card" aria-label={`${b.name} ${b.symbol} ${b.timeframe}`}>
      <div className="bot-h">
        <AssetLogo of={b.symbol} size={34} className="bot-ic" />
        <div>
          <b>{b.name} <span className="bot-id">{b.timeframe}</span></b>
          <span className="bot-sub">KRAKEN:{b.symbol}</span>
        </div>
        <StatusBadge tone={es.tone} dot>{es.label}</StatusBadge>
      </div>
      {b.status === "PROPOSED" ? <p className="sizing-note">Exact settings registered; it starts with the one-time fleet setup above. No activity is shown for it yet.</p> : null}
      <p className={`bot-phase ${phase.live ? "is-live" : ""}`}>{phase.phase}{phase.detail ? <span> · {phase.detail}</span> : null}</p>
      <div className="sizing-grid bot-key">
        <div><span>Last scan (candle, UTC)</span><b>{e?.last_candle_time ? `${e.last_candle_time.slice(5, 10)} ${e.last_candle_time.slice(11, 16)}` : NA}</b></div>
        <div><span>Allocated</span><b>{money(b.funding.allocated_usd + b.funding.transferred_in_usd)}</b></div>
        <div><span>Net PAPER P&amp;L</span><b className={`t-${tone(b.paper.net_usd)}`}>{signedMoney(b.paper.net_usd)}</b></div>
      </div>
      {b.status === "ACTIVE" ? (
        <p className="sizing-note">
          Next position: up to <b>{money(b.balances.available_usd)}</b> (its own wallet, no leverage) · risk target {money(b.risk_usd)}, capped by capital:
          actual risk ≈ position × stop distance (e.g. {money(b.balances.available_usd * 0.005)} at a 0.5% stop) · fees 0.20% per fill.
        </p>
      ) : null}
      {b.balances.shortfall_usd > 0 ? <p className="sizing-note t-bad">Recorded shortfall {money(b.balances.shortfall_usd)}: a loss beyond this bot's collateral and cash. Entries are paused; MAIN did not cover it.</p> : null}
      {canChart ? <Link className="btn btn-primary bot-chart-btn" to={`/bots/${b.bot_id}/chart`}>View chart</Link> : null}
      <details className="bot-details">
        <summary>Details</summary>
        <p className="sizing-note">{es.detail}</p>
        <div className="sizing-grid">
          <div><span>Last heartbeat</span><b>{e?.received_at ? stamp(e.received_at) : NA}</b></div>
          <div><span>Available</span><b>{money(b.balances.available_usd)}</b></div>
          <div><span>Reserved (cost / collateral)</span><b>{money(b.balances.reserved_usd)}</b></div>
          <div><span>Risk per trade</span><b>{money(b.risk_usd)}</b></div>
          <div><span>Gross P&amp;L</span><b className={`t-${tone(b.paper.gross_usd)}`}>{signedMoney(b.paper.gross_usd)}</b></div>
          <div><span>Fees</span><b>{money(b.paper.fees_usd)}</b></div>
          <div><span>Net profit to MAIN</span><b>{money(b.funding.profit_swept_to_main_usd)}</b></div>
          <div><span>Trades · win rate · PF</span><b>{b.paper.trades} · {pct(b.paper.win_rate)} · {pf(b.paper.profit_factor)}</b></div>
          <div><span>Max drawdown</span><b>{money(b.paper.max_drawdown_usd)}</b></div>
        </div>
        {st?.pending_order ? (
          <p className="sizing-note">Pending {st.pending_order.side} limit {level(st.pending_order.limit, b.symbol)} · stop {level(st.pending_order.stop, b.symbol)} · target {level(st.pending_order.tp, b.symbol)} · qty {st.pending_order.qty}</p>
        ) : null}
        {b.open_positions.map((p) => (
          <p key={p.trade_id} className="sizing-note">
            Open PAPER {p.side} {p.qty} @ {p.entry_price}{p.stop !== null ? ` · stop ${p.stop}` : ""}{p.tp !== null ? ` · target ${p.tp}` : ""} · {money(p.collateral_usd)} {p.side === "SHORT" ? "collateral (simulated short)" : "cost"} · last recorded mark {p.mark_price ?? NA} · {p.mark_at ? stamp(p.mark_at) : "mark unavailable"}{!p.mark_at || nowMs - Date.parse(p.mark_at) > 120000 ? " · STALE / UNAVAILABLE" : ""}
          </p>
        ))}
        {last && last.code && humanReason(last.code, { available: b.balances.available_usd, cost: last.notional_usd ?? null, unit: b.symbol.replace("USD", "") }) ? (
          <p className="sizing-note t-warn">{humanReason(last.code, { available: b.balances.available_usd, cost: last.notional_usd ?? null, unit: b.symbol.replace("USD", "") })}</p>
        ) : null}
        {last && last.status ? (
          <p className="sizing-note">Last sizing: {last.status}{last.code ? ` (${last.code})` : ""}{last.qty ? ` · qty ${last.qty}` : ""}{last.risk_actual_usd !== null && last.risk_actual_usd !== undefined ? ` · stop risk ${money(last.risk_actual_usd)}` : ""}{last.notional_usd ? ` · notional ${money(last.notional_usd)}` : ""}{last.explanation ? ` · ${last.explanation}` : ""}</p>
        ) : null}
        {e?.last_error?.message ? <p className="sizing-note t-warn">Last error: {e.last_error.message}</p> : null}
        <p className="sizing-note">{b.bot_id} · profile {b.profile ?? NA} · config {b.inputs_hash ?? NA} · wallet {b.wallet} · {b.ledger_api === "legacy" ? "LONG only until its one-time upgrade" : "LONG + SHORT (the strategy chooses the direction; SHORTs fully collateralised)"}</p>
      </details>
      <div className="bot-actions">
        <Link className="btn btn-ghost" to={`/trades?bot=${b.bot_id}`}>Trades</Link>
        <Link className="btn btn-ghost" to={`/performance?bot=${b.bot_id}`}>Performance</Link>
      </div>
    </section>
  );
}

function AllocationPanel({ fleet, onDone }: { fleet: Fleet; onDone: () => void }) {
  // Targets: a group (equal split between its active bots) or ONE active bot (exact amount, e.g. reinvesting MAIN's profit).
  const groups = [
    ...fleet.groups.filter((g) => fleet.bots.some((b) => b.group === g.group_id && b.status === "ACTIVE")).map((g) => ({ group_id: g.group_id, name: `${g.name} (equal split)` })),
    ...fleet.bots.filter((b) => b.status === "ACTIVE").map((b) => ({ group_id: b.bot_id, name: `${b.name} only` })),
  ];
  const [group, setGroup] = useState(groups[0]?.group_id ?? "");
  const [amount, setAmount] = useState("");
  const [pass, setPass] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewAllocation>>["data"] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [rid, setRid] = useState(newRequestId());
  const doPreview = async () => {
    const n = Number(amount);
    if (!(n > 0)) { setMsg("Enter an amount."); return; }
    const r = await previewAllocation(group, n);
    setPreview(r.ok ? r.data ?? null : null); setMsg(r.ok ? null : r.code ?? "Preview unavailable");
  };
  const confirm = async () => {
    const r = await allocate(group, Number(amount), rid, pass);
    setMsg(r.ok ? `Moved ${money(Number(amount))} from MAIN to ${group}${r.duplicate ? " (already done)" : ""}.` : backendErrorMessage(r));
    if (r.ok) { setPass(""); setPreview(null); setRid(newRequestId()); onDone(); }
  };
  if (!groups.length) return null;
  return (
    <section className="card" aria-label="Allocate from MAIN">
      <SectionHeader title="Allocate from MAIN" sub="To one bot, or split equally between a group's active bots · a transfer, never profit" />
      <div className="bot-alloc">
        <select className="input" value={group} onChange={(e) => { setGroup(e.target.value); setPreview(null); }} aria-label="Allocation target">
          {groups.map((g) => <option key={g.group_id} value={g.group_id}>{g.name}</option>)}
        </select>
        <input className="input" inputMode="decimal" placeholder="Amount (USD)" value={amount} onChange={(e) => { setAmount(e.target.value); setPreview(null); }} aria-label="Amount in dollars" />
        <button className="btn btn-ghost" onClick={doPreview}>Preview</button>
      </div>
      {preview ? (
        <div className="bot-alloc-preview">
          <p className="sizing-note">MAIN available {money(preview.main_available_usd)}{preview.affordable ? "" : " · not enough: nothing would move"}</p>
          {preview.split.map((s) => <p key={s.bot_id} className="sizing-note">{s.bot_id} ({s.wallet}) receives {money(s.amount_usd)}</p>)}
          {preview.affordable ? <div className="bot-alloc"><Passphrase value={pass} onChange={setPass} /><button className="btn" disabled={!pass} onClick={confirm}>Confirm transfer</button></div> : null}
        </div>
      ) : null}
      {msg ? <p className="sizing-note" role="status">{msg}</p> : null}
    </section>
  );
}

export function BotsPage() {
  // The shared fleet snapshot (fleetStore.ts): one poller for every view; owner actions invalidate it.
  const { fleet, error: fetchError, fetchedAt, stale } = useFleet();
  const error = fleet ? null : fetchError;
  const now = fetchedAt ?? Date.now();
  const load = () => void invalidateFleet();
  // Owner's order: SOLANA (ALPHA-01 1m, ALPHA-02 5m), then BITCOIN (ALPHA-03 1m, ALPHA-04 5m).
  const GROUP_ORDER = ["SOLANA", "BITCOIN"];
  const rank = (id: string) => { const i = GROUP_ORDER.indexOf(id); return i < 0 ? GROUP_ORDER.length : i; };
  const groups = (fleet?.groups.filter((g) => fleet.bots.some((b) => b.group === g.group_id && b.status !== "DISABLED")) ?? []).sort((a, b) => rank(a.group_id) - rank(b.group_id));
  return (
    <div className="page-narrow m-stagger bots-page">
      <SectionHeader title="Bots" sub="One strategy per market and timeframe, each with its own PAPER wallet." />
      {error ? <EmptyState title="Bots unavailable" tone="bad">{error}</EmptyState> : null}
      {!fleet && !error ? <SkeletonCards count={2} /> : null}
      {stale && fetchedAt ? <p className="sizing-note t-warn" role="status">STALE · showing the snapshot from {new Date(fetchedAt).toLocaleTimeString()} ({Math.round((Date.now() - fetchedAt) / 1000)} s old); the latest refresh failed: {fetchError}</p> : null}
      {fleet && !fleet.available ? <EmptyState title="No bot registry yet">The ledger has no bot registry (migration 0007 is not applied).</EmptyState> : null}
      {fleet?.available ? (
        <>
          {fleet.bots.some((b) => b.status === "PROPOSED") ? <FleetSetup fleet={fleet} onDone={load} /> : null}
          {groups.map((g) => {
            const bots = fleet.bots.filter((b) => b.group === g.group_id && b.status !== "DISABLED").sort((a, b) => a.bot_id.localeCompare(b.bot_id));
            const t = groupTotals(bots);
            return (
              <section key={g.group_id} className="bot-group" aria-label={`${g.name} bots`}>
                <SectionHeader icon={<AssetLogo of={g.symbol} size={22} />} title={g.name.toUpperCase()} sub={`${bots.length} bots · net PAPER ${signedMoney(t.net_usd)} · available ${money(t.available_usd)} · in positions ${money(t.reserved_usd)}`} />
                {bots.map((b) => <BotCard key={b.bot_id} b={b} nowMs={now} onChanged={load} />)}
              </section>
            );
          })}
          <details className="bot-details"><summary>Allocate capital from MAIN</summary><AllocationPanel fleet={fleet} onDone={load} /></details>
          {fleet.bots.some((b) => b.status === "ACTIVE") ? (
            <details className="bot-details">
              <summary>Advanced owner controls (not needed for normal operation)</summary>
              <p className="sizing-note">Every bot runs automatically. These are rarely needed: a per-bot risk target, or pausing one bot's NEW entries. The emergency stop for everything is in Settings.</p>
              {fleet.bots.filter((b) => b.status === "ACTIVE").map((b) => <BotOwnerControls key={b.bot_id} b={b} onDone={load} />)}
            </details>
          ) : null}
          <p className="sizing-note">PAPER figures are simulated: limit fills from completed Kraken candles, Ndax-equivalent 0.20% fee per fill, SHORTs fully collateralised from the bot's own wallet.</p>
        </>
      ) : null}
    </div>
  );
}

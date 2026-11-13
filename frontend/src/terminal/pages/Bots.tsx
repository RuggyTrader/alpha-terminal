// Bots control center: the fleet grouped by cryptocurrency. Every number is the bot's own (its wallet, positions and
// ledger results) or its own latest engine report; the hypothetical Strategy Mirror is separate and labelled. Owner
// actions (allocate from MAIN, dollar risk, pause/resume NEW entries) need the passphrase and are recorded server-side.
// There is no long-only/short-only selector: every bot always evaluates both directions.

import { useState } from "react";
import { Link } from "react-router-dom";
import { newRequestId } from "../api";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { money, NA, signedMoney, stamp, tone } from "../fmt";
import {
  allocate, botPhase, botState, groupTotals, previewAllocation, setBotRisk, setEntriesPaused, STATE_TONE,
  type Bot, type Fleet,
} from "../bots";
import { invalidateFleet, useFleet } from "../fleetStore";
import { humanReason } from "../tradeStory";

const pct = (v: number | null) => (v === null ? NA : `${(v * 100).toFixed(0)}%`);
const pf = (v: number | null) => (v === null ? NA : v.toFixed(2));
export const COIN: Record<string, { glyph: string; name: string }> = { SOLUSD: { glyph: "◎", name: "Solana" }, BTCUSD: { glyph: "₿", name: "Bitcoin" }, ETHUSD: { glyph: "Ξ", name: "Ethereum" } };

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
      setMsg(r.ok ? `Saved as version ${String(r.version)}: pending until ${b.name}'s engine confirms it. New orders only.` : `${r.code ?? "Refused"}: ${r.message ?? ""}`);
      if (r.ok) { setPass(""); onDone(); }
    } catch (e) { setMsg(String((e as Error).message)); } finally { setBusy(false); }
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

export function BotCard({ b, nowMs, onChanged }: { b: Bot; nowMs: number; onChanged?: () => void }) {
  const state = botState(b, nowMs);
  const phase = botPhase(b, nowMs);
  const e = b.engine;
  const st = e?.strategy_state ?? null;
  const last = e?.sizing?.last ?? null;
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const togglePause = async () => {
    try {
      const r = await setEntriesPaused(b.bot_id, !b.entries_paused, newRequestId(), pass);
      setMsg(r.ok ? (b.entries_paused ? "New entries resumed." : "New entries paused; the open position keeps its exits.") : `${r.code ?? "Refused"}: ${r.message ?? ""}`);
      if (r.ok) { setPass(""); onChanged?.(); }
    } catch (err) { setMsg(String((err as Error).message)); }
  };
  const canChart = b.status !== "DISABLED"; // every bot: scanning, pending order, open position (real Kraken candles)
  return (
    <section className="card bot-card" aria-label={`${b.name} ${b.symbol} ${b.timeframe}`}>
      <div className="bot-h">
        <span className="bot-ic" aria-hidden="true">{COIN[b.symbol]?.glyph ?? "α"}</span>
        <div>
          <b>{b.name} <span className="bot-id">{b.bot_id}</span></b>
          <span className="bot-sub">KRAKEN:{b.symbol} · {b.timeframe}{b.profile ? ` · ${b.profile}` : ""}</span>
        </div>
        <StatusBadge tone={STATE_TONE[state]} dot>{state.replace("_", " ")}</StatusBadge>
      </div>
      {b.status === "PROPOSED" ? <p className="sizing-note">Exact settings registered; not approved and not running. No activity is shown for it.</p> : null}
      <p className={`bot-phase ${phase.live ? "is-live" : ""}`}>{phase.phase}{phase.detail ? <span> · {phase.detail}</span> : null}</p>
      <div className="sizing-grid">
        <div><span>Latest candle</span><b>{e?.last_candle_time ? stamp(e.last_candle_time) : NA}</b></div>
        <div><span>Last update</span><b>{e?.received_at ? stamp(e.received_at) : NA}</b></div>
        <div><span>Available</span><b>{money(b.balances.available_usd)}</b></div>
        <div><span>Reserved (cost / collateral)</span><b>{money(b.balances.reserved_usd)}</b></div>
        <div><span>Allocated (total)</span><b>{money(b.funding.allocated_usd + b.funding.transferred_in_usd)}</b></div>
        <div><span>Risk per trade</span><b>{money(b.risk_usd)}</b></div>
        <div><span>Gross P&amp;L</span><b className={`t-${tone(b.paper.gross_usd)}`}>{signedMoney(b.paper.gross_usd)}</b></div>
        <div><span>Fees</span><b>{money(b.paper.fees_usd)}</b></div>
        <div><span>Net P&amp;L</span><b className={`t-${tone(b.paper.net_usd)}`}>{signedMoney(b.paper.net_usd)}</b></div>
        <div><span>Net profit to MAIN</span><b>{money(b.funding.profit_swept_to_main_usd)}</b></div>
        <div><span>Trades · win rate · PF</span><b>{b.paper.trades} · {pct(b.paper.win_rate)} · {pf(b.paper.profit_factor)}</b></div>
        <div><span>Max drawdown</span><b>{money(b.paper.max_drawdown_usd)}</b></div>
      </div>
      {st?.pending_order ? (
        <p className="sizing-note">Pending {st.pending_order.side} limit {st.pending_order.limit ?? NA} · stop {st.pending_order.stop ?? NA} · target {st.pending_order.tp ?? NA} · qty {st.pending_order.qty}</p>
      ) : null}
      {b.open_positions.map((p) => (
        <p key={p.trade_id} className="sizing-note">
          Open PAPER {p.side} {p.qty} @ {p.entry_price}{p.stop !== null ? ` · stop ${p.stop}` : ""}{p.tp !== null ? ` · target ${p.tp}` : ""} · {money(p.collateral_usd)} {p.side === "SHORT" ? "collateral (simulated short)" : "cost"} · {p.trade_id}
        </p>
      ))}
      {last && last.code && humanReason(last.code, { available: b.balances.available_usd, cost: last.notional_usd ?? null, unit: b.symbol.replace("USD", "") }) ? (
        <p className="sizing-note t-warn">{humanReason(last.code, { available: b.balances.available_usd, cost: last.notional_usd ?? null, unit: b.symbol.replace("USD", "") })}</p>
      ) : null}
      {last && last.status ? (
        <p className="sizing-note">Last sizing: {last.status}{last.code ? ` (${last.code})` : ""}{last.qty ? ` · qty ${last.qty}` : ""}{last.risk_actual_usd !== null && last.risk_actual_usd !== undefined ? ` · stop risk ${money(last.risk_actual_usd)}` : ""}{last.notional_usd ? ` · notional ${money(last.notional_usd)}` : ""}{last.explanation ? ` · ${last.explanation}` : ""}</p>
      ) : null}
      {b.balances.shortfall_usd > 0 ? <p className="sizing-note t-bad">Recorded shortfall {money(b.balances.shortfall_usd)}: a loss beyond this bot's collateral and cash. Entries are paused; MAIN did not cover it.</p> : null}
      {e?.last_error?.message ? <p className="sizing-note t-warn">Last error: {e.last_error.message}</p> : null}
      {b.mirror.map((m) => (
        <div key={m.account_id} className="bot-mirror" aria-label="Hypothetical Strategy Mirror">
          <b>Strategy Mirror (hypothetical, TradingView reference)</b>
          <p className="sizing-note">{m.trades} trades · gross {signedMoney(m.gross)} · modelled net after costs {signedMoney(m.net_modelled)} · never added to PAPER results</p>
        </div>
      ))}
      <div className="bot-actions">
        {canChart ? <Link className="btn" to={`/bots/${b.bot_id}/chart`}>View chart</Link> : null}
        <Link className="btn btn-ghost" to={`/trades?bot=${b.bot_id}`}>Trades</Link>
        <Link className="btn btn-ghost" to={`/performance?bot=${b.bot_id}`}>Performance</Link>
        {b.status === "ACTIVE" ? <button className="btn btn-ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Close settings" : "Settings"}</button> : null}
      </div>
      {open ? (
        <div className="bot-settings">
          <RiskEditor b={b} onDone={() => onChanged?.()} />
          <div className="bot-pause">
            <Passphrase value={pass} onChange={setPass} />
            <button className="btn" disabled={!pass} onClick={togglePause}>{b.entries_paused ? "Resume new entries" : "Pause new entries"}</button>
            <p className="sizing-note">Pausing stops NEW entries only; an open position keeps its stop, target and exit.</p>
            {msg ? <p className="sizing-note" role="status">{msg}</p> : null}
          </div>
          <p className="sizing-note">Profile {b.profile} · config {b.inputs_hash ?? NA} · wallet {b.wallet}{b.ledger_api === "legacy" ? " · legacy path (long-only until its approved switch)" : " · LONG and simulated SHORT"}</p>
        </div>
      ) : null}
    </section>
  );
}

function AllocationPanel({ fleet, onDone }: { fleet: Fleet; onDone: () => void }) {
  const groups = fleet.groups.filter((g) => fleet.bots.some((b) => b.group === g.group_id && b.status === "ACTIVE"));
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
    setMsg(r.ok ? `Moved ${money(Number(amount))} from MAIN to ${group}${r.duplicate ? " (already done)" : ""}.` : `${r.code ?? "Refused"}: ${r.message ?? ""}`);
    if (r.ok) { setPass(""); setPreview(null); setRid(newRequestId()); onDone(); }
  };
  if (!groups.length) return null;
  return (
    <section className="card" aria-label="Allocate from MAIN">
      <SectionHeader title="Allocate from MAIN" sub="Split equally between the group's active bots, to the cent" />
      <div className="bot-alloc">
        <select className="input" value={group} onChange={(e) => { setGroup(e.target.value); setPreview(null); }} aria-label="Cryptocurrency group">
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
  const groups = fleet?.groups.filter((g) => fleet.bots.some((b) => b.group === g.group_id && b.status !== "DISABLED")) ?? [];
  return (
    <div className="page-narrow m-stagger bots-page">
      <SectionHeader title="Bots" sub={<>Independent strategy instances, one market and timeframe each. <Link className="link" to="/engine">Engine →</Link></>} />
      {error ? <EmptyState title="Bots unavailable" tone="bad">{error}</EmptyState> : null}
      {!fleet && !error ? <SkeletonCards count={2} /> : null}
      {stale && fetchedAt ? <p className="sizing-note t-warn" role="status">STALE · showing the snapshot from {new Date(fetchedAt).toLocaleTimeString()} ({Math.round((Date.now() - fetchedAt) / 1000)} s old); the latest refresh failed: {fetchError}</p> : null}
      {fleet && !fleet.available ? <EmptyState title="No bot registry yet">The ledger has no bot registry (migration 0007 is not applied).</EmptyState> : null}
      {fleet?.available ? (
        <>
          <AllocationPanel fleet={fleet} onDone={load} />
          {groups.map((g) => {
            const bots = fleet.bots.filter((b) => b.group === g.group_id && b.status !== "DISABLED");
            const t = groupTotals(bots);
            return (
              <section key={g.group_id} className="bot-group" aria-label={`${g.name} bots`}>
                <SectionHeader title={`${COIN[g.symbol]?.glyph ?? ""} ${g.name.toUpperCase()}`} sub={`${bots.length} bots · funded PAPER: available ${money(t.available_usd)} · reserved ${money(t.reserved_usd)} · net ${signedMoney(t.net_usd)} (fees ${money(t.fees_usd)}) · to MAIN ${money(t.swept_usd)}`} />
                {bots.map((b) => <BotCard key={b.bot_id} b={b} nowMs={now} onChanged={load} />)}
              </section>
            );
          })}
          <p className="sizing-note">Funded PAPER figures are simulated (Kraken reference prices, Ndax-equivalent 0.20% fee per fill, simulated shorts fully collateralised). Strategy Mirror figures are hypothetical and never added.</p>
        </>
      ) : null}
    </div>
  );
}

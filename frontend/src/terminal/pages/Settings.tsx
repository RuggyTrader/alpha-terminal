// Settings: six sections, in the owner's order.
//   1 Account & wallets   2 Bots & risk   3 Notifications   4 Appearance   5 Security   6 Advanced
// Editable values say so and link to where they are changed (with the passphrase); everything else is read-only.
// Broker configuration, infrastructure and diagnostics live under Advanced. No credential is ever shown.

import { AssetLogo } from "../components/AssetLogo";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../../components/icons";
import { engineStatus } from "../bots";
import { connectionLabel } from "../classify";
import { clock, costMoney, money, NA, signedMoney, stamp } from "../fmt";
import { candleAgeSeconds, markets } from "../health";
import { useFleet } from "../fleetStore";
import { StatusBadge } from "../components/ui";
import { useDash } from "../store";
import { PAPER_FILL_DISCLOSURE } from "../disclosures";
import { THEME_LABEL, THEME_PREFS, useThemePref } from "../theme";
import { NotificationSettings } from "../components/NotificationSettings";

function Group({ n, title, sub, children }: { n: number; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="sg" aria-label={title}>
      <h2 className="sg-t"><span className="sg-n">{n}</span>{title}</h2>
      {sub ? <p className="sg-sub">{sub}</p> : null}
      <div className="card sg-card">{children}</div>
    </section>
  );
}

function Row({ k, children, edit }: { k: string; children: ReactNode; edit?: boolean }) {
  return (
    <div className="li">
      <span>{k}{edit ? <i className="sg-edit"> · editable</i> : null}</span>
      <b>{children}</b>
    </div>
  );
}

/** A collapsed advanced block: closed by default so the page stays short. */
function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="sg-fold">
      <summary>{title}</summary>
      <div className="sg-fold-in">{children}</div>
    </details>
  );
}

function AppearanceGroup() {
  const [pref, setPref] = useThemePref();
  const idx = THEME_PREFS.indexOf(pref);
  return (
    <section className="sg" aria-label="Appearance">
      <h2 className="sg-t"><span className="sg-n">4</span>Appearance</h2>
      <p className="sg-sub">Stored on this device. System follows your phone's light or dark setting.</p>
      <div className="seg" role="radiogroup" aria-label="Theme" style={{ ["--i" as string]: idx, ["--n" as string]: THEME_PREFS.length }}>
        <span className="seg-pill" aria-hidden />
        {THEME_PREFS.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={pref === t} className={`m-press${pref === t ? " on" : ""}`} onClick={() => setPref(t)}>{THEME_LABEL[t]}</button>
        ))}
      </div>
    </section>
  );
}

export function SettingsPage({ now = Date.now() }: { now?: number }) {
  const { state, signOut, doSignOut } = useDash();
  const { fleet } = useFleet();
  const d = state.data;
  const p = d?.portfolio ?? null;
  const t = p?.totals ?? null;
  const a = d?.broker.account ?? null;
  const acctErr = d?.broker.errors.find((e) => e.source === "account");
  const conn = connectionLabel(state);
  const lim = p?.limits ?? null;
  const age = candleAgeSeconds(d, now);
  const mk = markets(d, now);
  const bots = fleet?.available ? fleet.bots.filter((b) => b.status !== "DISABLED") : [];

  return (
    <div className="page-narrow m-stagger">
      <h1 className="page-title">Settings</h1>

      <Group n={1} title="Account & wallets" sub="Simulated PAPER money: not cash, cannot be withdrawn.">
        <Row k="Account">ALPHA PAPER (internal ledger)</Row>
        <Row k="Account equity">{t ? money(t.book_balance_usd) : NA}</Row>
        {fleet?.available && fleet.main ? <Row k="MAIN wallet (unallocated)">{money(fleet.main.available_usd)}</Row> : null}
        {bots.filter((b) => b.ledger_api === "bot" || b.status === "ACTIVE").map((b) => (
          <div key={b.bot_id} className="li"><span><AssetLogo of={b.symbol} size={16} className="inline-logo" />{b.name} wallet</span><b>{money(b.balances.available_usd + b.balances.reserved_usd)}</b></div>
        ))}
        <Row k="Net realized P&L">{t ? signedMoney(t.net_realized_pnl_usd ?? t.realized_pnl_usd) : NA}</Row>
        <div className="li"><span>Add PAPER capital, allocate to bots, history<i className="sg-edit"> · editable</i></span><Link className="link" to="/portfolio">Wallets →</Link></div>
      </Group>

      <Group n={2} title="Bots & risk" sub="Each bot trades its own wallet. Dollar risk and pausing are changed on the bot (passphrase required).">
        {bots.length ? bots.map((b) => {
          const es = engineStatus(b, now);
          return (
            <div key={b.bot_id} className="li li-wrap">
              <span><AssetLogo of={b.symbol} size={16} className="inline-logo" /><b>{b.name}</b> · {b.symbol.replace(/USD$/, "")} {b.timeframe} · risk {money(b.risk_usd)}<i className="sg-edit"> · editable</i>
                {" · "}{b.ledger_api === "bot" ? "LONG + SHORT" : "LONG only (upgrade pending)"}</span>
              <StatusBadge tone={es.tone} dot>{es.label}</StatusBadge>
            </div>
          );
        }) : <Row k="Bots">{fleet ? "No bot registry on this backend (schema 6)" : NA}</Row>}
        <div className="li"><span>Edit dollar risk, pause or resume a bot</span><Link className="link" to="/bots">Bots →</Link></div>
        <Fold title="Account-wide protections (read-only, enforced by the Worker)">
          <Row k="Maximum order size">{lim?.max_order_notional_usd ? money(lim.max_order_notional_usd) : NA}</Row>
          <Row k="Maximum total exposure">{lim?.max_total_exposure_usd ? money(lim.max_total_exposure_usd) : NA}</Row>
          <Row k="Maximum open positions">{lim?.max_open_positions ?? NA}</Row>
          <Row k="Daily loss limit">{lim?.daily_loss_limit_usd ? money(lim.daily_loss_limit_usd) : NA}</Row>
          <p className="li-note">Every order also needs enough capital in its own bot wallet; an oversized order is reduced to fit, and refused only if even the minimum size is unaffordable.</p>
        </Fold>
      </Group>

      <section className="sg" aria-label="Notifications">
        <h2 className="sg-t"><span className="sg-n">3</span>Notifications</h2>
        <NotificationSettings />
      </section>

      <AppearanceGroup />

      <Group n={5} title="Security">
        <Row k="This browser"><StatusBadge tone="ok">SIGNED IN</StatusBadge></Row>
        <Row k="Money actions">Need the passphrase again, every time</Row>
        <Row k="Secrets">Kept on the server only; never shown here</Row>
        <div className="li">
          <span>Sign out of this browser</span>
          <button type="button" className="btn btn-sm btn-ghost m-press" onClick={doSignOut} disabled={signOut.busy}>
            <Icon name="logout" size={15} /> {signOut.busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </Group>

      <Group n={6} title="Advanced" sub="Diagnostics, research and optional integrations. Nothing here is needed day to day.">
        <div className="li"><span>Engine diagnostics (host, supervisor, ledger check, health)</span><Link className="link" to="/engine">Engine →</Link></div>
        <div className="li"><span>Research: Strategy Mirror and hypothetical comparisons (never actual PAPER results)</span><Link className="link" to="/research">Research →</Link></div>
        <div className="li"><span>Research: MFFU funded-account simulator (SIMULATED; external execution DISABLED)</span><Link className="link" to="/research/mffu">MFFU research →</Link></div>
        <Fold title="Execution costs (read-only)">
          <Row k="Bot ledger fee model">Ndax-equivalent 0.20% per fill</Row>
          {!p ? <Row k="Legacy cost profile">{NA}</Row>
            : !p.costs ? <Row k="Legacy cost profile"><StatusBadge tone="muted">NOT AVAILABLE ON THIS WORKER</StatusBadge></Row>
            : p.costs.invalid ? <Row k="Legacy cost profile"><StatusBadge tone="bad">INVALID: {p.costs.profile ?? "unset"}</StatusBadge></Row>
            : (
              <>
                <Row k="Legacy cost profile">{p.costs.name}</Row>
                <Row k="Maker fee (inferred: limit entry, take-profit)">{p.costs.maker_pct}%</Row>
                <Row k="Taker fee (inferred: stops, time exits, market)">{p.costs.taker_pct}%</Row>
                <Row k="Taker slippage (estimate)">{p.costs.taker_slippage_pct}%</Row>
                <Row k="Fee source">{p.costs.fee_source}</Row>
                <Row k="Slippage source">{p.costs.slippage_source}</Row>
                {p.costs.caveat ? <p className="li-note">{p.costs.caveat}</p> : null}
              </>
            )}
          {t?.fees_usd !== undefined ? <Row k="Simulated fees paid">{costMoney(t.fees_usd)}</Row> : null}
          {t?.net_realized_pnl_usd !== undefined ? <Row k="Net realized ledger P&L">{signedMoney(t.net_realized_pnl_usd)}</Row> : null}
          {p ? <p className="li-note" data-testid="fill-disclosure">{p.costs?.fill_disclosure ?? PAPER_FILL_DISCLOSURE}</p> : null}
        </Fold>
        <Fold title="Market data and system">
          <Row k="Crypto · Kraken"><StatusBadge tone={mk[0].tone}>{mk[0].state}</StatusBadge></Row>
          <Row k="Stocks"><StatusBadge tone="muted">NOT CONFIGURED</StatusBadge></Row>
          <Row k="Backend"><StatusBadge tone={conn.tone} dot>{conn.text}</StatusBadge></Row>
          <Row k="Database (D1)">{d ? "Connected" : NA}</Row>
          <Row k="Legacy engine last candle">{age === null ? NA : `${Math.round(age / 60)} min after close`}</Row>
          <Row k="Mode">{d ? `${d.mode} · ${d.execution === "DRY_RUN_ONLY" ? "PAPER only" : d.execution}` : NA}</Row>
          <Row k="Real-money trading">{d ? (d.enable_trading || d.broker_submission ? <StatusBadge tone="bad">ON</StatusBadge> : "Disabled") : NA}</Row>
          <Row k="Last refresh"><span className="mono-s">{clock(state.lastSuccessAt)}</span></Row>
          <Row k="Snapshot"><span className="mono-s">{d ? stamp(d.generated_at) : NA}</span></Row>
        </Fold>
        <Fold title="Alpaca PAPER broker (optional) · not used by the strategies">
          <p className="li-note">A separate /webhook route to an Alpaca PAPER brokerage account. The strategy bots execute only in the internal PAPER ledger and never send orders here. Its state does not affect the strategy engine's status.</p>
          <Row k="Route state">{d?.engine ? `${d.engine.state}${d.engine.kill_switch ? " · kill switch engaged" : ""}` : NA}</Row>
          <Row k="Account">{!d ? NA : a ? `connected · equity ${money(a.equity)}` : acctErr?.code === "BROKER_NOT_CONFIGURED" ? "not configured" : acctErr?.code ?? "unavailable"}</Row>
        </Fold>
      </Group>
    </div>
  );
}

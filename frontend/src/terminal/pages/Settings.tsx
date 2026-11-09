import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../../components/icons";
import { connectionLabel } from "../classify";
import { clock, costMoney, money, NA, signedMoney, stamp } from "../fmt";
import { candleAgeSeconds, markets } from "../health";
import { StatusBadge } from "../components/ui";
import { useDash } from "../store";
import { PAPER_FILL_DISCLOSURE } from "../disclosures";

function Group({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="sg" aria-label={title}>
      <h2 className="sg-t">{title}</h2>
      {sub ? <p className="sg-sub">{sub}</p> : null}
      <div className="card sg-card">{children}</div>
    </section>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="li">
      <span>{k}</span>
      <b>{children}</b>
    </div>
  );
}

export function SettingsPage({ now = Date.now() }: { now?: number }) {
  const { state, signOut, doSignOut } = useDash();
  const d = state.data;
  const p = d?.portfolio ?? null;
  const t = p?.totals ?? null;
  const a = d?.broker.account ?? null;
  const acctErr = d?.broker.errors.find((e) => e.source === "account");
  const conn = connectionLabel(state);
  const mk = markets(d, now);
  const sol = p?.strategies?.SOLUSD?.settings ?? null;
  const lim = p?.limits ?? null;
  const age = candleAgeSeconds(d, now);

  return (
    <div className="page-narrow m-stagger">
      <h1 className="page-title">Settings</h1>

      <Group title="Simulated account" sub="ALPHA PAPER balances are simulated. They are not cash and cannot be withdrawn.">
        <Row k="Account"><StatusBadge tone="info">ALPHA PAPER</StatusBadge></Row>
        <Row k="Status">{p ? (p.active ? "Funded" : "Not funded") : NA}</Row>
        <Row k="PAPER capital added">{t ? money(t.net_funding_usd) : NA}</Row>
        <Row k="Book balance">{t ? money(t.book_balance_usd) : NA}</Row>
        <Row k={t?.fees_usd !== undefined ? "Realized ledger P&L before fees" : "Realized ledger P&L"}>{t ? signedMoney(t.realized_pnl_usd) : NA}</Row>
        {t?.fees_usd !== undefined ? <Row k="Simulated fees paid">{costMoney(t.fees_usd)}</Row> : null}
        {t?.net_realized_pnl_usd !== undefined ? <Row k="Net realized ledger P&L">{signedMoney(t.net_realized_pnl_usd)}</Row> : null}
        <Row k="Open PAPER exposure">{t ? money(t.reserved_usd) : NA}</Row>
        <Row k="Unrealized P&L">{t ? (t.unrealized_pnl_usd === null ? NA : signedMoney(t.unrealized_pnl_usd)) : NA}</Row>
        <div className="li"><span>Fund, transfer, history</span><Link className="link" to="/portfolio">Portfolio →</Link></div>
      </Group>

      <Group title="Execution costs" sub="Simulated fees and slippage charged on every ALPHA PAPER fill. Set on the Worker (PAPER_COST_PROFILE); shown read-only.">
        {!p ? <Row k="Cost profile">{NA}</Row>
          : !p.costs ? <Row k="Cost profile"><StatusBadge tone="muted">NOT AVAILABLE ON THIS WORKER</StatusBadge></Row>
          : p.costs.invalid ? <Row k="Cost profile"><StatusBadge tone="bad">INVALID: {p.costs.profile ?? "unset"}</StatusBadge></Row>
          : (
            <>
              <Row k="Cost profile">{p.costs.name}</Row>
              <Row k="Maker fee (inferred: limit entry, take-profit)">{p.costs.maker_pct}%</Row>
              <Row k="Taker fee (inferred: stops, time exits, market)">{p.costs.taker_pct}%</Row>
              <Row k="Taker slippage (estimate)">{p.costs.taker_slippage_pct}%</Row>
              <Row k="Minimum order">{[p.costs.min_qty > 0 ? `${p.costs.min_qty} units` : null, p.costs.min_notional_usd > 0 ? money(p.costs.min_notional_usd) : null].filter(Boolean).join(" · ") || "None"}</Row>
              <Row k="Fee source">{p.costs.fee_source}</Row>
              <Row k="Slippage source">{p.costs.slippage_source}</Row>
              {p.costs.caveat ? <p className="li-note">{p.costs.caveat}</p> : null}
            </>
          )}
        {p ? <p className="li-note" data-testid="fill-disclosure">{p.costs?.fill_disclosure ?? PAPER_FILL_DISCLOSURE}</p> : null}
      </Group>

      <Group title="Markets">
        {mk.map((m) => (
          <Row key={m.cls} k={`${m.cls === "CRYPTO" ? "Crypto" : "Stocks"} · ${m.provider === "None" ? "no provider" : m.provider}`}>
            <StatusBadge tone={m.tone}>{m.state}</StatusBadge>
          </Row>
        ))}
        <p className="li-note">Stocks stay NOT CONFIGURED until a supported stock data provider and strategy exist. No stock prices are shown anywhere.</p>
      </Group>

      <Group title="Strategies">
        <Row k="SOLUSD · OTE 5m">{p ? (p.validated_engines.includes("SOLUSD") ? <StatusBadge tone="ok">VALIDATED ENGINE</StatusBadge> : <StatusBadge tone="muted">NOT VALIDATED</StatusBadge>) : NA}</Row>
        <Row k="Risk per trade">{sol?.applied ? `${money(sol.applied.risk_usd)} · v${sol.applied.version} · ${sol.applied.status}` : NA}</Row>
        <div className="li"><span>Strategy settings and controls</span><Link className="link" to="/engine">Engine →</Link></div>
      </Group>

      <Group title="Risk" sub="Enforced by the Worker. Shown read-only; nothing here changes them.">
        <Row k="Maximum order size">{lim?.max_order_notional_usd ? money(lim.max_order_notional_usd) : NA}</Row>
        <Row k="Maximum position exposure">{lim?.max_position_exposure_usd ? money(lim.max_position_exposure_usd) : NA}</Row>
        <Row k="Maximum total exposure">{lim?.max_total_exposure_usd ? money(lim.max_total_exposure_usd) : NA}</Row>
        <Row k="Maximum open positions">{lim?.max_open_positions ?? NA}</Row>
        <Row k="Daily loss limit">{lim?.daily_loss_limit_usd ? money(lim.daily_loss_limit_usd) : NA}</Row>
        <Row k="Short selling">{lim ? (lim.short_selling_enabled ? "Enabled" : "Off (long-only)") : NA}</Row>
      </Group>

      <Group title="Market data">
        <Row k="Crypto · Kraken">
          <StatusBadge tone={mk[0].tone}>{mk[0].state}</StatusBadge>
        </Row>
        <Row k="Last completed candle">{age === null ? NA : `${Math.round(age / 60)} min after close`}</Row>
        <Row k="Ledger position marks">{d?.paper ? (d.paper.performance.marks_stale ? <StatusBadge tone="warn">STALE</StatusBadge> : d.paper.positions.length ? <StatusBadge tone="ok">FRESH</StatusBadge> : "No open positions") : NA}</Row>
        <Row k="Stocks"><StatusBadge tone="muted">NOT CONFIGURED</StatusBadge></Row>
      </Group>

      <Group title="Alpaca PAPER broker (optional)" sub="A separate brokerage PAPER account view. ALPHA PAPER does not use it.">
        <Row k="Status">
          {!d ? NA : a ? <StatusBadge tone="ok">CONNECTED</StatusBadge>
            : acctErr?.code === "BROKER_NOT_CONFIGURED" ? <StatusBadge tone="muted">NOT CONFIGURED</StatusBadge>
            : <StatusBadge tone="warn">{acctErr?.code ?? "UNAVAILABLE"}</StatusBadge>}
        </Row>
        {a ? (
          <>
            <Row k="Equity">{money(a.equity)}</Row>
            <Row k="Buying power">{money(a.buying_power)}</Row>
          </>
        ) : null}
      </Group>

      <Group title="Security">
        <Row k="Dashboard session"><StatusBadge tone="ok">AUTHENTICATED</StatusBadge></Row>
        <Row k="Session access">Read-only; PAPER portfolio actions need the passphrase again</Row>
        <Row k="Credentials">Server-side only (HttpOnly session cookie)</Row>
        <div className="li">
          <span>Sign out of this browser</span>
          <button type="button" className="btn btn-sm btn-ghost m-press" onClick={doSignOut} disabled={signOut.busy}>
            <Icon name="logout" size={15} /> {signOut.busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </Group>

      <Group title="System">
        <Row k="Backend"><StatusBadge tone={conn.tone} dot>{conn.text}</StatusBadge></Row>
        <Row k="Database (D1)">{d ? <StatusBadge tone="ok">CONNECTED</StatusBadge> : <StatusBadge tone="muted">N/A</StatusBadge>}</Row>
        <Row k="Mode">{d ? `${d.mode} · ${d.execution === "DRY_RUN_ONLY" ? "DRY RUN" : d.execution}` : NA}</Row>
        <Row k="Live trading">{d ? (d.enable_trading || d.broker_submission ? <StatusBadge tone="bad">ON</StatusBadge> : <StatusBadge tone="muted">DISABLED</StatusBadge>) : NA}</Row>
        <Row k="Last refresh"><span className="mono-s">{clock(state.lastSuccessAt)}</span></Row>
        <Row k="Snapshot"><span className="mono-s">{d ? stamp(d.generated_at) : NA}</span></Row>
      </Group>
    </div>
  );
}

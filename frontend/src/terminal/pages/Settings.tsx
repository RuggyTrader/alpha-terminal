import type { ReactNode } from "react";
import { Icon } from "../../components/icons";
import { connectionLabel } from "../classify";
import { clock, money, stamp } from "../fmt";
import { StatusBadge } from "../components/ui";
import { useDash } from "../store";

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sg" aria-label={title}>
      <h2 className="sg-t">{title}</h2>
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

export function SettingsPage() {
  const { state, signOut, doSignOut } = useDash();
  const d = state.data;
  const a = d?.broker.account ?? null;
  const acctErr = d?.broker.errors.find((e) => e.source === "account");
  const clockErr = d?.broker.errors.find((e) => e.source === "clock");
  const conn = connectionLabel(state);
  const stocks = !d ? null : a ? "ok" : acctErr?.code === "BROKER_NOT_CONFIGURED" ? "nc" : "err";

  return (
    <div className="page-narrow m-stagger">
      <h1 className="page-title">Settings</h1>

      <Group title="Account">
        <Row k="Account"><StatusBadge tone="info">ALPACA PAPER</StatusBadge></Row>
        <Row k="Status">{a ? a.status || "N/A" : "N/A"}</Row>
        <Row k="Currency">{a ? a.currency : "N/A"}</Row>
        <Row k="Equity">{a ? money(a.equity) : "N/A"}</Row>
        <Row k="Buying power">{a ? money(a.buying_power) : "N/A"}</Row>
      </Group>

      <Group title="Markets">
        <Row k="Stocks · Alpaca PAPER">
          {stocks === "ok" ? <StatusBadge tone="ok">ACTIVE</StatusBadge>
            : stocks === "nc" ? <StatusBadge tone="muted">NOT CONFIGURED</StatusBadge>
            : stocks === "err" ? <StatusBadge tone="bad">UNAVAILABLE</StatusBadge>
            : <StatusBadge tone="muted">N/A</StatusBadge>}
        </Row>
        <Row k="Crypto"><StatusBadge tone="muted">NOT CONFIGURED</StatusBadge></Row>
      </Group>

      <Group title="Risk">
        <div className="li li-wrap">
          <span>Limits</span>
          <b className="soft">Enforced server-side by the PAPER risk engine. The dashboard API does not expose the configured values.</b>
        </div>
      </Group>

      <Group title="Security">
        <Row k="Dashboard session"><StatusBadge tone="ok">AUTHENTICATED</StatusBadge></Row>
        <Row k="Session access">Read-only; PAPER portfolio actions need the passphrase again</Row>
        <Row k="Admin controls">Server-side only</Row>
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
        <Row k="Market data">
          {!d ? <StatusBadge tone="muted">N/A</StatusBadge>
            : d.broker.clock ? <StatusBadge tone="ok">ALPACA PAPER</StatusBadge>
            : <StatusBadge tone="muted">{clockErr?.code === "BROKER_NOT_CONFIGURED" ? "NOT CONFIGURED" : "UNAVAILABLE"}</StatusBadge>}
        </Row>
        <Row k="Engine">{d?.engine ? d.engine.state : "N/A"}</Row>
        <Row k="Last refresh"><span className="mono-s">{clock(state.lastSuccessAt)}</span></Row>
        <Row k="Snapshot"><span className="mono-s">{d ? stamp(d.generated_at) : "N/A"}</span></Row>
      </Group>
    </div>
  );
}

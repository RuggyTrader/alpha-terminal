import { useState } from "react";
import { api } from "../api/client";
import { TopStatus } from "../components/AppShell";
import { ErrorState, LoadingRows, SettingsGroup, SRow, StatusBadge } from "../components/ui";
import { usePoll } from "../hooks/usePoll";
import { ago, dateTime, money, num, pct, signedMoney, tone } from "../lib/format";
import { useData } from "../store/DataProvider";

const onOff = (b: boolean | undefined) => (b === undefined ? "N/A" : b ? "Enabled" : "Disabled");

export function SettingsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const { settings, summary, engine } = useData();
  const session = usePoll(() => api.get<{ authenticated: boolean; method: string; expires_at: string | null }>("/auth/session"), 60000);
  const [copied, setCopied] = useState(false);
  const s = settings.data;
  const sm = summary.data;
  const a = sm?.account;
  const e = engine.data;

  return (
    <div>
      <TopStatus title="Settings" />
      <ErrorState error={settings.error} what="SETTINGS" />
      {!s ? <LoadingRows rows={8} /> : (
        <div className="two-col">
          <div className="col">
            <SettingsGroup title="PAPER ACCOUNT" footer="All balances are simulated by Alpaca PAPER. They are not money and cannot be withdrawn. Formulas: docs/CALCULATIONS.md.">
              <SRow k="Broker" v="Alpaca PAPER" />
              <SRow k="Account status" v={a?.available ? <StatusBadge status={a.status} /> : <StatusBadge status={s.broker.configured ? "UNAVAILABLE" : "NOT CONFIGURED"} />} />
              <SRow k="PAPER equity" v={money(a?.equity ?? null)} />
              <SRow k="PAPER buying power" v={money(a?.buying_power ?? null)} />
              <SRow k="Realized PAPER P&L" v={signedMoney(sm?.realized_pnl ?? null)} cls={tone(num(sm?.realized_pnl ?? null))} />
              <SRow k="Unrealized PAPER P&L" v={signedMoney(sm?.unrealized_pnl ?? null)} cls={tone(num(sm?.unrealized_pnl ?? null))} />
              <SRow k="Total PAPER P&L" v={signedMoney(sm?.total_pnl ?? null)} cls={tone(num(sm?.total_pnl ?? null))} />
              <SRow k="Today's PAPER P&L" v={signedMoney(a?.todays_pnl ?? null)} cls={tone(num(a?.todays_pnl ?? null))} />
              <SRow k="Account return" v={pct(a?.account_return_pct ?? null)} cls={tone(num(a?.account_return_pct ?? null))} />
              <SRow k="Return baseline" v={a?.baseline_equity ? `${money(a.baseline_equity)} · ${a.baseline_source === "PAPER_STARTING_EQUITY" ? "configured" : "first connection"}` : "N/A"} />
              <SRow k="Open PAPER exposure" v={money(sm?.open_exposure ?? null)} />
              <SRow k="Open positions" v={sm?.open_positions ?? "N/A"} />
              <SRow k="Closed trades" v={sm ? sm.closed_trades : "N/A"} />
              <SRow k="Win rate" v={pct(sm?.win_rate_pct ?? null, false)} />
            </SettingsGroup>

            <SettingsGroup title="TRADINGVIEW">
              <SRow k="Webhook" v={<StatusBadge status={e?.health.components.webhook?.status ?? "N/A"} />} />
              <SRow k="Webhook URL" v={s.tradingview.webhook_url} mono />
              <SRow k="Webhook secret" v={s.tradingview.webhook_secret_configured ? "Configured · hidden" : "NOT CONFIGURED"} />
              <SRow k="Last alert received" v={e?.last_webhook_at ? `${dateTime(e.last_webhook_at)} · ${ago(e.last_webhook_at)}` : "Never"} />
              <SRow k="Last alert" v={e?.last_alert ? `${(e.last_alert.action ?? "?").toUpperCase()} ${e.last_alert.symbol ?? ""} · ${e.last_alert.strategy ?? ""}` : "None"} />
              <SRow k="Last result" v={e?.last_alert ? <StatusBadge status={e.last_alert.status.toUpperCase()} /> : "N/A"} />
              {e?.last_alert?.rejection_reason && <SRow k="Rejection reason" v={e.last_alert.rejection_reason} cls="neg" />}
              <SRow k="Alerts received" v={e?.counters.alerts_received ?? "N/A"} />
              <SRow k="Accepted / rejected" v={e ? `${e.counters.alerts_accepted} / ${e.counters.alerts_rejected}` : "N/A"} />
              <SRow k="Duplicates blocked" v={e?.counters.duplicates_blocked ?? "N/A"} />
              <SRow k={copied ? "Copied" : "Copy webhook URL"} v="" onClick={async () => {
                try { await navigator.clipboard.writeText(s.tradingview.webhook_url); setCopied(true); } catch { setCopied(false); }
              }} />
            </SettingsGroup>

            <SettingsGroup title="MARKETS" footer="Crypto has no broker or data integration yet, so no crypto prices or positions are shown.">
              <SRow k="Stocks" v={<span>{s.markets.stocks.provider} · <StatusBadge status={s.markets.stocks.status} /></span>} />
              <SRow k="Crypto" v={<StatusBadge status="NOT CONFIGURED" />} />
            </SettingsGroup>
          </div>

          <div className="col">
            <SettingsGroup title="EXECUTION">
              <SRow k="Engine state" v={<StatusBadge status={e?.engine.state ?? "N/A"} />} />
              <SRow k="Order execution" v={onOff(s.execution.enable_trading)} cls={s.execution.enable_trading ? "pos" : "neg"} />
              <SRow k="Order types" v={s.execution.allowed_order_types.join(", ")} />
              <SRow k="Time in force" v={s.execution.time_in_force.join(", ")} />
              <SRow k="Short selling" v={onOff(s.execution.short_selling_enabled)} />
              <SRow k="Fractional qty" v={onOff(s.execution.fractional_qty_enabled)} />
              <SRow k="Last order" v={e?.last_order ? `${e.last_order.side.toUpperCase()} ${e.last_order.symbol} · ${e.last_order.status.toUpperCase()}` : "None"} />
              <SRow k="Kill switch" v={e ? (e.engine.kill_switch ? "ACTIVE" : "Off") : "N/A"} cls={e?.engine.kill_switch ? "neg" : ""} />
            </SettingsGroup>

            <SettingsGroup title="RISK" footer="Limits are server environment variables. Change them on the server and restart.">
              <SRow k="Max order quantity" v={s.risk.max_order_qty} />
              <SRow k="Max order notional" v={money(s.risk.max_order_notional)} />
              <SRow k="Max position exposure" v={money(s.risk.max_position_exposure)} />
              <SRow k="Max total exposure" v={money(s.risk.max_total_exposure)} />
              <SRow k="Max open positions" v={s.risk.max_open_positions} />
              <SRow k="Short selling protection" v={s.risk.short_selling_protection ? "On" : "Off"} cls={s.risk.short_selling_protection ? "pos" : "neg"} />
              <SRow k="Duplicate protection" v={s.risk.duplicate_protection ? "On · persistent" : "Off"} cls="pos" />
              <SRow k="Allowed symbols" v={s.risk.allowed_symbols.join(", ")} />
              <SRow k="Daily PAPER loss limit" v={s.risk.daily_loss_limit ? money(s.risk.daily_loss_limit) : "Disabled"} />
            </SettingsGroup>

            <SettingsGroup title="SECURITY">
              <SRow k="Session" v={session.data?.authenticated ? `Active · until ${dateTime(session.data.expires_at)}` : "N/A"} cls="pos" />
              <SRow k="Dashboard" v="Private · server session" />
              <SRow k="API protection" v={s.security.csrf_header_required ? "Session + CSRF header" : "Session"} />
              <SRow k="Secure cookie" v={s.security.cookie_secure ? "Yes" : "No (local dev)"} cls={s.security.cookie_secure ? "pos" : "neg"} />
              <SRow k="API docs" v={s.security.api_docs_enabled ? "Exposed" : "Disabled"} />
              <div className="pad">
                <button className="btn danger block small" onClick={async () => { try { await api.post("/auth/logout"); } finally { onSignedOut(); } }}>LOG OUT</button>
              </div>
            </SettingsGroup>

            <SettingsGroup title="SYSTEM">
              <SRow k="Version" v={s.system.version} />
              <SRow k="Mode" v="PAPER only" cls="pos" />
              <SRow k="Trading host" v={s.broker.trading_host} mono />
              <SRow k="Market data" v={s.broker.market_data_host} mono />
              <SRow k="Database" v={s.system.database.toUpperCase()} />
              <SRow k="Server started" v={dateTime(s.system.started_at)} />
              <SRow k="Order sync" v={`every ${s.system.order_sync_interval_seconds}s`} />
            </SettingsGroup>
          </div>
        </div>
      )}
    </div>
  );
}

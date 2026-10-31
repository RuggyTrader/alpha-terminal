import { money, signedMoney, tone } from "../fmt";
import type { BrokerSnapshot } from "../types";
import { Badge, Empty, Panel } from "./primitives";

const CARDS = [
  { key: "equity", label: "Equity" },
  { key: "cash", label: "Cash" },
  { key: "buying_power", label: "Buying power" },
  { key: "portfolio_value", label: "Portfolio value" },
  { key: "todays_pnl", label: "Today's P&L" },
  { key: "long_market_value", label: "Long market value" },
] as const;

export function AccountSummary({ broker, loading }: { broker: BrokerSnapshot | null; loading: boolean }) {
  const account = broker?.account ?? null;
  const err = broker?.errors.find((e) => e.source === "account");

  return (
    <Panel
      title="PAPER account"
      meta="Alpaca PAPER · read-only"
      right={account ? <Badge tone={account.status === "ACTIVE" ? "ok" : "warn"}>{account.status || "N/A"}</Badge> : null}
      className="tp-account"
    >
      <div className="tk-grid">
        {CARDS.map((c) => {
          const v = account ? account[c.key] : null;
          const isPnl = c.key === "todays_pnl";
          return (
            <div key={c.key} className={`tk${loading && !broker ? " tk-loading" : ""}`}>
              <span className="tk-l">{c.label}</span>
              <span className={`tk-v mono ${isPnl && account ? `t-${tone(v)}` : ""}`}>
                {account ? (isPnl ? signedMoney(v) : money(v)) : loading && !broker ? "" : "No data"}
              </span>
            </div>
          );
        })}
      </div>
      {!account && broker ? (
        <Empty tone="warn">
          PAPER account unavailable{err ? `: ${err.code} — ${err.message}` : ""}
        </Empty>
      ) : null}
      {account && (account.trading_blocked || account.account_blocked) ? (
        <Empty tone="warn">Alpaca reports this PAPER account as blocked.</Empty>
      ) : null}
    </Panel>
  );
}

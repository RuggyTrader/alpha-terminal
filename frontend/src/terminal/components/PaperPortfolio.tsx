import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../api/client";
import { newRequestId } from "../api";
import { money, NA, signedMoney, tone } from "../fmt";
import type { PaperPortfolio, PaperWallet } from "../types";
import { SectionHeader, StatusBadge } from "./ui";

export const WALLET_NAME: Record<string, string> = {
  MAIN: "Unallocated", SOLUSD: "SOL", ETHUSD: "ETH", BTCUSD: "BTC", HYPEUSD: "HYPE", KAITOUSD: "KAITO",
};
export const WALLET_COLOR: Record<string, string> = {
  MAIN: "#b8b1a6", SOLUSD: "#f2661b", ETHUSD: "#2f6fd6", BTCUSD: "#c96a12", HYPEUSD: "#12965a", KAITOUSD: "#8a4fd6",
};

/** Allocation donut: each balance's book value (available + reserved). Empty ring when nothing is funded. */
export function AllocationPie({ wallets, size = 132 }: { wallets: PaperWallet[]; size?: number }) {
  const parts = wallets.filter((w) => w.book_balance_usd > 0);
  const total = parts.reduce((s, w) => s + w.book_balance_usd, 0);
  const r = 15.915; // circumference 100
  let offset = 25;
  return (
    <svg className="pf-pie" viewBox="0 0 42 42" width={size} height={size} role="img"
      aria-label={total > 0 ? `Allocation: ${parts.map((w) => `${WALLET_NAME[w.wallet] ?? w.wallet} ${money(w.book_balance_usd)}`).join(", ")}` : "No PAPER capital allocated"}>
      <circle cx="21" cy="21" r={r} fill="none" stroke="var(--gray-soft)" strokeWidth="6" />
      {total > 0
        ? parts.map((w) => {
            const share = (w.book_balance_usd / total) * 100;
            const el = (
              <circle key={w.wallet} cx="21" cy="21" r={r} fill="none" stroke={WALLET_COLOR[w.wallet] ?? "#888"} strokeWidth="6"
                strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={offset} />
            );
            offset -= share;
            return el;
          })
        : null}
    </svg>
  );
}

export function AllocationLegend({ wallets }: { wallets: PaperWallet[] }) {
  const total = wallets.reduce((s, w) => s + w.book_balance_usd, 0);
  return (
    <ul className="pf-legend">
      {wallets.map((w) => (
        <li key={w.wallet}>
          <i style={{ background: WALLET_COLOR[w.wallet] ?? "#888" }} aria-hidden />
          <span>{WALLET_NAME[w.wallet] ?? w.wallet}</span>
          <b>{money(w.book_balance_usd)}</b>
          <em>{total > 0 ? `${((w.book_balance_usd / total) * 100).toFixed(0)}%` : NA}</em>
        </li>
      ))}
    </ul>
  );
}

/** Home card: total, unallocated, pie. Links to the portfolio page. */
export function PortfolioSummaryCard({ portfolio }: { portfolio: PaperPortfolio }) {
  const t = portfolio.totals;
  return (
    <section className="card pf-card" aria-label="ALPHA PAPER portfolio">
      <SectionHeader title="PAPER portfolio" sub="Simulated balances · not broker money" right={<Link className="link" to="/portfolio">Manage</Link>} />
      {!portfolio.consistency.ok ? <StatusBadge tone="bad">LEDGER CHECK FAILED</StatusBadge> : null}
      {!portfolio.active ? (
        <p className="muted-s">Not funded yet. Add PAPER capital on the portfolio page to start allocating.</p>
      ) : (
        <div className="pf-row">
          <AllocationPie wallets={portfolio.wallets} size={112} />
          <div className="pf-figs">
            <div><span>Book balance</span><b>{money(t.book_balance_usd)}</b></div>
            <div><span>Unallocated</span><b>{money(t.unallocated_usd)}</b></div>
            {t.fees_usd !== undefined ? (
              // Same net as the hero and the Funded PAPER tab: gross realized minus recorded fees.
              <div><span>Realized net P&amp;L</span><b className={`t-${tone(t.net_realized_pnl_usd ?? t.realized_pnl_usd - t.fees_usd)}`}>{signedMoney(t.net_realized_pnl_usd ?? t.realized_pnl_usd - t.fees_usd)}</b>
                <i className="pm-n">gross {signedMoney(t.realized_pnl_usd)} · fees {money(t.fees_usd)}</i></div>
            ) : <div><span>Realized P&amp;L</span><b className={`t-${tone(t.realized_pnl_usd)}`}>{signedMoney(t.realized_pnl_usd)}</b></div>}
          </div>
        </div>
      )}
    </section>
  );
}

/** Shared shell for an authenticated PAPER action: passphrase field, busy/error/success states. */
export function ActionForm({
  title, children, submitLabel, disabled, onSubmit, note,
}: {
  title: string;
  children: ReactNode;
  submitLabel: string;
  disabled?: boolean;
  note?: ReactNode;
  onSubmit: (requestId: string, passphrase: string) => Promise<{ duplicate?: boolean; message?: string }>;
}) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  // The last result stays until the user starts the next action (types the passphrase again).
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  // One id per intended action: a retry after a network error reuses it, so it can never apply twice.
  const [requestId, setRequestId] = useState(newRequestId);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || disabled || !pass) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await onSubmit(requestId, pass);
      setMsg({ tone: "good", text: r.duplicate ? "Already applied earlier; nothing changed." : r.message ?? "Done." });
      setPass("");
      setRequestId(newRequestId());
    } catch (err) {
      const e2 = err instanceof ApiError ? err : null;
      setMsg({ tone: "bad", text: e2 ? `${e2.code}: ${e2.message}` : "Request failed; nothing confirmed." });
      // A definite rejection gets a new id; a network failure keeps it so a retry is idempotent.
      if (e2 && e2.status !== 0) setRequestId(newRequestId());
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card pf-form" onSubmit={submit}>
      <b className="pf-form-t">{title}</b>
      {children}
      <label className="pf-field">
        <span>Passphrase (confirms this PAPER action)</span>
        <input type="password" autoComplete="current-password" value={pass} onChange={(e) => { setPass(e.target.value); setMsg(null); }} />
      </label>
      {note ? <p className="muted-s">{note}</p> : null}
      {msg ? <p className={`pf-msg pf-msg-${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>{msg.text}</p> : null}
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || disabled || !pass}>{busy ? "Working…" : submitLabel}</button>
    </form>
  );
}

/** Parses a cents amount typed by the user; null when invalid. */
export function parseUsd(v: string): number | null {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v.trim())) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

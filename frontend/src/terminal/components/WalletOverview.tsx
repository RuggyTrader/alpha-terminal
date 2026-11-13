// Home capital summary: where every PAPER dollar is, from the ledger's own wallets (GET /api/dashboard portfolio).
// A crypto group is the SUM of its bots' wallets (never extra money); MAIN is counted once; profit swept to MAIN is
// already inside MAIN's balance (it is not added again on top of trading P&L). Unrealized P&L is shown separately.

import { Link } from "react-router-dom";
import { money, NA, signedMoney, tone } from "../fmt";
import type { PaperPortfolio } from "../types";
import { SectionHeader } from "./ui";

/** Wallet → crypto group: the legacy per-market wallets and the bot wallets (engine/src/bots.mjs). */
export const WALLET_GROUP: Record<string, "SOL" | "BTC" | "ETH"> = {
  SOLUSD: "SOL", "ALPHA-01": "SOL", "ALPHA-02": "SOL", BTCUSD: "BTC", "ALPHA-03": "BTC", "ALPHA-04": "BTC", ETHUSD: "ETH",
};

export function walletSummary(p: PaperPortfolio) {
  const ws = p.wallets;
  const main = ws.find((w) => w.kind === "MAIN") ?? null;
  const group = (g: string) => ws.filter((w) => w.kind !== "MAIN" && WALLET_GROUP[w.wallet] === g);
  const sum = (list: typeof ws, f: (w: (typeof ws)[number]) => number) => list.reduce((s, w) => s + f(w), 0);
  const sol = group("SOL"), btc = group("BTC");
  const unreal = ws.some((w) => w.unrealized_pnl_usd !== null) ? sum(ws, (w) => w.unrealized_pnl_usd ?? 0) : null;
  return {
    total: p.totals.book_balance_usd, main: main?.available_usd ?? null, reserved: p.totals.reserved_usd,
    sol: sum(sol, (w) => w.book_balance_usd), solWallets: sol.length, btc: sum(btc, (w) => w.book_balance_usd), btcWallets: btc.length,
    unrealized: unreal, equity: unreal === null ? null : p.totals.book_balance_usd + unreal,
  };
}

export function WalletOverview({ portfolio }: { portfolio: PaperPortfolio }) {
  if (!portfolio.active) return (
    <section className="card hp-card" aria-label="Capital overview">
      <SectionHeader title="Capital" right={<Link className="link" to="/portfolio">Wallets →</Link>} />
      <p className="sizing-note">Not funded yet: no PAPER capital has been deposited. No balances are shown until there are real ledger entries.</p>
    </section>
  );
  const s = walletSummary(portfolio);
  return (
    <section className="card hp-card" aria-label="Capital overview">
      <SectionHeader title="Capital" sub="Simulated PAPER balances · not broker money" right={<Link className="link" to="/portfolio">Wallets →</Link>} />
      <div className="wallet-grid">
        <div><span>Total account (book)</span><b>{money(s.total)}</b>{s.equity !== null ? <i>equity incl. open P&amp;L {money(s.equity)}</i> : null}</div>
        <div><span>MAIN available</span><b>{s.main === null ? NA : money(s.main)}</b><i>includes profit transferred from bots</i></div>
        <div><span>SOL allocation</span><b>{money(s.sol)}</b><i>{s.solWallets} wallet{s.solWallets === 1 ? "" : "s"} · part of the total</i></div>
        <div><span>BTC allocation</span><b>{money(s.btc)}</b><i>{s.btcWallets} wallet{s.btcWallets === 1 ? "" : "s"} · part of the total</i></div>
        <div><span>Reserved in positions</span><b>{money(s.reserved)}</b></div>
        <div><span>Unrealized P&amp;L</span><b className={s.unrealized === null ? "" : `t-${tone(s.unrealized)}`}>{s.unrealized === null ? NA : signedMoney(s.unrealized)}</b></div>
      </div>
    </section>
  );
}

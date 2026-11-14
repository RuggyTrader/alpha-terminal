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

/** Open-position marks behind the unrealized P&L: how many, how old, and whether any is missing. */
export const MARK_STALE_SECONDS = 300;
export function markSummary(marks: { at: string | null }[], now: number) {
  const ages = marks.map((m) => (m.at && Number.isFinite(Date.parse(m.at)) ? Math.max(0, Math.round((now - Date.parse(m.at)) / 1000)) : null));
  const known = ages.filter((a): a is number => a !== null);
  const oldest = known.length ? Math.max(...known) : null;
  return { count: marks.length, missing: ages.length - known.length, oldestSeconds: oldest, stale: oldest !== null && oldest > MARK_STALE_SECONDS };
}
const ago = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

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
    unrealized: unreal,
    // The Worker's own equity (cash + reserved + recorded unrealized − unpaid shortfall), null when a mark is missing.
    // Older Workers without equity_usd: book + unrealized, as before.
    equity: p.totals.equity_usd !== undefined ? p.totals.equity_usd : unreal === null ? null : p.totals.book_balance_usd + unreal,
    shortfall: p.totals.shortfall_usd ?? 0,
    economicNet: p.totals.economic_net_realized_pnl_usd ?? null,
  };
}

export function WalletOverview({ portfolio, marks = [], now = Date.now() }: { portfolio: PaperPortfolio; marks?: { at: string | null }[]; now?: number }) {
  if (!portfolio.active) return (
    <section className="card hp-card" aria-label="Capital overview">
      <SectionHeader title="Capital" right={<Link className="link" to="/portfolio">Wallets →</Link>} />
      <p className="sizing-note">Not funded yet: no PAPER capital has been deposited. No balances are shown until there are real ledger entries.</p>
    </section>
  );
  const s = walletSummary(portfolio);
  const mk = markSummary(marks, now);
  return (
    <section className="card hp-card" aria-label="Capital overview">
      <SectionHeader title="Capital" sub="Simulated PAPER balances · not broker money" right={<Link className="link" to="/portfolio">Wallets →</Link>} />
      <div className="wallet-grid">
        <div><span>Account equity</span><b>{s.equity === null ? NA : money(s.equity)}</b>
          <i>{s.equity === null ? `unavailable: ${mk.missing || "a"} open position${mk.missing === 1 ? " has" : "s have"} no recorded price` : mk.count ? `incl. open P&L at recorded prices${mk.oldestSeconds !== null ? `, ${ago(mk.oldestSeconds)} old` : ""}` : "no open positions"}</i></div>
        <div><span>Cash + reserved (book)</span><b>{money(s.total)}</b><i>before open P&amp;L{s.shortfall > 0 ? " and unpaid shortfall" : ""}</i></div>
        <div><span>MAIN available</span><b>{s.main === null ? NA : money(s.main)}</b><i>includes profit transferred from bots</i></div>
        <div><span>SOL allocation</span><b>{money(s.sol)}</b><i>{s.solWallets} wallet{s.solWallets === 1 ? "" : "s"} · part of the total</i></div>
        <div><span>BTC allocation</span><b>{money(s.btc)}</b><i>{s.btcWallets} wallet{s.btcWallets === 1 ? "" : "s"} · part of the total</i></div>
        <div><span>Reserved in positions</span><b>{money(s.reserved)}</b></div>
        <div><span>Unrealized P&amp;L</span><b className={s.unrealized === null ? "" : `t-${tone(s.unrealized)}`}>{s.unrealized === null ? NA : signedMoney(s.unrealized)}</b>
          {mk.stale ? <i className="t-warn">STALE: recorded prices up to {ago(mk.oldestSeconds!)} old, not current</i> : null}</div>
        {s.shortfall > 0 ? <div><span>Unpaid shortfall</span><b className="t-bad">{money(s.shortfall)}</b><i>a loss a bot wallet could not pay; MAIN never covers it automatically</i></div> : null}
      </div>
    </section>
  );
}

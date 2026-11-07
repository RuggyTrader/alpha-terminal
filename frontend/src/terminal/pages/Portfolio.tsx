import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { fetchBacktest, paperApplyRisk, paperFund, paperTransfer } from "../api";
import { ActionForm, AllocationLegend, AllocationPie, parseUsd, WALLET_NAME } from "../components/PaperPortfolio";
import { EmptyState, SectionHeader, SkeletonCards, StatusBadge } from "../components/ui";
import { money, NA, signedMoney, stamp, tone } from "../fmt";
import { constrainedBacktest, rawBacktest, type BacktestResult, type SimStats } from "../simulator";
import { useDash } from "../store";
import type { PaperPortfolio, PaperWallet } from "../types";

const KIND_TEXT: Record<string, string> = {
  DEPOSIT: "PAPER funding added", WITHDRAW: "PAPER funding removed", TRANSFER_OUT: "Transfer out", TRANSFER_IN: "Transfer in",
  RESERVE: "Reserved for position", RELEASE: "Position released", REALIZED_PNL: "Realized P&L",
};

function usePortfolio(): { p: PaperPortfolio | null; loading: boolean } {
  const { state } = useDash();
  return { p: state.data?.portfolio ?? null, loading: state.status === "loading" && !state.data };
}

function WalletRow({ w }: { w: PaperWallet }) {
  const inner = (
    <>
      <span className="pf-w-name">{WALLET_NAME[w.wallet] ?? w.wallet}{w.kind === "MAIN" ? null : <em> {w.wallet}</em>}</span>
      <span className="pf-w-nums">
        <b>{money(w.book_balance_usd)}</b>
        <i>{money(w.available_usd)} available{w.reserved_usd > 0 ? ` · ${money(w.reserved_usd)} reserved` : ""}</i>
      </span>
    </>
  );
  return w.kind === "STRATEGY" ? <Link className="pf-w m-press" to={`/portfolio/${w.wallet}`}>{inner}</Link> : <div className="pf-w">{inner}</div>;
}

export function PortfolioPage() {
  const { refresh } = useDash();
  const { p, loading } = usePortfolio();
  const [fundAmt, setFundAmt] = useState("");
  const [fundAction, setFundAction] = useState<"deposit" | "withdraw">("deposit");
  const [from, setFrom] = useState("MAIN");
  const [to, setTo] = useState("SOLUSD");
  const [amt, setAmt] = useState("");
  if (!p) {
    return (
      <div className="page-narrow">
        <h1 className="page-title">PAPER portfolio</h1>
        {loading ? <SkeletonCards count={2} tall /> : <EmptyState title="Portfolio unavailable" tone="warn">This Worker does not report the PAPER portfolio.</EmptyState>}
      </div>
    );
  }
  const t = p.totals;
  const names = p.wallets.map((w) => w.wallet);
  const fundUsd = parseUsd(fundAmt);
  const xferUsd = parseUsd(amt);
  const fromW = p.wallets.find((w) => w.wallet === from);
  return (
    <div className="page-narrow m-stagger">
      <h1 className="page-title">PAPER portfolio</h1>
      <p className="muted-s">Simulated money for ALPHA PAPER only. No real funds, broker or exchange is involved.</p>
      {!p.consistency.ok ? (
        <EmptyState title="Ledger check failed" tone="bad">{p.consistency.issues.join("; ")}</EmptyState>
      ) : null}

      <section className="card pf-card" aria-label="Allocation">
        <SectionHeader title="Allocation" sub="Book balance = available + reserved" />
        <div className="pf-row">
          <AllocationPie wallets={p.wallets} />
          <div className="pf-figs">
            <div><span>Total book balance</span><b>{money(t.book_balance_usd)}</b></div>
            <div><span>Unallocated</span><b>{money(t.unallocated_usd)}</b></div>
            <div><span>Reserved in positions</span><b>{money(t.reserved_usd)}</b></div>
            <div><span>Realized P&amp;L</span><b className={`t-${tone(t.realized_pnl_usd)}`}>{signedMoney(t.realized_pnl_usd)}</b></div>
            <div><span>Unrealized P&amp;L</span><b>{t.unrealized_pnl_usd === null ? NA : signedMoney(t.unrealized_pnl_usd)}</b></div>
          </div>
        </div>
        <AllocationLegend wallets={p.wallets} />
      </section>

      <section aria-label="Balances">
        <SectionHeader title="Balances" sub="Tap a strategy for details and risk" />
        <div className="card list-card">{p.wallets.map((w) => <WalletRow key={w.wallet} w={w} />)}</div>
      </section>

      <ActionForm
        title="Move PAPER funds"
        submitLabel="Transfer"
        disabled={xferUsd === null || from === to}
        note="Only available funds move; money reserved for open positions stays. Transfers never count as profit."
        onSubmit={async (id, pass) => { const r = await paperTransfer(from, to, xferUsd as number, id, pass); refresh(); return r; }}
      >
        <div className="pf-2col">
          <label className="pf-field"><span>From</span>
            <select value={from} onChange={(e) => setFrom(e.target.value)}>{names.map((n) => <option key={n} value={n}>{WALLET_NAME[n] ?? n}</option>)}</select>
          </label>
          <label className="pf-field"><span>To</span>
            <select value={to} onChange={(e) => setTo(e.target.value)}>{names.map((n) => <option key={n} value={n}>{WALLET_NAME[n] ?? n}</option>)}</select>
          </label>
        </div>
        <label className="pf-field"><span>Amount (USD){fromW ? ` · ${money(fromW.available_usd)} available` : ""}</span>
          <input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00" />
        </label>
        {from === to ? <p className="muted-s">Choose two different balances.</p> : null}
      </ActionForm>

      <ActionForm
        title="PAPER funding"
        submitLabel={fundAction === "deposit" ? "Add PAPER capital" : "Remove PAPER capital"}
        disabled={fundUsd === null}
        note="Changes the simulated capital in Unallocated. Funding is never counted as profit or loss."
        onSubmit={async (id, pass) => { const r = await paperFund(fundAction, fundUsd as number, id, pass); refresh(); return r; }}
      >
        <div className="pf-2col">
          <label className="pf-field"><span>Action</span>
            <select value={fundAction} onChange={(e) => setFundAction(e.target.value as "deposit" | "withdraw")}>
              <option value="deposit">Add</option><option value="withdraw">Remove</option>
            </select>
          </label>
          <label className="pf-field"><span>Amount (USD)</span>
            <input inputMode="decimal" value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} placeholder="0.00" />
          </label>
        </div>
      </ActionForm>

      <HistoryList p={p} />
    </div>
  );
}

function HistoryList({ p, wallet }: { p: PaperPortfolio; wallet?: string }) {
  const rows = p.history.filter((h) => !wallet || h.wallet === wallet);
  return (
    <section aria-label="PAPER transaction history">
      <SectionHeader title="Transaction history" sub="Every PAPER balance change" right={<span className="count">{rows.length}</span>} />
      {rows.length === 0 ? (
        <EmptyState title="No PAPER transactions yet" />
      ) : (
        <div className="card list-card">
          {rows.map((h) => (
            <div key={h.id} className="li li-wrap pf-hist">
              <span>
                {KIND_TEXT[h.kind] ?? h.kind} · {WALLET_NAME[h.wallet] ?? h.wallet}{h.counterparty ? ` ${h.kind === "TRANSFER_OUT" ? "→" : "←"} ${WALLET_NAME[h.counterparty] ?? h.counterparty}` : ""}
                <em className="soft"> {stamp(h.at)}</em>
              </span>
              <b className={`t-${tone(h.available_change_usd)}`}>
                {signedMoney(h.available_change_usd)}{h.reserved_change_usd ? <em className="soft"> reserved {signedMoney(h.reserved_change_usd)}</em> : null}
              </b>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- strategy page

function Curve({ a, b }: { a: SimStats; b: SimStats | null }) {
  const series = [a, ...(b ? [b] : [])];
  const all = series.flatMap((s) => s.curve.map((c) => c.equity));
  if (all.length < 2) return null;
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const pts = (s: SimStats) => s.curve.map((c, i) => `${((i / Math.max(1, s.curve.length - 1)) * 100).toFixed(2)},${(38 - ((c.equity - lo) / span) * 36).toFixed(2)}`).join(" ");
  return (
    <figure className="pf-curve">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Historical equity curves by closed trade">
        <polyline points={pts(a)} fill="none" stroke="var(--blue)" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
        {b ? <polyline points={pts(b)} fill="none" stroke="var(--orange)" strokeWidth="0.8" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <figcaption><i className="k-a" /> A raw · {money(lo)} – {money(hi)}{b ? <> <i className="k-b" /> B PAPER-constrained</> : null}</figcaption>
    </figure>
  );
}

const pctText = (x: number | null, dp = 1) => (x === null ? NA : `${(x * 100).toFixed(dp)}%`);
// No trades: nothing to compute (N/A). Trades but no loss: the ratio is undefined, said in words.
const pf = (x: number | null, trades: number) => (trades === 0 ? NA : x === null ? "no losing trade" : x.toFixed(3));

function StatsBlock({ title, s, extra }: { title: string; s: SimStats; extra?: string }) {
  const rows: [string, string][] = [
    ["Closed trades", String(s.trades)],
    ["Net P&L", signedMoney(s.netPnl)],
    ["Average per trade", s.avgPnl === null ? NA : signedMoney(s.avgPnl)],
    ["Win rate", `${pctText(s.winRate)} (${s.wins}/${s.trades})`],
    ["Profit factor", pf(s.profitFactor, s.trades)],
    ["Average win / loss", `${s.avgWin === null ? NA : money(s.avgWin)} / ${s.avgLoss === null ? NA : signedMoney(s.avgLoss)}`],
    ["Max consecutive losses", String(s.maxConsecutiveLosses)],
    ["Max drawdown", `${money(s.maxDrawdownUsd)} (${pctText(s.maxDrawdownPct, 2)} of peak; start ${money(s.startEquity)})`],
    ["Buying power per trade", s.maxNotional === null ? NA : `median ${money(s.medianNotional)} · max ${money(s.maxNotional)}`],
    ["Rejected entries", s.rejected ? `${s.rejected}: ${Object.entries(s.rejectedBy).map(([k, v]) => `${k} ${v}`).join(", ")}` : "0"],
    ["End balance", money(s.endEquity)],
  ];
  return (
    <div className="card list-card pf-stats">
      <b className="pf-form-t">{title}</b>
      {extra ? <p className="muted-s">{extra}</p> : null}
      {rows.map(([k, v]) => <div key={k} className="li li-wrap"><span>{k}</span><b>{v}</b></div>)}
    </div>
  );
}

export function StrategyPage() {
  const { symbol = "" } = useParams();
  const { state, refresh } = useDash();
  const { p, loading } = usePortfolio();
  const w = p?.wallets.find((x) => x.wallet === symbol) ?? null;
  const strat = p?.strategies[symbol] ?? null;
  const settings = strat?.settings ?? null;
  const current = settings?.pending?.risk_usd ?? settings?.applied?.risk_usd ?? null;
  const [riskText, setRiskText] = useState<string>("");
  const [allocText, setAllocText] = useState<string>("");
  const [bt, setBt] = useState<{ status: "loading" | "ok" | "none" | "error"; data?: { cached_at: string; result: BacktestResult }; err?: string }>({ status: "loading" });

  // Fetch the cached backtest once per strategy, not on every dashboard refresh.
  const hasStrategy = strat !== null;
  useEffect(() => {
    if (!hasStrategy) { setBt({ status: "none" }); return; }
    let live = true;
    fetchBacktest(symbol)
      .then((d) => live && setBt(d ? { status: "ok", data: d } : { status: "none" }))
      .catch((e) => live && setBt({ status: "error", err: e instanceof ApiError ? `${e.code}: ${e.message}` : "request failed" }));
    return () => { live = false; };
  }, [symbol, hasStrategy]);

  const risk = parseUsd(riskText) ?? current;
  const alloc = parseUsd(allocText) ?? (w && w.book_balance_usd > 0 ? w.book_balance_usd : null);
  const sims = useMemo(() => {
    if (bt.status !== "ok" || !bt.data || risk === null) return null;
    const r = bt.data.result;
    const limits = {
      maxOrderNotional: p?.limits.max_order_notional_usd ?? null,
      maxPositionExposure: p?.limits.max_position_exposure_usd ?? null,
      longOnly: !(p?.limits.short_selling_enabled ?? false),
    };
    return {
      a: rawBacktest(r, risk, alloc ?? 0),
      b: alloc === null ? null : constrainedBacktest(r, risk, alloc, limits),
    };
  }, [bt, risk, alloc, p]);

  if (!p || !w) {
    return (
      <div className="page-narrow">
        <h1 className="page-title">{WALLET_NAME[symbol] ?? symbol}</h1>
        {loading ? <SkeletonCards count={2} tall /> : <EmptyState title="No such PAPER balance" tone="warn"><Link className="link" to="/portfolio">Back to portfolio</Link></EmptyState>}
      </div>
    );
  }

  const bot = state.data?.bot?.status ?? null;
  const engineRisk = bot && bot.symbol === symbol ? bot.risk_usd : null;
  const ledgerTrades = (state.data?.recent.trades ?? []).filter((t) => t.source === "ALPHA_PAPER" && t.symbol === symbol);
  const riskInvalid = riskText !== "" && parseUsd(riskText) === null;
  const overAlloc = risk !== null && risk > w.book_balance_usd;
  const r = bt.data?.result;

  return (
    <div className="page-narrow m-stagger">
      <Link className="link" to="/portfolio">← Portfolio</Link>
      <h1 className="page-title">{WALLET_NAME[symbol] ?? symbol} strategy</h1>

      <section className="card pf-card" aria-label="Strategy balance">
        <SectionHeader title="PAPER balance" sub="Profits stay here until you transfer them" />
        <div className="pf-figs pf-figs-wide">
          <div><span>Available</span><b>{money(w.available_usd)}</b></div>
          <div><span>Reserved (open positions)</span><b>{money(w.reserved_usd)}</b></div>
          <div><span>Realized P&amp;L</span><b className={`t-${tone(w.realized_pnl_usd)}`}>{signedMoney(w.realized_pnl_usd)}</b></div>
          <div><span>Unrealized P&amp;L</span><b>{w.unrealized_pnl_usd === null ? NA : signedMoney(w.unrealized_pnl_usd)}</b></div>
          <div><span>Net transfers in</span><b>{money(w.net_funding_usd)}</b></div>
          <div><span>Equity</span><b>{w.equity_usd === null ? NA : money(w.equity_usd)}</b></div>
        </div>
      </section>

      {!strat ? (
        <EmptyState title="No validated strategy for this asset yet">This balance can hold PAPER capital, but only SOLUSD has a verified engine.</EmptyState>
      ) : (
        <>
          <section aria-label="Risk per trade">
            <SectionHeader title="Risk per trade" sub="Fixed USD at the stop · no compounding" />
            <div className="card list-card">
              <div className="li"><span>Applied (engine confirmed)</span><b>{settings?.applied ? `${money(settings.applied.risk_usd)} · v${settings.applied.version} · ${stamp(settings.applied.applied_at)}` : "none confirmed yet"}</b></div>
              <div className="li"><span>Pending</span><b>{settings?.pending ? `${money(settings.pending.risk_usd)} · v${settings.pending.version} · waiting for the engine` : "none"}</b></div>
              <div className="li"><span>Engine reports</span><b>{engineRisk === null || engineRisk === undefined ? NA : money(engineRisk)}</b></div>
            </div>
            <label className="pf-field">
              <span>Preview risk per trade (USD){current !== null ? ` · current ${money(current)}` : ""}</span>
              <input inputMode="decimal" value={riskText} onChange={(e) => setRiskText(e.target.value)} placeholder={current !== null ? String(current) : "10.00"} />
            </label>
            {riskInvalid ? <p className="pf-msg pf-msg-bad">Enter an amount in dollars and cents.</p> : null}
            {overAlloc ? <p className="pf-msg pf-msg-bad">Risk is larger than this balance ({money(w.book_balance_usd)}); ALPHA TERMINAL will refuse to apply it.</p> : null}
          </section>

          <section aria-label="Historical simulator">
            <SectionHeader title="Historical simulator" sub="Real Kraken history · not a forecast" />
            {bt.status === "loading" ? <SkeletonCards count={1} tall /> : bt.status === "error" ? (
              <EmptyState title="Backtest unavailable" tone="warn">{bt.err}</EmptyState>
            ) : bt.status === "none" || !r ? (
              <EmptyState title="No verified backtest uploaded yet">Run the engine's simulate command with --upload.</EmptyState>
            ) : !sims ? (
              <EmptyState title="Enter a risk amount" />
            ) : (
              <>
                <div className="card note-card">
                  <b>{r.data.trades_from.slice(0, 10)} to {r.data.to.slice(0, 10)} · {r.data.candles} Kraken 5m candles · profile {r.profile}</b>
                  <p>Trades computed at ${r.risk_basis_usd} risk and rescaled to {money(risk)} (exact here: size = risk ÷ stop distance, unrounded, no fees). Cached {stamp(bt.data?.cached_at)}. Past results only; no projection.</p>
                </div>
                <label className="pf-field">
                  <span>Starting allocation for B (USD){w.book_balance_usd > 0 ? ` · this balance ${money(w.book_balance_usd)}` : ""}</span>
                  <input inputMode="decimal" value={allocText} onChange={(e) => setAllocText(e.target.value)} placeholder={alloc !== null ? String(alloc) : "20.00"} />
                </label>
                <Curve a={sims.a} b={sims.b} />
                <StatsBlock title="A · Raw TradingView-style backtest" s={sims.a}
                  extra={`Every signal, long and short, no capital limit (leverage unlimited as in TradingView). Drawdown % measured from ${money(sims.a.startEquity)}.`} />
                {sims.b ? (
                  <StatsBlock title="B · PAPER-constrained backtest" s={sims.b}
                    extra={`Starts at ${money(sims.b.startEquity)}. An entry is rejected when its position value exceeds the balance (no leverage), when it is a short (ALPHA PAPER is long-only) or above the Worker's order/position limits. Fills at the engine's prices.`} />
                ) : (
                  <EmptyState title="Enter a starting allocation to see B" />
                )}
                {sims.b && p.totals.book_balance_usd > 0 ? (
                  <p className="muted-s">Portfolio effect under B: {signedMoney(sims.b.netPnl)} on a {money(p.totals.book_balance_usd)} PAPER portfolio ({((sims.b.netPnl / p.totals.book_balance_usd) * 100).toFixed(1)}%) over that historical period.</p>
                ) : null}
                <div className="card list-card pf-stats">
                  <b className="pf-form-t">C · Actual ALPHA PAPER ledger</b>
                  <div className="li"><span>Realized P&amp;L in this balance</span><b className={`t-${tone(w.realized_pnl_usd)}`}>{signedMoney(w.realized_pnl_usd)}</b></div>
                  <div className="li"><span>Closed ledger trades (recent list)</span><b>{ledgerTrades.length}</b></div>
                </div>
                <details className="pf-assume"><summary>Execution assumptions</summary><ul>{r.execution.map((x) => <li key={x}>{x}</li>)}</ul></details>
              </>
            )}
          </section>

          <ActionForm
            title={`Apply ${risk === null ? "" : money(risk)} risk per trade`}
            submitLabel="Apply to future entries"
            disabled={risk === null || riskInvalid || overAlloc || risk === current}
            note="Saved as PENDING, then Applied once the engine confirms. Open positions keep their original size and stop."
            onSubmit={async (id, pass) => { const res = await paperApplyRisk(symbol, risk as number, id, pass); refresh(); return res; }}
          >
            {risk === current ? <p className="muted-s">This is already the current setting.</p> : null}
          </ActionForm>

          {settings && settings.history.length ? (
            <section aria-label="Risk setting history">
              <SectionHeader title="Setting history" />
              <div className="card list-card">
                {settings.history.map((h) => (
                  <div key={h.version} className="li"><span>v{h.version} · {money(h.risk_usd)} <em className="soft">{stamp(h.requested_at)}</em></span>
                    <b><StatusBadge tone={h.status === "APPLIED" ? "ok" : h.status === "PENDING" ? "warn" : "muted"}>{h.status}</StatusBadge></b></div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
      <HistoryList p={p} wallet={symbol} />
    </div>
  );
}

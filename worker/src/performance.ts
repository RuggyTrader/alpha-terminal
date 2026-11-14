// Complete funded PAPER history, independent of paginated trade lists. Mirror never enters this query.
export async function lifetimePerformance(db: D1Database, botId: string | null = null) {
  const installed = await db.prepare(`SELECT 1 AS yes FROM sqlite_master WHERE type = 'table' AND name = 'bot_positions'`).first();
  const legacyFilter = botId ? " AND bot_id = ?" : "";
  const botFilter = botId ? " AND bot_id = ?" : "";
  const args = botId ? (installed ? [botId, botId] : [botId]) : [];
  // Legacy decimal dollars are rounded ONCE per historical trade; existing records are never rewritten.
  const source = `SELECT closed_at, 'legacy:' || printf('%020d', id) AS tie,
    CAST(ROUND(COALESCE(gross_pnl, realized_pnl) * 1e6) AS INTEGER) AS gross_micro,
    CAST(ROUND(COALESCE(fees_usd, 0) * 1e6) AS INTEGER) AS fees_micro,
    CAST(ROUND(realized_pnl * 1e6) AS INTEGER) AS net_micro
    FROM trades WHERE source = 'ALPHA_PAPER' AND status = 'CLOSED' AND closed_at IS NOT NULL${legacyFilter}
    ${installed ? `UNION ALL SELECT closed_at, 'bot:' || printf('%020d', id), gross_pnl_micro,
      entry_fee_micro + exit_fee_micro, net_pnl_micro
      FROM bot_positions WHERE status = 'CLOSED' AND closed_at IS NOT NULL${botFilter}` : ""}`;
  const r = await db.prepare(`WITH source AS (${source}), curve AS (
      SELECT *, SUM(net_micro) OVER (ORDER BY closed_at, tie ROWS UNBOUNDED PRECEDING) AS cumulative FROM source
    ), peaks AS (
      SELECT *, MAX(0, MAX(cumulative) OVER (ORDER BY closed_at, tie ROWS UNBOUNDED PRECEDING)) AS peak FROM curve
    ) SELECT COUNT(*) AS trades, COALESCE(SUM(gross_micro), 0) AS gross_micro,
      COALESCE(SUM(fees_micro), 0) AS fees_micro, COALESCE(SUM(net_micro), 0) AS net_micro,
      COALESCE(SUM(CASE WHEN net_micro > 0 THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(SUM(CASE WHEN net_micro < 0 THEN 1 ELSE 0 END), 0) AS losses,
      COALESCE(SUM(MAX(net_micro, 0)), 0) AS win_micro, COALESCE(-SUM(MIN(net_micro, 0)), 0) AS loss_micro,
      COALESCE(MAX(peak - cumulative), 0) AS drawdown_micro,
      MIN(closed_at) AS first_close, MAX(closed_at) AS last_close FROM peaks`).bind(...args).first<Record<string, number | string | null>>();
  const n = Number(r?.trades ?? 0), wins = Number(r?.wins ?? 0), losses = Number(r?.losses ?? 0);
  const net = Number(r?.net_micro ?? 0) / 1e6;
  return {
    scope: "all-funded-paper", bot_id: botId, complete: true, closed_trades: n, wins, losses, break_even: n - wins - losses,
    gross_usd: Number(r?.gross_micro ?? 0) / 1e6, fees_usd: Number(r?.fees_micro ?? 0) / 1e6, net_usd: net,
    win_rate: n ? wins / n : null, expectancy_usd: n ? net / n : null,
    profit_factor: Number(r?.loss_micro) > 0 ? Number(r?.win_micro) / Number(r?.loss_micro) : null,
    max_drawdown_usd: Number(r?.drawdown_micro ?? 0) / 1e6,
    drawdown_basis: "closed-trade cumulative net P&L; excludes intratrade unrealized losses",
    first_close: r?.first_close ?? null, last_close: r?.last_close ?? null,
  };
}

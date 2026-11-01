import {
  alpacaGet,
  asArray,
  asObject,
  num,
  secureEqual,
  type TradeCoreEnv,
} from "./trade_core";

import {
  hasValidSession,
} from "./auth_session";

import {
  paperSection,
  refreshMarks,
} from "./paper_ledger";

interface DashboardEnv
  extends TradeCoreEnv {
  ADMIN_SECRET: string;
  ENABLE_TRADING: string;
  DASHBOARD_PASSPHRASE?: string;
  PAPER_MARK_MIN_INTERVAL_SECONDS?: string;
  PAPER_MARK_STALE_SECONDS?: string;
}

const ALPACA_PAPER_BASE =
  "https://paper-api.alpaca.markets";

// ============================================================
// HELPERS
// ============================================================

function json(
  data: unknown,
  status = 200
): Response {
  return Response.json(
    data,
    {
      status,
      headers: {
        "Cache-Control":
          "no-store",
      },
    }
  );
}

function clampLimit(
  raw: string | null,
  defaultValue = 25
): number {
  const parsed =
    Number(raw);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return defaultValue;
  }

  return Math.min(
    Math.floor(parsed),
    100
  );
}

// Accepts either the x-admin-secret header (admin scripts / curl) or a
// read-only browser dashboard session cookie created with
// DASHBOARD_PASSPHRASE (see auth_session.ts). This API is GET-only, so a
// browser session can read the dashboard but never change execution state.
async function requireAdmin(
  request: Request,
  env: DashboardEnv
): Promise<Response | null> {
  const supplied =
    request.headers.get(
      "x-admin-secret"
    );

  if (
    supplied &&
    env.ADMIN_SECRET &&
    (await secureEqual(
      supplied,
      env.ADMIN_SECRET
    ))
  ) {
    return null;
  }

  if (
    !supplied &&
    (await hasValidSession(
      request,
      env
    ))
  ) {
    return null;
  }

  return json(
    {
      ok: false,
      status: "rejected",
      code: "UNAUTHORIZED",
      message:
        "authentication required",
    },
    401
  );
}

function parseJson(
  value: unknown,
  fallback: unknown
): unknown {
  if (
    typeof value !==
      "string" ||
    value.length === 0
  ) {
    return fallback;
  }

  try {
    return JSON.parse(
      value
    );
  } catch {
    return fallback;
  }
}

// ============================================================
// ENGINE
// ============================================================

async function getEngine(
  env: DashboardEnv
) {
  return env.DB.prepare(
    `SELECT
      state,
      kill_switch,
      killed_at,
      reason,
      updated_at,
      updated_by
     FROM engine_state
     WHERE id = 1`
  ).first<{
    state: string;
    kill_switch: number;
    killed_at: string | null;
    reason: string | null;
    updated_at: string;
    updated_by: string | null;
  }>();
}

// ============================================================
// BROKER SNAPSHOT
// PAPER READ-ONLY
// ============================================================

async function getBrokerSnapshot(
  env: DashboardEnv
) {
  const [
    accountResult,
    positionsResult,
    clockResult,
  ] = await Promise.all([
    alpacaGet(
      env,
      `${ALPACA_PAPER_BASE}/v2/account`
    ),

    alpacaGet(
      env,
      `${ALPACA_PAPER_BASE}/v2/positions`
    ),

    alpacaGet(
      env,
      `${ALPACA_PAPER_BASE}/v2/clock`
    ),
  ]);

  const errors:
    {
      source: string;
      code: string;
      message: string;
    }[] = [];

  let account:
    Record<
      string,
      unknown
    > | null = null;

  let positions:
    Record<
      string,
      unknown
    >[] = [];

  let clock:
    Record<
      string,
      unknown
    > | null = null;

  if (
    accountResult.ok
  ) {
    account =
      asObject(
        accountResult.data
      );
  } else {
    errors.push({
      source: "account",
      code:
        accountResult.code,
      message:
        accountResult.message,
    });
  }

  if (
    positionsResult.ok
  ) {
    positions =
      asArray(
        positionsResult.data
      );
  } else {
    errors.push({
      source: "positions",
      code:
        positionsResult.code,
      message:
        positionsResult.message,
    });
  }

  if (
    clockResult.ok
  ) {
    clock =
      asObject(
        clockResult.data
      );
  } else {
    errors.push({
      source: "clock",
      code:
        clockResult.code,
      message:
        clockResult.message,
    });
  }

  const formattedPositions =
    positions.map(
      (position) => ({
        symbol:
          String(
            position.symbol ??
              ""
          ),

        side:
          String(
            position.side ??
              ""
          ),

        qty:
          num(
            position.qty
          ),

        qty_available:
          num(
            position.qty_available ??
              position.qty
          ),

        avg_entry_price:
          num(
            position.avg_entry_price
          ),

        market_value:
          num(
            position.market_value
          ),

        cost_basis:
          num(
            position.cost_basis
          ),

        current_price:
          num(
            position.current_price
          ),

        lastday_price:
          num(
            position.lastday_price
          ),

        unrealized_pl:
          num(
            position.unrealized_pl
          ),

        unrealized_plpc:
          num(
            position.unrealized_plpc
          ),

        change_today:
          num(
            position.change_today
          ),
      })
    );

  return {
    mode: "PAPER",

    read_only: true,

    errors,

    account:
      account
        ? {
            id:
              String(
                account.id ??
                  ""
              ),

            status:
              String(
                account.status ??
                  ""
              ),

            currency:
              String(
                account.currency ??
                  "USD"
              ),

            cash:
              num(
                account.cash
              ),

            equity:
              num(
                account.equity
              ),

            last_equity:
              num(
                account.last_equity
              ),

            portfolio_value:
              num(
                account.portfolio_value
              ),

            buying_power:
              num(
                account.buying_power
              ),

            regt_buying_power:
              num(
                account.regt_buying_power
              ),

            daytrading_buying_power:
              num(
                account.daytrading_buying_power
              ),

            long_market_value:
              num(
                account.long_market_value
              ),

            short_market_value:
              num(
                account.short_market_value
              ),

            initial_margin:
              num(
                account.initial_margin
              ),

            maintenance_margin:
              num(
                account.maintenance_margin
              ),

            trading_blocked:
              Boolean(
                account.trading_blocked
              ),

            transfers_blocked:
              Boolean(
                account.transfers_blocked
              ),

            account_blocked:
              Boolean(
                account.account_blocked
              ),

            shorting_enabled:
              Boolean(
                account.shorting_enabled
              ),

            pattern_day_trader:
              Boolean(
                account.pattern_day_trader
              ),

            daytrade_count:
              num(
                account.daytrade_count
              ),

            todays_pnl:
              num(
                account.equity
              ) -
              num(
                account.last_equity
              ),
          }
        : null,

    positions:
      formattedPositions,

    clock:
      clock
        ? {
            timestamp:
              clock.timestamp ??
              null,

            is_open:
              Boolean(
                clock.is_open
              ),

            next_open:
              clock.next_open ??
              null,

            next_close:
              clock.next_close ??
              null,
          }
        : null,
  };
}

// ============================================================
// SUMMARY
// ============================================================

// Mark ALPHA PAPER positions from their truthful sources (throttled, read-only market data).
// A failure here never blocks the dashboard; positions keep their last mark.
async function refreshMarksSafely(
  env: DashboardEnv
) {
  try {
    await refreshMarks(env);
  } catch {
    /* marks stay as they were and are shown as stale */
  }
}

async function getSummary(
  env: DashboardEnv,
  refresh = true
) {
  if (refresh) {
    await refreshMarksSafely(env);
  }

  const paper =
    await paperSection(env);

  const [
    engine,
    broker,
    alertCounts,
    riskCounts,
    orderCounts,
    tradeCounts,
  ] = await Promise.all([
    getEngine(env),

    getBrokerSnapshot(
      env
    ),

    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(
          CASE
            WHEN status = 'dry_run'
            THEN 1
            ELSE 0
          END
        ) AS dry_run,
        SUM(
          CASE
            WHEN status = 'rejected'
            THEN 1
            ELSE 0
          END
        ) AS rejected,
        SUM(
          CASE
            WHEN status = 'processing'
            THEN 1
            ELSE 0
          END
        ) AS processing,
        SUM(
          duplicate_count
        ) AS duplicates
       FROM alerts`
    ).first<{
      total: number;
      dry_run: number | null;
      rejected: number | null;
      processing: number | null;
      duplicates: number | null;
    }>(),

    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(
          CASE
            WHEN approved = 1
            THEN 1
            ELSE 0
          END
        ) AS approved,
        SUM(
          CASE
            WHEN approved = 0
            THEN 1
            ELSE 0
          END
        ) AS rejected
       FROM risk_decisions`
    ).first<{
      total: number;
      approved: number | null;
      rejected: number | null;
    }>(),

    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(
          CASE
            WHEN status = 'dry_run_accepted'
            THEN 1
            ELSE 0
          END
        ) AS dry_run_accepted,
        SUM(
          CASE
            WHEN status = 'unknown'
            THEN 1
            ELSE 0
          END
        ) AS unknown,
        SUM(
          CASE
            WHEN status = 'dry_run_failed'
            THEN 1
            ELSE 0
          END
        ) AS failed
       FROM orders`
    ).first<{
      total: number;
      dry_run_accepted:
        number | null;
      unknown:
        number | null;
      failed:
        number | null;
    }>(),

    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(
          CASE
            WHEN status = 'OPEN'
            THEN 1
            ELSE 0
          END
        ) AS open,
        SUM(
          CASE
            WHEN status = 'CLOSED'
            THEN 1
            ELSE 0
          END
        ) AS closed,
        COALESCE(
          SUM(
            CAST(
              realized_pnl
              AS REAL
            )
          ),
          0
        ) AS realized_pnl
       FROM trades`
    ).first<{
      total: number;
      open: number | null;
      closed: number | null;
      realized_pnl:
        number | null;
    }>(),
  ]);

  return {
    generated_at:
      new Date()
        .toISOString(),

    mode: "PAPER",

    execution:
      "DRY_RUN_ONLY",

    broker_submission:
      false,

    enable_trading:
      env.ENABLE_TRADING ===
      "true",

    engine,

    broker,

    // Internal simulated ledger. Kept separate from the broker account above.
    paper,

    counts: {
      alerts: {
        total:
          alertCounts?.total ??
          0,

        dry_run:
          alertCounts?.dry_run ??
          0,

        rejected:
          alertCounts?.rejected ??
          0,

        processing:
          alertCounts?.processing ??
          0,

        duplicates:
          alertCounts?.duplicates ??
          0,
      },

      risk: {
        total:
          riskCounts?.total ??
          0,

        approved:
          riskCounts?.approved ??
          0,

        rejected:
          riskCounts?.rejected ??
          0,
      },

      orders: {
        total:
          orderCounts?.total ??
          0,

        dry_run_accepted:
          orderCounts
            ?.dry_run_accepted ??
          0,

        unknown:
          orderCounts?.unknown ??
          0,

        failed:
          orderCounts?.failed ??
          0,
      },

      trades: {
        total:
          tradeCounts?.total ??
          0,

        open:
          tradeCounts?.open ??
          0,

        closed:
          tradeCounts?.closed ??
          0,

        realized_pnl:
          Number(
            tradeCounts
              ?.realized_pnl ??
              0
          ),
      },
    },
  };
}

// ============================================================
// ALERTS
// ============================================================

async function getAlerts(
  env: DashboardEnv,
  limit: number
) {
  const result =
    await env.DB.prepare(
      `SELECT
        id,
        alert_id,
        received_at,
        processed_at,
        symbol,
        action,
        strategy,
        order_type,
        requested_qty,
        accepted_qty,
        status,
        validation_result,
        response_code,
        http_status,
        rejection_reason,
        duplicate_count,
        last_duplicate_at
       FROM alerts
       ORDER BY id DESC
       LIMIT ?`
    )
      .bind(limit)
      .all();

  return result.results;
}

// ============================================================
// RISK DECISIONS
// ============================================================

async function getRiskDecisions(
  env: DashboardEnv,
  limit: number
) {
  const result =
    await env.DB.prepare(
      `SELECT
        r.id,
        r.alert_fk,
        a.alert_id,
        a.symbol,
        a.action,
        a.strategy,
        r.decided_at,
        r.approved,
        r.code,
        r.reason,
        r.side,
        r.final_qty,
        r.reference_price,
        r.reference_price_time,
        r.estimated_notional,
        r.checks_json
       FROM risk_decisions r
       LEFT JOIN alerts a
         ON a.id = r.alert_fk
       ORDER BY r.id DESC
       LIMIT ?`
    )
      .bind(limit)
      .all();

  return result.results.map(
    (row) => ({
      ...row,

      approved:
        Number(
          row.approved
        ) === 1,

      checks:
        parseJson(
          row.checks_json,
          []
        ),
    })
  );
}

// ============================================================
// ORDERS
// ============================================================

async function getOrders(
  env: DashboardEnv,
  limit: number
) {
  const result =
    await env.DB.prepare(
      `SELECT
        o.id,
        o.alert_fk,
        a.alert_id,
        a.strategy,
        o.source,
        o.client_order_id,
        o.alpaca_order_id,
        o.symbol,
        o.side,
        o.qty,
        o.order_type,
        o.time_in_force,
        o.status,
        o.market_open_at_submit,
        o.submitted_at,
        o.alpaca_created_at,
        o.filled_qty,
        o.filled_avg_price,
        o.filled_at,
        o.canceled_at,
        o.updated_at,
        o.last_synced_at,
        o.error_detail
       FROM orders o
       LEFT JOIN alerts a
         ON a.id = o.alert_fk
       ORDER BY o.id DESC
       LIMIT ?`
    )
      .bind(limit)
      .all();

  return result.results.map(
    (row) => ({
      ...row,

      broker_request_sent:
        false,
    })
  );
}

// ============================================================
// TRADES
// ============================================================

async function getTrades(
  env: DashboardEnv,
  limit: number
) {
  const result =
    await env.DB.prepare(
      `SELECT
        id,
        symbol,
        direction,
        status,
        strategy,
        open_alert_id,
        open_order_id,
        close_order_id,
        entry_qty,
        entry_avg_price,
        exit_qty,
        exit_avg_price,
        open_qty,
        closed_cost_basis,
        realized_pnl,
        return_pct,
        opened_at,
        closed_at,
        leg_order_ids_json,
        source,
        position_fk,
        close_alert_id,
        price_sources
       FROM trades
       ORDER BY id DESC
       LIMIT ?`
    )
      .bind(limit)
      .all();

  return result.results.map(
    (row) => ({
      ...row,

      leg_order_ids:
        parseJson(
          row.leg_order_ids_json,
          []
        ),
    })
  );
}

// ============================================================
// ACTIVITY
// ============================================================

async function getActivity(
  env: DashboardEnv,
  limit: number
) {
  const result =
    await env.DB.prepare(
      `SELECT
        id,
        ts,
        category,
        level,
        message,
        alert_id,
        symbol,
        action,
        strategy,
        qty,
        validation_result,
        risk_result,
        rejection_reason,
        alpaca_order_id,
        alpaca_status,
        error_detail
       FROM activity_events
       ORDER BY id DESC
       LIMIT ?`
    )
      .bind(limit)
      .all();

  return result.results;
}

// ============================================================
// FULL DASHBOARD SNAPSHOT
// ============================================================

async function getDashboardSnapshot(
  env: DashboardEnv,
  limit: number
) {
  const [
    summary,
    alerts,
    risk,
    orders,
    trades,
    activity,
  ] = await (async () => {
    // Refresh first so the activity read below includes any mark events it writes.
    await refreshMarksSafely(env);

    return Promise.all([
    getSummary(env, false),

    getAlerts(
      env,
      limit
    ),

    getRiskDecisions(
      env,
      limit
    ),

    getOrders(
      env,
      limit
    ),

    getTrades(
      env,
      limit
    ),

    getActivity(
      env,
      limit
    ),
    ]);
  })();

  return {
    ...summary,

    recent: {
      alerts,
      risk,
      orders,
      trades,
      activity,
    },
  };
}

// ============================================================
// ROUTER
// ============================================================

export async function handleDashboardApi(
  request: Request,
  env: DashboardEnv,
  pathname: string,
  searchParams: URLSearchParams
): Promise<Response> {
  const authError =
    await requireAdmin(
      request,
      env
    );

  if (authError) {
    return authError;
  }

  if (
    request.method !==
    "GET"
  ) {
    return json(
      {
        ok: false,
        status: "rejected",
        code:
          "METHOD_NOT_ALLOWED",
        message:
          "dashboard API is read-only",
      },
      405
    );
  }

  const limit =
    clampLimit(
      searchParams.get(
        "limit"
      )
    );

  try {
    // --------------------------------------------------------
    // EVERYTHING NEEDED FOR MAIN DASHBOARD
    // --------------------------------------------------------

    if (
      pathname ===
      "/api/dashboard"
    ) {
      return json({
        ok: true,

        data:
          await getDashboardSnapshot(
            env,
            limit
          ),
      });
    }

    // --------------------------------------------------------
    // SUMMARY
    // --------------------------------------------------------

    if (
      pathname ===
      "/api/dashboard/summary"
    ) {
      return json({
        ok: true,

        data:
          await getSummary(
            env
          ),
      });
    }

    // --------------------------------------------------------
    // PAPER BROKER SNAPSHOT
    // --------------------------------------------------------

    if (
      pathname ===
      "/api/dashboard/broker"
    ) {
      return json({
        ok: true,

        data:
          await getBrokerSnapshot(
            env
          ),
      });
    }

    // --------------------------------------------------------
    // ALERTS
    // --------------------------------------------------------

    if (
      pathname ===
      "/api/dashboard/alerts"
    ) {
      return json({
        ok: true,

        data:
          await getAlerts(
            env,
            limit
          ),
      });
    }

    // --------------------------------------------------------
    // RISK
    // --------------------------------------------------------

    if (
      pathname ===
      "/api/dashboard/risk"
    ) {
      return json({
        ok: true,

        data:
          await getRiskDecisions(
            env,
            limit
          ),
      });
    }

    // --------------------------------------------------------
    // DRY-RUN ORDERS
    // --------------------------------------------------------

    if (
      pathname ===
      "/api/dashboard/orders"
    ) {
      return json({
        ok: true,

        data:
          await getOrders(
            env,
            limit
          ),
      });
    }

    // --------------------------------------------------------
    // TRADES
    // --------------------------------------------------------

    if (
      pathname ===
      "/api/dashboard/trades"
    ) {
      return json({
        ok: true,

        data:
          await getTrades(
            env,
            limit
          ),
      });
    }

    // --------------------------------------------------------
    // ACTIVITY
    // --------------------------------------------------------

    if (
      pathname ===
      "/api/dashboard/activity"
    ) {
      return json({
        ok: true,

        data:
          await getActivity(
            env,
            limit
          ),
      });
    }

    return json(
      {
        ok: false,
        code:
          "NOT_FOUND",
        message:
          "dashboard API route not found",
      },
      404
    );
  } catch (error) {
    return json(
      {
        ok: false,

        status:
          "error",

        code:
          "DASHBOARD_QUERY_FAILED",

        message:
          error instanceof Error
            ? error.message
            : "dashboard query failed",
      },
      500
    );
  }
}
import {
  createDryRunOrder,
  simulateUnknownState,
  simulateReconcile,
} from "./dry_run_orders";

import {
  handleDryRunWebhook,
} from "./webhook_dry_run";

import {
  handleEngineLedger,
  handleEngineStatus,
} from "./engine_status";

import {
  handleDashboardApi,
} from "./dashboard_api";

import {
  handleAuth,
} from "./auth_session";

import {
  alpacaGet,
  runRiskEvaluation,
  saveRiskDecision,
  secureEqual,
  validateIntent,
  type TradeCoreEnv,
} from "./trade_core";

import {
  getInstrument,
  normalizeSymbol,
  referencePrice,
} from "./instruments";

interface Env extends TradeCoreEnv {
  ENABLE_TRADING: string;

  WEBHOOK_SECRET: string;
  // Admin scripts only (x-admin-secret header). Never used by /auth/login.
  ADMIN_SECRET: string;
  // Dashboard sign-in only (/auth/login). Read-only session; no admin access.
  DASHBOARD_PASSPHRASE?: string;
  DASHBOARD_ORIGINS?: string;
}

const ALPACA_PAPER_BASE =
  "https://paper-api.alpaca.markets";

// ============================================================
// RESPONSE
// ============================================================

function json(
  data: unknown,
  status = 200
): Response {
  return Response.json(
    data,
    { status }
  );
}

// ============================================================
// ADMIN AUTH
// ============================================================

async function requireAdmin(
  request: Request,
  env: Env
): Promise<Response | null> {
  const supplied =
    request.headers.get(
      "x-admin-secret"
    );

  if (
    !supplied ||
    !(await secureEqual(
      supplied,
      env.ADMIN_SECRET
    ))
  ) {
    return json(
      {
        ok: false,
        status:
          "rejected",
        code:
          "UNAUTHORIZED",
        message:
          "invalid admin secret",
      },
      401
    );
  }

  return null;
}

// ============================================================
// ENGINE STATE
// ============================================================

async function getEngine(
  env: Env
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

    kill_switch:
      number;

    killed_at:
      string | null;

    reason:
      string | null;

    updated_at:
      string;

    updated_by:
      string | null;
  }>();
}

// ============================================================
// ALERT REJECTION HELPER
// ============================================================

async function rejectAlert(
  env: Env,

  alertId: string,

  code: string,

  message: string,

  httpStatus: number
): Promise<Response> {
  await env.DB.prepare(
    `UPDATE alerts
     SET
       status = 'rejected',
       processed_at = ?,
       response_code = ?,
       http_status = ?,
       rejection_reason = ?
     WHERE alert_id = ?`
  )
    .bind(
      new Date()
        .toISOString(),

      code,

      httpStatus,

      message,

      alertId
    )
    .run();

  return json(
    {
      ok: false,

      status:
        "rejected",

      code,

      message,

      alert_id:
        alertId,
    },
    httpStatus
  );
}

// ============================================================
// ENGINE CONTROLS
// ============================================================

async function handleEngineControl(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  const authError =
    await requireAdmin(
      request,
      env
    );

  if (authError) {
    return authError;
  }

  const now =
    new Date()
      .toISOString();

  const current =
    await getEngine(env);

  if (!current) {
    return json(
      {
        ok: false,
        status: "error",
        code:
          "ENGINE_STATE_MISSING",
        message:
          "Engine state record is missing",
      },
      500
    );
  }

  if (
    pathname ===
    "/kill"
  ) {
    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state = 'STOPPED',
         kill_switch = 1,
         killed_at = ?,
         updated_at = ?,
         updated_by = 'admin',
         reason =
           'Emergency kill switch: new PAPER orders blocked'
       WHERE id = 1`
    )
      .bind(
        now,
        now
      )
      .run();

    return json({
      ok: true,

      status: "ok",

      code:
        "KILL_SWITCH_ACTIVE",

      message:
        "New PAPER orders blocked. Existing positions and open orders were not touched.",

      data:
        await getEngine(
          env
        ),
    });
  }

  if (
    pathname ===
    "/kill/reset"
  ) {
    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state = 'STOPPED',
         kill_switch = 0,
         killed_at = NULL,
         updated_at = ?,
         updated_by = 'admin',
         reason =
           'Kill switch reset; engine remains STOPPED until started'
       WHERE id = 1`
    )
      .bind(now)
      .run();

    return json({
      ok: true,

      status: "ok",

      code:
        "KILL_SWITCH_RESET",

      message:
        "Kill switch reset; engine STOPPED",

      data:
        await getEngine(
          env
        ),
    });
  }

  if (
    pathname ===
    "/engine/start"
  ) {
    if (
      current.kill_switch ===
      1
    ) {
      return json(
        {
          ok: false,

          status:
            "rejected",

          code:
            "KILL_SWITCH_ACTIVE",

          message:
            "Kill switch is active. Reset it before starting.",
        },
        409
      );
    }

    if (
      env.ENABLE_TRADING !==
      "true"
    ) {
      return json(
        {
          ok: false,

          status:
            "rejected",

          code:
            "EXECUTION_DISABLED",

          message:
            "ENABLE_TRADING is false on the server. PAPER execution cannot start.",
        },
        409
      );
    }

    if (
      current.state !==
      "STOPPED"
    ) {
      return json(
        {
          ok: false,

          status:
            "rejected",

          code:
            "INVALID_TRANSITION",

          message:
            `Cannot start from ${current.state}`,
        },
        409
      );
    }

    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state = 'RUNNING',
         updated_at = ?,
         updated_by = 'admin',
         reason = 'start by admin'
       WHERE id = 1`
    )
      .bind(now)
      .run();
  }

  if (
    pathname ===
    "/engine/pause"
  ) {
    if (
      current.state !==
      "RUNNING"
    ) {
      return json(
        {
          ok: false,

          status:
            "rejected",

          code:
            "INVALID_TRANSITION",

          message:
            `Cannot pause from ${current.state}`,
        },
        409
      );
    }

    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state = 'PAUSED',
         updated_at = ?,
         updated_by = 'admin',
         reason = 'pause by admin'
       WHERE id = 1`
    )
      .bind(now)
      .run();
  }

  if (
    pathname ===
    "/engine/resume"
  ) {
    if (
      current.kill_switch ===
      1
    ) {
      return json(
        {
          ok: false,

          status:
            "rejected",

          code:
            "KILL_SWITCH_ACTIVE",

          message:
            "Kill switch is active.",
        },
        409
      );
    }

    if (
      current.state !==
      "PAUSED"
    ) {
      return json(
        {
          ok: false,

          status:
            "rejected",

          code:
            "INVALID_TRANSITION",

          message:
            `Cannot resume from ${current.state}`,
        },
        409
      );
    }

    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state = 'RUNNING',
         updated_at = ?,
         updated_by = 'admin',
         reason = 'resume by admin'
       WHERE id = 1`
    )
      .bind(now)
      .run();
  }

  if (
    pathname ===
    "/engine/stop"
  ) {
    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state = 'STOPPED',
         updated_at = ?,
         updated_by = 'admin',
         reason = 'stop by admin'
       WHERE id = 1`
    )
      .bind(now)
      .run();
  }

  const updated =
    await getEngine(env);

  return json({
    ok: true,

    status: "ok",

    code:
      `ENGINE_${
        updated?.state ??
        "UNKNOWN"
      }`,

    message:
      `Engine ${
        updated?.state ??
        "UNKNOWN"
      }`,

    data:
      updated,
  });
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const url =
      new URL(
        request.url
      );

    // ========================================================
    // HEALTH
    // ========================================================

    if (
      url.pathname ===
        "/health" &&
      request.method ===
        "GET"
    ) {
      try {
        const db =
          await env.DB.prepare(
            "SELECT 1 AS ok"
          ).first<{
            ok: number;
          }>();

        return json({
          ok:
            db?.ok === 1,

          service:
            "alpha-terminal-api",

          mode:
            "PAPER",

          database:
            db?.ok === 1
              ? "connected"
              : "error",

          enable_trading:
            env.ENABLE_TRADING ===
            "true",

          alpaca_configured:
            Boolean(
              env.ALPACA_KEY &&
              env.ALPACA_SECRET
            ),

          engine:
            await getEngine(
              env
            ),
        });
      } catch {
        return json(
          {
            ok: false,

            service:
              "alpha-terminal-api",

            mode:
              "PAPER",

            database:
              "error",

            enable_trading:
              false,
          },
          500
        );
      }
    }

    // ========================================================
    // READ-ONLY ALPACA PAPER ROUTES
    // ========================================================

    if (
      request.method ===
        "GET" &&
      [
        "/api/broker/account",
        "/api/broker/positions",
        "/api/broker/clock",
      ].includes(
        url.pathname
      )
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      let target:
        string;

      if (
        url.pathname ===
        "/api/broker/account"
      ) {
        target =
          `${ALPACA_PAPER_BASE}/v2/account`;
      } else if (
        url.pathname ===
        "/api/broker/positions"
      ) {
        target =
          `${ALPACA_PAPER_BASE}/v2/positions`;
      } else {
        target =
          `${ALPACA_PAPER_BASE}/v2/clock`;
      }

      const result =
        await alpacaGet(
          env,
          target
        );

      if (
        !result.ok
      ) {
        return json(
          {
            ok: false,

            status:
              "error",

            code:
              result.code,

            message:
              result.message,
          },
          result.status
        );
      }

      return json({
        ok: true,

        status:
          "ok",

        mode:
          "PAPER",

        data:
          result.data,
      });
    }

    // ========================================================
    // READ-ONLY PRICE
    // ========================================================

    if (
      request.method ===
        "GET" &&
      url.pathname.startsWith(
        "/api/broker/price/"
      )
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      const symbol =
        normalizeSymbol(
          decodeURIComponent(
            url.pathname.slice(
              "/api/broker/price/"
                .length
            )
          )
        );

      const instrument =
        symbol === null
          ? null
          : getInstrument(
              symbol
            );

      if (!instrument) {
        return json(
          {
            ok: false,

            status:
              "rejected",

            code:
              "INVALID_SYMBOL",

            message:
              "not one of the supported instruments",
          },
          400
        );
      }

      // Same truthful source the risk engine uses; no price is estimated.
      const result =
        await referencePrice(
          instrument,
          env
        );

      if (
        !result.ok
      ) {
        return json(
          {
            ok: false,

            status:
              "error",

            code:
              result.code,

            message:
              result.message,
          },
          result.status
        );
      }

      if (
        result.price ===
        null
      ) {
        return json(
          {
            ok: false,

            status:
              "unavailable",

            code:
              "MARKET_DATA_UNAVAILABLE",

            message:
              result.reason,

            symbol:
              instrument.symbol,
          },
          503
        );
      }

      return json({
        ok: true,

        status:
          "ok",

        mode:
          "PAPER",

        symbol:
          instrument.symbol,

        data: {
          price:
            result.price,

          source:
            result.source,

          fetched_at:
            result.at,
        },
      });
    }

    // ========================================================
    // SHARED RISK PREVIEW
    // ========================================================

    if (
      url.pathname ===
        "/api/risk/preview" &&
      request.method ===
        "POST"
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      let body:
        Record<
          string,
          unknown
        >;

      try {
        body =
          await request.json<
            Record<
              string,
              unknown
            >
          >();
      } catch {
        return json(
          {
            ok: false,

            status:
              "rejected",

            code:
              "INVALID_JSON",

            message:
              "body is not valid JSON",
          },
          400
        );
      }

      const validation =
        validateIntent(
          body,
          env
        );

      if (
        !validation.ok
      ) {
        return json(
          {
            ok: false,

            status:
              "rejected",

            code:
              validation.code,

            message:
              validation.message,
          },
          400
        );
      }

      const result =
        await runRiskEvaluation(
          env,
          validation
        );

      if (
        !result.ok
      ) {
        return json(
          {
            ok: false,

            status:
              "error",

            code:
              result.code,

            message:
              result.message,
          },
          result.status
        );
      }

      await saveRiskDecision(
        env,
        null,
        result.risk
      );

      return json({
        ok: true,

        status:
          "ok",

        mode:
          "PAPER",

        execution:
          "NOT_ATTEMPTED",

        intent: {
          symbol:
            validation.symbol,

          action:
            validation.action,

          qty:
            validation.qty,

          strategy:
            validation.strategy,
        },

        risk:
          result.risk,
      });
    }

    // ========================================================
    // MANUAL DRY-RUN ORDER INTENT TEST
    // ========================================================

    if (
      url.pathname ===
        "/api/dry-run/order" &&
      request.method ===
        "POST"
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      let body:
        Record<
          string,
          unknown
        >;

      try {
        body =
          await request.json<
            Record<
              string,
              unknown
            >
          >();
      } catch {
        return json(
          {
            ok: false,
            code:
              "INVALID_JSON",
          },
          400
        );
      }

      const alertId =
        String(
          body.alert_id ??
          ""
        ).trim();

      const symbol =
        String(
          body.symbol ??
          ""
        )
          .trim()
          .toUpperCase();

      const side =
        String(
          body.side ??
          ""
        )
          .trim()
          .toLowerCase();

      const qty =
        Number(
          body.qty
        );

      if (!alertId) {
        return json(
          {
            ok: false,
            code:
              "INVALID_ALERT_ID",
          },
          400
        );
      }

      if (
        !/^[A-Z][A-Z0-9.]{0,9}$/.test(
          symbol
        )
      ) {
        return json(
          {
            ok: false,
            code:
              "INVALID_SYMBOL",
          },
          400
        );
      }

      if (
        side !== "buy" &&
        side !== "sell"
      ) {
        return json(
          {
            ok: false,
            code:
              "INVALID_SIDE",
          },
          400
        );
      }

      if (
        !Number.isFinite(
          qty
        ) ||
        qty <= 0
      ) {
        return json(
          {
            ok: false,
            code:
              "INVALID_QUANTITY",
          },
          400
        );
      }

      const result =
        await createDryRunOrder(
          env,
          {
            alertId,

            alertFk:
              null,

            symbol,

            side:
              side as
                | "buy"
                | "sell",

            qty,

            orderType:
              "market",

            timeInForce:
              "day",
          }
        );

      return json({
        ok: true,

        mode:
          "PAPER",

        execution:
          "DRY_RUN_ONLY",

        broker_request_sent:
          false,

        ...result,
      });
    }

    // ========================================================
    // SIMULATE UNKNOWN BROKER STATE
    // ========================================================

    if (
      url.pathname ===
        "/api/dry-run/unknown" &&
      request.method ===
        "POST"
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      let body:
        Record<
          string,
          unknown
        >;

      try {
        body =
          await request.json<
            Record<
              string,
              unknown
            >
          >();
      } catch {
        return json(
          {
            ok: false,
            code:
              "INVALID_JSON",
          },
          400
        );
      }

      const clientOrderId =
        String(
          body.client_order_id ??
          ""
        ).trim();

      if (
        !clientOrderId
      ) {
        return json(
          {
            ok: false,

            code:
              "MISSING_CLIENT_ORDER_ID",
          },
          400
        );
      }

      const order =
        await simulateUnknownState(
          env,
          clientOrderId
        );

      if (!order) {
        return json(
          {
            ok: false,

            code:
              "ORDER_NOT_FOUND",
          },
          404
        );
      }

      return json({
        ok: true,

        mode:
          "PAPER",

        execution:
          "DRY_RUN_ONLY",

        broker_request_sent:
          false,

        order,
      });
    }

    // ========================================================
    // SIMULATE RECONCILIATION
    // ========================================================

    if (
      url.pathname ===
        "/api/dry-run/reconcile" &&
      request.method ===
        "POST"
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      let body:
        Record<
          string,
          unknown
        >;

      try {
        body =
          await request.json<
            Record<
              string,
              unknown
            >
          >();
      } catch {
        return json(
          {
            ok: false,

            code:
              "INVALID_JSON",
          },
          400
        );
      }

      const clientOrderId =
        String(
          body.client_order_id ??
          ""
        ).trim();

      const found =
        body.found ===
        true;

      if (
        !clientOrderId
      ) {
        return json(
          {
            ok: false,

            code:
              "MISSING_CLIENT_ORDER_ID",
          },
          400
        );
      }

      const order =
        await simulateReconcile(
          env,
          clientOrderId,
          found
        );

      if (!order) {
        return json(
          {
            ok: false,

            code:
              "ORDER_NOT_FOUND",
          },
          404
        );
      }

      return json({
        ok: true,

        mode:
          "PAPER",

        execution:
          "DRY_RUN_ONLY",

        broker_request_sent:
          false,

        reconciled_found:
          found,

        order,
      });
    }

    // ========================================================
    // ENGINE CONTROLS
    // ========================================================

    if (
      request.method ===
        "POST" &&
      [
        "/engine/start",
        "/engine/pause",
        "/engine/resume",
        "/engine/stop",
        "/kill",
        "/kill/reset",
      ].includes(
        url.pathname
      )
    ) {
      return handleEngineControl(
        request,
        env,
        url.pathname
      );
    }

    // ========================================================
    // FULL TRADINGVIEW DRY-RUN WEBHOOK
    // ========================================================

    if (
      url.pathname ===
        "/webhook/dry-run" &&
      request.method ===
        "POST"
    ) {
      return handleDryRunWebhook(
        request,
        env
      );
    }

    // ========================================================
    // OTE ENGINE STATUS (heartbeat from engine/, no trading)
    // ========================================================

    if (
      url.pathname ===
        "/webhook/engine-status" &&
      request.method ===
        "POST"
    ) {
      return handleEngineStatus(
        request,
        env
      );
    }

    // Read-only ledger view for the OTE engine's reconciliation check.
    if (
      url.pathname ===
        "/webhook/engine-ledger" &&
      request.method ===
        "POST"
    ) {
      return handleEngineLedger(
        request,
        env
      );
    }

    // ========================================================
    // MAIN TRADINGVIEW WEBHOOK
    // ========================================================

    if (
      url.pathname ===
        "/webhook" &&
      request.method ===
        "POST"
    ) {
      const now =
        new Date()
          .toISOString();

      let body:
        Record<
          string,
          unknown
        >;

      try {
        body =
          await request.json<
            Record<
              string,
              unknown
            >
          >();
      } catch {
        return json(
          {
            ok: false,

            status:
              "rejected",

            code:
              "INVALID_JSON",

            message:
              "body is not valid JSON",
          },
          400
        );
      }

      const secret =
        body.secret;

      if (
        typeof secret !==
          "string" ||
        !(await secureEqual(
          secret,
          env.WEBHOOK_SECRET
        ))
      ) {
        return json(
          {
            ok: false,

            status:
              "rejected",

            code:
              "UNAUTHORIZED",

            message:
              "invalid webhook secret",
          },
          401
        );
      }

      const rawAlertId =
        body.id;

      let alertId:
        string;

      if (
        typeof rawAlertId ===
          "number" &&
        Number.isInteger(
          rawAlertId
        )
      ) {
        alertId =
          String(
            rawAlertId
          );
      } else if (
        typeof rawAlertId ===
        "string"
      ) {
        alertId =
          rawAlertId
            .trim();
      } else {
        return json(
          {
            ok: false,

            status:
              "rejected",

            code:
              "INVALID_ALERT_ID",

            message:
              "id must be 1-128 printable characters without spaces",
          },
          400
        );
      }

      if (
        !/^[\x21-\x7E]{1,128}$/.test(
          alertId
        )
      ) {
        return json(
          {
            ok: false,

            status:
              "rejected",

            code:
              "INVALID_ALERT_ID",

            message:
              "id must be 1-128 printable characters without spaces",
          },
          400
        );
      }

      const sanitized = {
        ...body,
      };

      delete sanitized.secret;

      try {
        await env.DB.prepare(
          `INSERT INTO alerts
          (
            alert_id,
            received_at,
            source_ip,
            symbol,
            action,
            strategy,
            payload_json,
            status
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            'processing'
          )`
        )
          .bind(
            alertId,

            now,

            request.headers.get(
              "cf-connecting-ip"
            ),

            typeof body.symbol ===
              "string"
              ? body.symbol.slice(
                  0,
                  32
                )
              : null,

            typeof body.action ===
              "string"
              ? body.action.slice(
                  0,
                  16
                )
              : null,

            typeof body.strategy ===
              "string"
              ? body.strategy.slice(
                  0,
                  64
                )
              : null,

            JSON.stringify(
              sanitized
            ).slice(
              0,
              4000
            )
          )
          .run();
      } catch {
        const existing =
          await env.DB.prepare(
            `SELECT
              status,
              response_code
             FROM alerts
             WHERE alert_id = ?`
          )
            .bind(
              alertId
            )
            .first<{
              status:
                string;

              response_code:
                string | null;
            }>();

        if (existing) {
          await env.DB.prepare(
            `UPDATE alerts
             SET
               duplicate_count =
                 duplicate_count + 1,
               last_duplicate_at = ?
             WHERE alert_id = ?`
          )
            .bind(
              now,
              alertId
            )
            .run();

          return json({
            ok: true,

            status:
              "duplicate",

            code:
              "DUPLICATE",

            message:
              "Alert id already processed; no order submitted",

            alert_id:
              alertId,

            data: {
              original_status:
                existing.status,

              original_code:
                existing.response_code,
            },
          });
        }

        return json(
          {
            ok: false,

            status:
              "error",

            code:
              "DATABASE_ERROR",

            message:
              "Could not persist alert",
          },
          500
        );
      }

      const validation =
        validateIntent(
          body,
          env
        );

      if (
        !validation.ok
      ) {
        await env.DB.prepare(
          `UPDATE alerts
           SET
             status = 'rejected',
             processed_at = ?,
             validation_result = 'failed',
             response_code = ?,
             http_status = 400,
             rejection_reason = ?
           WHERE alert_id = ?`
        )
          .bind(
            now,

            validation.code,

            validation.message,

            alertId
          )
          .run();

        return json(
          {
            ok: false,

            status:
              "rejected",

            code:
              validation.code,

            message:
              validation.message,

            alert_id:
              alertId,
          },
          400
        );
      }

      await env.DB.prepare(
        `UPDATE alerts
         SET
           symbol = ?,
           action = ?,
           strategy = ?,
           order_type = ?,
           requested_qty = ?,
           validation_result = 'passed'
         WHERE alert_id = ?`
      )
        .bind(
          validation.symbol,

          validation.action,

          validation.strategy,

          validation.orderType,

          validation.qty ===
            null
            ? null
            : String(
                validation.qty
              ),

          alertId
        )
        .run();

      const engine =
        await getEngine(
          env
        );

      if (
        engine?.kill_switch ===
        1
      ) {
        return rejectAlert(
          env,

          alertId,

          "KILL_SWITCH_ACTIVE",

          "Kill switch is active; new PAPER orders are blocked",

          403
        );
      }

      if (
        !engine ||
        engine.state ===
          "STOPPED"
      ) {
        return rejectAlert(
          env,

          alertId,

          "ENGINE_STOPPED",

          "Execution engine is STOPPED; no PAPER order submitted",

          403
        );
      }

      if (
        engine.state ===
        "PAUSED"
      ) {
        return rejectAlert(
          env,

          alertId,

          "ENGINE_PAUSED",

          "Execution engine is PAUSED; no PAPER order submitted",

          403
        );
      }

      if (
        env.ENABLE_TRADING !==
        "true"
      ) {
        return rejectAlert(
          env,

          alertId,

          "EXECUTION_DISABLED",

          "ENABLE_TRADING is false on the server",

          403
        );
      }

      const riskResult =
        await runRiskEvaluation(
          env,
          validation
        );

      if (
        !riskResult.ok
      ) {
        await env.DB.prepare(
          `UPDATE alerts
           SET
             status = 'error',
             processed_at = ?,
             response_code = ?,
             http_status = ?,
             rejection_reason = ?
           WHERE alert_id = ?`
        )
          .bind(
            new Date()
              .toISOString(),

            riskResult.code,

            riskResult.status,

            riskResult.message,

            alertId
          )
          .run();

        return json(
          {
            ok: false,

            status:
              "error",

            code:
              riskResult.code,

            message:
              riskResult.message,

            alert_id:
              alertId,
          },
          riskResult.status
        );
      }

      const alertRow =
        await env.DB.prepare(
          `SELECT id
           FROM alerts
           WHERE alert_id = ?`
        )
          .bind(
            alertId
          )
          .first<{
            id: number;
          }>();

      await saveRiskDecision(
        env,

        alertRow?.id ??
        null,

        riskResult.risk
      );

      if (
        !riskResult.risk
          .approved
      ) {
        return rejectAlert(
          env,

          alertId,

          riskResult.risk
            .code,

          riskResult.risk
            .reason,

          422
        );
      }

      await env.DB.prepare(
        `UPDATE alerts
         SET
           status = 'error',
           processed_at = ?,
           accepted_qty = ?,
           response_code =
             'BROKER_EXECUTION_NOT_IMPLEMENTED',
           http_status = 503,
           rejection_reason =
             'Risk approved but broker execution is not implemented'
         WHERE alert_id = ?`
      )
        .bind(
          new Date()
            .toISOString(),

          riskResult.risk
            .finalQty ===
              null
            ? null
            : String(
                riskResult.risk
                  .finalQty
              ),

          alertId
        )
        .run();

      return json(
        {
          ok: false,

          status:
            "error",

          code:
            "BROKER_EXECUTION_NOT_IMPLEMENTED",

          message:
            "Risk approved, but broker submission is intentionally not implemented.",

          alert_id:
            alertId,

          mode:
            "PAPER",

          broker_request_sent:
            false,

          risk:
            riskResult.risk,
        },
        503
      );
    }

    // ========================================================
    // DASHBOARD SIGN-IN (browser session, read-only)
    // ========================================================

    if (
      url.pathname.startsWith(
        "/auth/"
      )
    ) {
      return handleAuth(
        request,
        env,
        url.pathname
      );
    }

    // ========================================================
    // DASHBOARD API
    // READ-ONLY / PAPER-ONLY
    // ========================================================

    if (
      url.pathname ===
        "/api/dashboard" ||
      url.pathname.startsWith(
        "/api/dashboard/"
      )
    ) {
      return handleDashboardApi(
        request,
        env,
        url.pathname,
        url.searchParams
      );
    }

    // ========================================================
    // NOT FOUND
    // ========================================================

    return json(
      {
        ok: false,
        code:
          "NOT_FOUND",
        message:
          "Route not found",
      },
      404
    );
  },
};
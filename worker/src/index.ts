interface Env {
  DB: D1Database;

  ENABLE_TRADING: string;

  WEBHOOK_SECRET: string;
  ADMIN_SECRET: string;

  ALLOWED_SYMBOLS: string;
  ALLOW_FRACTIONAL_QTY: string;

  MAX_ORDER_QTY: string;
  MAX_ORDER_NOTIONAL: string;
  MAX_POSITION_EXPOSURE: string;
  MAX_TOTAL_EXPOSURE: string;
  MAX_OPEN_POSITIONS: string;

  SHORT_SELLING_ENABLED: string;
  DAILY_LOSS_LIMIT: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function secureEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();

  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);

  const aa = new Uint8Array(aHash);
  const bb = new Uint8Array(bHash);

  let diff = 0;

  for (let i = 0; i < aa.length; i++) {
    diff |= aa[i] ^ bb[i];
  }

  return diff === 0;
}

async function requireAdmin(
  request: Request,
  env: Env
): Promise<Response | null> {
  const supplied = request.headers.get("x-admin-secret");

  if (
    !supplied ||
    !(await secureEqual(supplied, env.ADMIN_SECRET))
  ) {
    return json(
      {
        ok: false,
        status: "rejected",
        code: "UNAUTHORIZED",
        message: "invalid admin secret",
      },
      401
    );
  }

  return null;
}

async function getEngine(env: Env) {
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

type ValidationResult =
  | {
      ok: true;
      symbol: string;
      action: "buy" | "sell" | "close";
      qty: number | null;
      strategy: string;
      orderType: "market";
      timeInForce: "day";
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

function validateIntent(
  body: Record<string, unknown>,
  env: Env
): ValidationResult {
  const rawSymbol = body.symbol;

  if (
    rawSymbol === undefined ||
    rawSymbol === null ||
    rawSymbol === ""
  ) {
    return {
      ok: false,
      code: "MISSING_FIELD",
      message: "symbol is required",
    };
  }

  if (typeof rawSymbol !== "string") {
    return {
      ok: false,
      code: "INVALID_SYMBOL",
      message: "symbol must be a string",
    };
  }

  let symbol = rawSymbol.trim().toUpperCase();

  if (symbol.includes(":")) {
    symbol = symbol.split(":", 2)[1];
  }

  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return {
      ok: false,
      code: "INVALID_SYMBOL",
      message: "symbol format is not a supported stock ticker",
    };
  }

  const allowed = env.ALLOWED_SYMBOLS
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (!allowed.includes(symbol)) {
    return {
      ok: false,
      code: "INVALID_SYMBOL",
      message: `${symbol} is not in the allowed symbol list`,
    };
  }

  const rawAction = body.action;

  if (
    rawAction === undefined ||
    rawAction === null ||
    rawAction === ""
  ) {
    return {
      ok: false,
      code: "MISSING_FIELD",
      message: "action is required",
    };
  }

  if (typeof rawAction !== "string") {
    return {
      ok: false,
      code: "INVALID_ACTION",
      message: "action must be buy, sell or close",
    };
  }

  const action = rawAction.trim().toLowerCase();

  if (!["buy", "sell", "close"].includes(action)) {
    return {
      ok: false,
      code: "INVALID_ACTION",
      message: "action must be buy, sell or close",
    };
  }

  const rawOrderType =
    body.order_type !== undefined
      ? body.order_type
      : body.type ?? "market";

  if (
    typeof rawOrderType !== "string" ||
    rawOrderType.trim().toLowerCase() !== "market"
  ) {
    return {
      ok: false,
      code: "UNSUPPORTED_ORDER_TYPE",
      message:
        "only market orders are supported; the alert was not converted",
    };
  }

  const rawTif =
    body.time_in_force !== undefined
      ? body.time_in_force
      : "day";

  if (
    typeof rawTif !== "string" ||
    rawTif.trim().toLowerCase() !== "day"
  ) {
    return {
      ok: false,
      code: "UNSUPPORTED_TIME_IN_FORCE",
      message: "only time_in_force=day is supported",
    };
  }

  let qty: number | null = null;

  if (action === "buy" || action === "sell") {
    if (
      body.qty === undefined ||
      body.qty === null ||
      body.qty === ""
    ) {
      return {
        ok: false,
        code: "MISSING_FIELD",
        message: "qty is required for buy and sell",
      };
    }

    if (
      typeof body.qty !== "number" &&
      typeof body.qty !== "string"
    ) {
      return {
        ok: false,
        code: "INVALID_QUANTITY",
        message: "qty must be a number",
      };
    }

    qty = Number(body.qty);

    if (!Number.isFinite(qty)) {
      return {
        ok: false,
        code: "INVALID_QUANTITY",
        message: "qty must be a finite number",
      };
    }

    if (qty <= 0) {
      return {
        ok: false,
        code: "INVALID_QUANTITY",
        message: "qty must be greater than zero",
      };
    }

    const allowFractional =
      env.ALLOW_FRACTIONAL_QTY.toLowerCase() === "true";

    if (!allowFractional && !Number.isInteger(qty)) {
      return {
        ok: false,
        code: "INVALID_QUANTITY",
        message:
          "fractional quantities are disabled (ALLOW_FRACTIONAL_QTY=false)",
      };
    }

    if (qty > Number(env.MAX_ORDER_QTY)) {
      return {
        ok: false,
        code: "MAX_ORDER_QTY_EXCEEDED",
        message: `qty exceeds MAX_ORDER_QTY=${env.MAX_ORDER_QTY}`,
      };
    }
  }

  const strategy =
    body.strategy === undefined || body.strategy === null
      ? "UNSPECIFIED"
      : String(body.strategy).trim().slice(0, 64) ||
        "UNSPECIFIED";

  return {
    ok: true,
    symbol,
    action: action as "buy" | "sell" | "close",
    qty,
    strategy,
    orderType: "market",
    timeInForce: "day",
  };
}

async function handleEngineControl(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  const authError = await requireAdmin(request, env);

  if (authError) {
    return authError;
  }

  const now = new Date().toISOString();

  const current = await getEngine(env);

  if (!current) {
    return json(
      {
        ok: false,
        status: "error",
        code: "ENGINE_STATE_MISSING",
        message: "Engine state record is missing",
      },
      500
    );
  }

  if (pathname === "/kill") {
    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state = 'STOPPED',
         kill_switch = 1,
         killed_at = ?,
         updated_at = ?,
         updated_by = 'admin',
         reason = 'Emergency kill switch: new PAPER orders blocked'
       WHERE id = 1`
    )
      .bind(now, now)
      .run();

    return json({
      ok: true,
      status: "ok",
      code: "KILL_SWITCH_ACTIVE",
      message:
        "New PAPER orders blocked. Existing positions and open orders were not touched.",
      data: await getEngine(env),
    });
  }

  if (pathname === "/kill/reset") {
    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state = 'STOPPED',
         kill_switch = 0,
         killed_at = NULL,
         updated_at = ?,
         updated_by = 'admin',
         reason = 'Kill switch reset; engine remains STOPPED until started'
       WHERE id = 1`
    )
      .bind(now)
      .run();

    return json({
      ok: true,
      status: "ok",
      code: "KILL_SWITCH_RESET",
      message: "Kill switch reset; engine STOPPED",
      data: await getEngine(env),
    });
  }

  if (pathname === "/engine/start") {
    if (current.kill_switch === 1) {
      return json(
        {
          ok: false,
          status: "rejected",
          code: "KILL_SWITCH_ACTIVE",
          message:
            "Kill switch is active. Reset it before starting.",
        },
        409
      );
    }

    if (env.ENABLE_TRADING !== "true") {
      return json(
        {
          ok: false,
          status: "rejected",
          code: "EXECUTION_DISABLED",
          message:
            "ENABLE_TRADING is false on the server. PAPER execution cannot start.",
        },
        409
      );
    }

    if (current.state !== "STOPPED") {
      return json(
        {
          ok: false,
          status: "rejected",
          code: "INVALID_TRANSITION",
          message: `Cannot start from ${current.state}`,
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

  if (pathname === "/engine/pause") {
    if (current.state !== "RUNNING") {
      return json(
        {
          ok: false,
          status: "rejected",
          code: "INVALID_TRANSITION",
          message: `Cannot pause from ${current.state}`,
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

  if (pathname === "/engine/resume") {
    if (current.kill_switch === 1) {
      return json(
        {
          ok: false,
          status: "rejected",
          code: "KILL_SWITCH_ACTIVE",
          message: "Kill switch is active.",
        },
        409
      );
    }

    if (current.state !== "PAUSED") {
      return json(
        {
          ok: false,
          status: "rejected",
          code: "INVALID_TRANSITION",
          message: `Cannot resume from ${current.state}`,
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

  if (pathname === "/engine/stop") {
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

  const updated = await getEngine(env);

  return json({
    ok: true,
    status: "ok",
    code: `ENGINE_${updated?.state ?? "UNKNOWN"}`,
    message: `Engine ${updated?.state ?? "UNKNOWN"}`,
    data: updated,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---------------------------------------------------------
    // HEALTH
    // ---------------------------------------------------------

    if (
      url.pathname === "/health" &&
      request.method === "GET"
    ) {
      try {
        const db = await env.DB.prepare(
          "SELECT 1 AS ok"
        ).first<{ ok: number }>();

        const engine = await getEngine(env);

        return json({
          ok: true,
          service: "alpha-terminal-api",
          mode: "PAPER",
          database:
            db?.ok === 1 ? "connected" : "error",
          enable_trading:
            env.ENABLE_TRADING === "true",
          engine,
        });
      } catch {
        return json(
          {
            ok: false,
            service: "alpha-terminal-api",
            mode: "PAPER",
            database: "error",
            enable_trading: false,
          },
          500
        );
      }
    }

    // ---------------------------------------------------------
    // ADMIN ENGINE CONTROLS
    // ---------------------------------------------------------

    if (
      request.method === "POST" &&
      [
        "/engine/start",
        "/engine/pause",
        "/engine/resume",
        "/engine/stop",
        "/kill",
        "/kill/reset",
      ].includes(url.pathname)
    ) {
      return handleEngineControl(
        request,
        env,
        url.pathname
      );
    }

    // ---------------------------------------------------------
    // WEBHOOK
    // ---------------------------------------------------------

    if (
      url.pathname === "/webhook" &&
      request.method === "POST"
    ) {
      const now = new Date().toISOString();

      let body: Record<string, unknown>;

      try {
        body =
          await request.json<Record<string, unknown>>();
      } catch {
        return json(
          {
            ok: false,
            status: "rejected",
            code: "INVALID_JSON",
            message: "body is not valid JSON",
          },
          400
        );
      }

      // ---------------- AUTH ----------------

      const secret = body.secret;

      if (
        typeof secret !== "string" ||
        !(await secureEqual(
          secret,
          env.WEBHOOK_SECRET
        ))
      ) {
        return json(
          {
            ok: false,
            status: "rejected",
            code: "UNAUTHORIZED",
            message: "invalid webhook secret",
          },
          401
        );
      }

      // ---------------- ALERT ID ----------------

      const rawAlertId = body.id;

      let alertId: string;

      if (
        typeof rawAlertId === "number" &&
        Number.isInteger(rawAlertId)
      ) {
        alertId = String(rawAlertId);
      } else if (
        typeof rawAlertId === "string"
      ) {
        alertId = rawAlertId.trim();
      } else {
        return json(
          {
            ok: false,
            status: "rejected",
            code: "INVALID_ALERT_ID",
            message:
              "id must be 1-128 printable characters without spaces",
          },
          400
        );
      }

      if (
        !/^[\x21-\x7E]{1,128}$/.test(alertId)
      ) {
        return json(
          {
            ok: false,
            status: "rejected",
            code: "INVALID_ALERT_ID",
            message:
              "id must be 1-128 printable characters without spaces",
          },
          400
        );
      }

      // ---------------- SANITIZE ----------------

      const sanitized = { ...body };

      delete sanitized.secret;

      // ---------------- CLAIM ALERT ID ----------------

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
          VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`
        )
          .bind(
            alertId,
            now,
            request.headers.get(
              "cf-connecting-ip"
            ),
            typeof body.symbol === "string"
              ? body.symbol.slice(0, 32)
              : null,
            typeof body.action === "string"
              ? body.action.slice(0, 16)
              : null,
            typeof body.strategy === "string"
              ? body.strategy.slice(0, 64)
              : null,
            JSON.stringify(sanitized).slice(
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
            .bind(alertId)
            .first<{
              status: string;
              response_code: string | null;
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
            .bind(now, alertId)
            .run();

          return json({
            ok: true,
            status: "duplicate",
            code: "DUPLICATE",
            message:
              "Alert id already processed; no order submitted",
            alert_id: alertId,
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
            status: "error",
            code: "DATABASE_ERROR",
            message:
              "Could not persist alert",
          },
          500
        );
      }

      // ---------------- VALIDATION ----------------

      const validation =
        validateIntent(body, env);

      if (!validation.ok) {
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
            status: "rejected",
            code: validation.code,
            message: validation.message,
            alert_id: alertId,
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
          validation.qty === null
            ? null
            : String(validation.qty),
          alertId
        )
        .run();

      // ---------------- ENGINE GATE ----------------

      const engine = await getEngine(env);

      if (engine?.kill_switch === 1) {
        await env.DB.prepare(
          `UPDATE alerts
           SET
             status = 'rejected',
             processed_at = ?,
             response_code =
               'KILL_SWITCH_ACTIVE',
             http_status = 403,
             rejection_reason =
               'Kill switch is active; new PAPER orders are blocked'
           WHERE alert_id = ?`
        )
          .bind(now, alertId)
          .run();

        return json(
          {
            ok: false,
            status: "rejected",
            code:
              "KILL_SWITCH_ACTIVE",
            message:
              "Kill switch is active; new PAPER orders are blocked",
            alert_id: alertId,
          },
          403
        );
      }

      if (
        !engine ||
        engine.state === "STOPPED"
      ) {
        await env.DB.prepare(
          `UPDATE alerts
           SET
             status = 'rejected',
             processed_at = ?,
             response_code =
               'ENGINE_STOPPED',
             http_status = 403,
             rejection_reason =
               'Execution engine is STOPPED; no PAPER order submitted'
           WHERE alert_id = ?`
        )
          .bind(now, alertId)
          .run();

        return json(
          {
            ok: false,
            status: "rejected",
            code: "ENGINE_STOPPED",
            message:
              "Execution engine is STOPPED; no PAPER order submitted",
            alert_id: alertId,
          },
          403
        );
      }

      if (engine.state === "PAUSED") {
        await env.DB.prepare(
          `UPDATE alerts
           SET
             status = 'rejected',
             processed_at = ?,
             response_code =
               'ENGINE_PAUSED',
             http_status = 403,
             rejection_reason =
               'Execution engine is PAUSED; no PAPER order submitted'
           WHERE alert_id = ?`
        )
          .bind(now, alertId)
          .run();

        return json(
          {
            ok: false,
            status: "rejected",
            code: "ENGINE_PAUSED",
            message:
              "Execution engine is PAUSED; no PAPER order submitted",
            alert_id: alertId,
          },
          403
        );
      }

      if (
        env.ENABLE_TRADING !== "true"
      ) {
        await env.DB.prepare(
          `UPDATE alerts
           SET
             status = 'rejected',
             processed_at = ?,
             response_code =
               'EXECUTION_DISABLED',
             http_status = 403,
             rejection_reason =
               'ENABLE_TRADING is false on the server'
           WHERE alert_id = ?`
        )
          .bind(now, alertId)
          .run();

        return json(
          {
            ok: false,
            status: "rejected",
            code:
              "EXECUTION_DISABLED",
            message:
              "ENABLE_TRADING is false on the server",
            alert_id: alertId,
          },
          403
        );
      }

      // Broker execution intentionally not ported yet.
      // This migration stage stays PAPER-only and locked.

      await env.DB.prepare(
        `UPDATE alerts
         SET
           status = 'error',
           processed_at = ?,
           response_code =
             'BROKER_EXECUTION_NOT_IMPLEMENTED',
           http_status = 503,
           rejection_reason =
             'Broker execution is not enabled in this migration stage'
         WHERE alert_id = ?`
      )
        .bind(now, alertId)
        .run();

      return json(
        {
          ok: false,
          status: "error",
          code:
            "BROKER_EXECUTION_NOT_IMPLEMENTED",
          message:
            "Validation passed, but broker execution is not enabled in this migration stage",
          alert_id: alertId,
        },
        503
      );
    }

    // ---------------------------------------------------------
    // NOT FOUND
    // ---------------------------------------------------------

    return json(
      {
        ok: false,
        code: "NOT_FOUND",
        message: "Route not found",
      },
      404
    );
  },
};
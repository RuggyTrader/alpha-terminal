import {
  runRiskEvaluation,
  saveRiskDecision,
  secureEqual,
  validateIntent,
  type TradeCoreEnv,
} from "./trade_core";

import {
  createDryRunOrder,
} from "./dry_run_orders";

interface DryRunWebhookEnv
  extends TradeCoreEnv {
  WEBHOOK_SECRET: string;
}

function json(
  data: unknown,
  status = 200
): Response {
  return Response.json(
    data,
    { status }
  );
}

export async function handleDryRunWebhook(
  request: Request,
  env: DryRunWebhookEnv
): Promise<Response> {
  const now =
    new Date().toISOString();

  // ==========================================================
  // PARSE BODY
  // ==========================================================

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
        status: "rejected",
        code: "INVALID_JSON",
        message:
          "body is not valid JSON",
        broker_request_sent:
          false,
      },
      400
    );
  }

  // ==========================================================
  // WEBHOOK SECRET
  // ==========================================================

  const suppliedSecret =
    body.secret;

  if (
    typeof suppliedSecret !==
      "string" ||
    !(await secureEqual(
      suppliedSecret,
      env.WEBHOOK_SECRET
    ))
  ) {
    return json(
      {
        ok: false,
        status: "rejected",
        code: "UNAUTHORIZED",
        message:
          "invalid webhook secret",
        broker_request_sent:
          false,
      },
      401
    );
  }

  // ==========================================================
  // ALERT ID
  // ==========================================================

  const rawAlertId =
    body.id;

  let alertId: string;

  if (
    typeof rawAlertId ===
      "number" &&
    Number.isInteger(
      rawAlertId
    )
  ) {
    alertId =
      String(rawAlertId);
  } else if (
    typeof rawAlertId ===
    "string"
  ) {
    alertId =
      rawAlertId.trim();
  } else {
    return json(
      {
        ok: false,
        status: "rejected",
        code:
          "INVALID_ALERT_ID",
        message:
          "id must be 1-128 printable characters without spaces",
        broker_request_sent:
          false,
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
        status: "rejected",
        code:
          "INVALID_ALERT_ID",
        message:
          "id must be 1-128 printable characters without spaces",
        broker_request_sent:
          false,
      },
      400
    );
  }

  // Never store the secret in D1.

  const sanitized = {
    ...body,
  };

  delete sanitized.secret;

  // ==========================================================
  // CLAIM ALERT
  // Unique alert_id gives us duplicate protection.
  // ==========================================================

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
        .bind(alertId)
        .first<{
          status: string;
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
        status: "duplicate",
        code: "DUPLICATE",
        message:
          "Alert id already processed; no order intent created",
        mode: "PAPER",
        execution:
          "DRY_RUN_ONLY",
        broker_request_sent:
          false,
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
        status: "error",
        code:
          "DATABASE_ERROR",
        message:
          "Could not persist alert",
        broker_request_sent:
          false,
      },
      500
    );
  }

  // ==========================================================
  // SHARED VALIDATION
  // Same validator used by the main PAPER path.
  // ==========================================================

  const validation =
    validateIntent(
      body,
      env
    );

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
        code:
          validation.code,
        message:
          validation.message,
        alert_id:
          alertId,
        mode: "PAPER",
        execution:
          "DRY_RUN_ONLY",
        broker_request_sent:
          false,
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

  // ==========================================================
  // SHARED PAPER RISK ENGINE
  // Reads real PAPER account/position/market information.
  // Does NOT submit an order.
  // ==========================================================

  const riskResult =
    await runRiskEvaluation(
      env,
      validation
    );

  if (!riskResult.ok) {
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
        status: "error",
        code:
          riskResult.code,
        message:
          riskResult.message,
        alert_id:
          alertId,
        mode: "PAPER",
        execution:
          "DRY_RUN_ONLY",
        broker_request_sent:
          false,
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
      .bind(alertId)
      .first<{
        id: number;
      }>();

  // Persist every shared risk result.

  await saveRiskDecision(
    env,
    alertRow?.id ?? null,
    riskResult.risk
  );

  // ==========================================================
  // RISK REJECTED
  // ==========================================================

  if (
    !riskResult.risk
      .approved
  ) {
    await env.DB.prepare(
      `UPDATE alerts
       SET
         status = 'rejected',
         processed_at = ?,
         response_code = ?,
         http_status = 422,
         rejection_reason = ?
       WHERE alert_id = ?`
    )
      .bind(
        new Date()
          .toISOString(),

        riskResult.risk.code,

        riskResult.risk.reason,

        alertId
      )
      .run();

    return json(
      {
        ok: false,
        status: "rejected",
        code:
          riskResult.risk.code,
        message:
          riskResult.risk.reason,
        alert_id:
          alertId,
        mode: "PAPER",
        execution:
          "DRY_RUN_ONLY",
        broker_request_sent:
          false,
        risk:
          riskResult.risk,
      },
      422
    );
  }

  // ==========================================================
  // APPROVED DRY-RUN ORDER INTENT
  //
  // IMPORTANT:
  // createDryRunOrder writes the intent to D1.
  // It NEVER sends an Alpaca POST.
  // ==========================================================

  if (
    !riskResult.risk.side ||
    riskResult.risk.finalQty ===
      null ||
    riskResult.risk.finalQty <=
      0
  ) {
    await env.DB.prepare(
      `UPDATE alerts
       SET
         status = 'error',
         processed_at = ?,
         response_code =
           'INVALID_RISK_OUTPUT',
         http_status = 500,
         rejection_reason =
           'Approved risk result did not contain a valid side and quantity'
       WHERE alert_id = ?`
    )
      .bind(
        new Date()
          .toISOString(),
        alertId
      )
      .run();

    return json(
      {
        ok: false,
        status: "error",
        code:
          "INVALID_RISK_OUTPUT",
        message:
          "Approved risk result did not contain a valid side and quantity",
        alert_id:
          alertId,
        broker_request_sent:
          false,
      },
      500
    );
  }

  const dryRunOrder =
    await createDryRunOrder(
      env,
      {
        alertId,

        alertFk:
          alertRow?.id ??
          null,

        symbol:
          validation.symbol,

        side:
          riskResult.risk.side,

        qty:
          riskResult.risk
            .finalQty,

        orderType:
          validation.orderType,

        timeInForce:
          validation.timeInForce,
      }
    );

  // ==========================================================
  // MARK ALERT COMPLETE
  // ==========================================================

  const completedAt =
    new Date()
      .toISOString();

  await env.DB.prepare(
    `UPDATE alerts
     SET
       status = 'dry_run',
       processed_at = ?,
       accepted_qty = ?,
       response_code =
         'DRY_RUN_ACCEPTED',
       http_status = 200,
       rejection_reason = NULL
     WHERE alert_id = ?`
  )
    .bind(
      completedAt,

      String(
        riskResult.risk
          .finalQty
      ),

      alertId
    )
    .run();

  return json({
    ok: true,

    status:
      "dry_run",

    code:
      "DRY_RUN_ACCEPTED",

    message:
      "PAPER risk approved and dry-run order intent persisted. No broker order was submitted.",

    mode:
      "PAPER",

    execution:
      "DRY_RUN_ONLY",

    broker_request_sent:
      false,

    alert_id:
      alertId,

    intent: {
      symbol:
        validation.symbol,

      action:
        validation.action,

      side:
        riskResult.risk.side,

      qty:
        riskResult.risk
          .finalQty,

      strategy:
        validation.strategy,

      order_type:
        validation.orderType,

      time_in_force:
        validation.timeInForce,
    },

    risk:
      riskResult.risk,

    order:
      dryRunOrder,
  });
}
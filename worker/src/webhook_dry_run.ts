import { portfolioGate } from "./portfolio";
import {
  runRiskEvaluation,
  saveRiskDecision,
  secureEqual,
  validateIntent,
  type TradeCoreEnv,
} from "./trade_core";

import {
  clientOrderIdForAlert,
} from "./dry_run_orders";

import {
  commitDryRun,
  fillActivity,
  logActivity,
} from "./paper_ledger";

// An alert stuck in 'processing' this long (e.g. the Worker was stopped mid-request) may be retried.
const STUCK_PROCESSING_MS = 60_000;

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

  const payloadJson =
    JSON.stringify(
      sanitized
    ).slice(
      0,
      4000
    );

  const clientOrderId =
    await clientOrderIdForAlert(
      alertId
    );

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

        payloadJson
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

    // RETRY: the same alert (identical payload) may be processed again only if its earlier attempt
    // ended in an error, or is stuck in 'processing', AND committed no order intent. The claim is one
    // conditional UPDATE, so concurrent retries cannot both win. Rejections are final.
    const retry =
      existing
        ? await env.DB.prepare(
            `UPDATE alerts
             SET
               status = 'processing',
               processed_at = NULL,
               response_code = NULL,
               http_status = NULL,
               rejection_reason = NULL,
               attempt_count = attempt_count + 1,
               last_attempt_at = ?
             WHERE alert_id = ?
               AND payload_json = ?
               AND (
                 status = 'error'
                 OR (
                   status = 'processing'
                   AND COALESCE(last_attempt_at, received_at) < ?
                 )
               )
               AND NOT EXISTS (
                 SELECT 1 FROM orders
                 WHERE client_order_id = ?
               )`
          )
            .bind(
              now,
              alertId,
              payloadJson,
              new Date(
                Date.parse(now) -
                  STUCK_PROCESSING_MS
              ).toISOString(),
              clientOrderId
            )
            .run()
        : null;

    if (
      retry?.meta &&
      retry.meta.changes === 1
    ) {
      await logActivity(env, {
        category: "alert",
        level: "info",
        message:
          "Retry of an alert whose earlier attempt committed nothing · processing again",
        alertId,
      });
    } else if (existing) {
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

      await logActivity(env, {
        category: "alert",
        level: "info",
        message:
          "Duplicate alert ignored · no new order intent, no position change",
        alertId,
        symbol:
          typeof body.symbol === "string"
            ? body.symbol.slice(0, 32)
            : null,
        action:
          typeof body.action === "string"
            ? body.action.slice(0, 16).toLowerCase()
            : null,
      });

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

    if (!existing) {
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

    await logActivity(env, {
      category: "alert",
      level: "warn",
      message:
        `Alert rejected · ${validation.code}`,
      alertId,
      symbol:
        typeof body.symbol === "string"
          ? body.symbol.slice(0, 32)
          : null,
      action:
        typeof body.action === "string"
          ? body.action.slice(0, 16).toLowerCase()
          : null,
      validationResult:
        "failed",
      rejectionReason:
        validation.message,
    });

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

  await logActivity(env, {
    category: "alert",
    level: "info",
    message:
      `Alert accepted (${validation.strategy})`,
    alertId,
    symbol:
      validation.symbol,
    action:
      validation.action,
    strategy:
      validation.strategy,
    qty:
      validation.qty,
    validationResult:
      "passed",
  });

  // ==========================================================
  // SHARED PAPER RISK ENGINE
  // Reads real PAPER account/position/market information.
  // Does NOT submit an order.
  // ==========================================================

  // Positions for risk come from the ALPHA PAPER ledger, not the broker.
  const riskResult =
    await runRiskEvaluation(
      env,
      validation,
      {
        positionSource:
          "ledger",
      }
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

    await logActivity(env, {
      category:
        riskResult.code ===
        "MARKET_DATA_UNAVAILABLE"
          ? "market"
          : "risk",
      level: "error",
      message:
        riskResult.code ===
        "MARKET_DATA_UNAVAILABLE"
          ? "Market data unavailable · alert not processed, no position change"
          : `Risk check could not run · ${riskResult.code}`,
      alertId,
      symbol:
        validation.symbol,
      action:
        validation.action,
      strategy:
        validation.strategy,
      errorDetail:
        riskResult.message,
    });

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

  const riskDecisionId =
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

    await logActivity(env, {
      category:
        riskResult.risk.code ===
        "MARKET_DATA_UNAVAILABLE"
          ? "market"
          : "risk",
      level: "warn",
      message:
        riskResult.risk.code ===
        "MARKET_DATA_UNAVAILABLE"
          ? "Market data unavailable · risk rejected, no position change"
          : `Risk rejected · ${riskResult.risk.code}`,
      alertId,
      symbol:
        validation.symbol,
      action:
        validation.action,
      strategy:
        validation.strategy,
      qty:
        validation.qty,
      riskResult:
        riskResult.risk.code,
      rejectionReason:
        riskResult.risk.reason,
    });

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
  // commitDryRun writes the intent and its ALPHA PAPER fill to D1
  // in one transaction. It NEVER sends an Alpaca POST.
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

  // ==========================================================
  // PAPER PORTFOLIO: once funded, a BUY must fit its strategy balance
  // (full position value, no leverage). Rejected, not retryable.
  // ==========================================================

  const capital =
    riskResult.risk.referencePrice !== null
      ? await portfolioGate(env.DB, {
          symbol: validation.symbol,
          side: riskResult.risk.side,
          qty: riskResult.risk.finalQty,
          price: riskResult.risk.referencePrice,
        })
      : null;

  if (capital) {
    await env.DB.prepare(
      `UPDATE alerts
       SET status = 'rejected', processed_at = ?, response_code = ?, http_status = 422, rejection_reason = ?
       WHERE alert_id = ?`
    )
      .bind(new Date().toISOString(), capital.code, capital.message, alertId)
      .run();

    await logActivity(env, {
      category: "paper",
      level: "warn",
      message: `PAPER portfolio rejected · ${capital.code}`,
      alertId,
      symbol: validation.symbol,
      action: validation.action,
      strategy: validation.strategy,
      qty: riskResult.risk.finalQty,
      riskResult: capital.code,
      rejectionReason: capital.message,
    });

    return json(
      {
        ok: false,
        status: "rejected",
        code: capital.code,
        message: capital.message,
        alert_id: alertId,
        mode: "PAPER",
        execution: "DRY_RUN_ONLY",
        broker_request_sent: false,
      },
      422
    );
  }

  await logActivity(env, {
    category: "risk",
    level: "success",
    message:
      riskResult.risk.estimatedNotional ===
      null
        ? `Risk approved · ${riskResult.risk.side?.toUpperCase()} ${riskResult.risk.finalQty} at ${riskResult.risk.referencePrice} (${riskResult.risk.priceSource ?? "no price"})`
        : `Risk approved · $${riskResult.risk.estimatedNotional} at ${riskResult.risk.referencePrice} (${riskResult.risk.priceSource ?? "no price"})`,
    alertId,
    symbol:
      validation.symbol,
    action:
      validation.action,
    strategy:
      validation.strategy,
    qty:
      riskResult.risk.finalQty,
    riskResult:
      "APPROVED",
  });

  // ==========================================================
  // ONE TRANSACTION: order intent + ALPHA PAPER fill + position
  // (+ trade on full close) + alert DRY_RUN_ACCEPTED.
  // Simulated fill at the risk decision's truthful price.
  // Nothing is sent to a broker.
  // ==========================================================

  const commitInput = {
    alertId,
    alertFk:
      alertRow?.id ??
      null,
    clientOrderId,
    riskDecisionId,
    symbol:
      validation.symbol,
    action:
      validation.action,
    side:
      riskResult.risk.side,
    qty:
      riskResult.risk.finalQty,
    price:
      riskResult.risk.referencePrice ??
      0,
    priceSource:
      riskResult.risk.priceSource ??
      "",
    priceAt:
      riskResult.risk.priceAt ??
      new Date().toISOString(),
    strategy:
      validation.strategy,
    orderType:
      validation.orderType,
    timeInForce:
      validation.timeInForce,
  };

  const ledger =
    riskResult.risk.referencePrice !==
      null &&
    riskResult.risk.priceSource
      ? await commitDryRun(
          env,
          commitInput
        )
      : {
          ok: false as const,
          code:
            "LEDGER_NO_PRICE",
          message:
            "approved intent had no truthful fill price; nothing was committed",
          committed: false,
        };

  if (!ledger.ok && ledger.code === "INSUFFICIENT_PAPER_CAPITAL") {
    // A concurrent change used the balance between the check above and the commit: a rejection, nothing committed.
    await env.DB.prepare(
      `UPDATE alerts SET status = 'rejected', processed_at = ?, response_code = ?, http_status = 422, rejection_reason = ? WHERE alert_id = ?`
    ).bind(new Date().toISOString(), ledger.code, ledger.message, alertId).run();
    return json({ ok: false, status: "rejected", code: ledger.code, message: ledger.message, alert_id: alertId, mode: "PAPER", execution: "DRY_RUN_ONLY", broker_request_sent: false }, 422);
  }

  if (!ledger.ok) {
    // Nothing was committed, so this alert stays retryable: resending the same
    // alert processes it again (see RETRY above).
    await env.DB.prepare(
      `UPDATE alerts
       SET
         status = 'error',
         processed_at = ?,
         response_code = ?,
         http_status = 500,
         rejection_reason = ?
       WHERE alert_id = ?`
    )
      .bind(
        new Date()
          .toISOString(),
        ledger.code,
        ledger.message,
        alertId
      )
      .run();

    await logActivity(env, {
      category: "paper",
      level: "error",
      message:
        ledger.committed
          ? `ALPHA PAPER ledger inconsistent · ${ledger.code}`
          : `Dry-run intent and ALPHA PAPER fill not committed · ${ledger.code} · resend the alert to retry`,
      alertId,
      symbol:
        validation.symbol,
      action:
        validation.action,
      errorDetail:
        ledger.message,
    });

    return json(
      {
        ok: false,
        status: "error",
        code:
          ledger.code,
        message:
          ledger.message,
        alert_id:
          alertId,
        committed:
          ledger.committed,
        retryable:
          !ledger.committed,
        mode: "PAPER",
        execution:
          "DRY_RUN_ONLY",
        broker_request_sent:
          false,
      },
      500
    );
  }

  const dryRunOrder = {
    ok: true,
    duplicate: false,
    clientOrderId,
    order:
      ledger.order,
  };

  await logActivity(env, {
    category: "order",
    level: "info",
    message:
      `Dry-run order intent created · ${riskResult.risk.side.toUpperCase()} ${riskResult.risk.finalQty} · no broker request`,
    alertId,
    symbol:
      validation.symbol,
    action:
      validation.action,
    strategy:
      validation.strategy,
    qty:
      riskResult.risk.finalQty,
  });

  await logActivity(
    env,
    fillActivity(
      ledger,
      commitInput
    )
  );

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

    // Internal simulated ledger, not a broker position.
    paper: {
      label:
        "ALPHA PAPER",
      kind:
        ledger.kind,
      fill:
        ledger.fill,
      position:
        ledger.position,
      trade:
        ledger.trade,
    },
  });
}
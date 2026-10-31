export interface DryRunEnv {
  DB: D1Database;
}

export type DryRunIntent = {
  alertId: string;
  alertFk: number | null;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  orderType: "market";
  timeInForce: "day";
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function clientOrderIdForAlert(
  alertId: string
): Promise<string> {
  const encoded = new TextEncoder().encode(alertId);

  const hash = await crypto.subtle.digest(
    "SHA-256",
    encoded
  );

  const hex = bytesToHex(
    new Uint8Array(hash)
  );

  return `at-${hex.slice(0, 40)}`;
}

export async function createDryRunOrder(
  env: DryRunEnv,
  intent: DryRunIntent
) {
  const now = new Date().toISOString();

  const clientOrderId =
    await clientOrderIdForAlert(
      intent.alertId
    );

  try {
    await env.DB.prepare(
      `INSERT INTO orders
      (
        alert_fk,
        source,
        client_order_id,
        symbol,
        side,
        qty,
        order_type,
        time_in_force,
        status,
        market_open_at_submit,
        submitted_at,
        filled_qty,
        updated_at,
        error_detail
      )
      VALUES (
        ?, 'dry_run', ?, ?, ?, ?, ?, ?,
        'submitting', NULL, ?, '0', ?,
        'DRY RUN: no broker request sent'
      )`
    )
      .bind(
        intent.alertFk,
        clientOrderId,
        intent.symbol,
        intent.side,
        String(intent.qty),
        intent.orderType,
        intent.timeInForce,
        now,
        now
      )
      .run();
  } catch {
    const existing =
      await env.DB.prepare(
        `SELECT
          id,
          client_order_id,
          symbol,
          side,
          qty,
          status,
          submitted_at,
          updated_at,
          error_detail
         FROM orders
         WHERE client_order_id = ?`
      )
        .bind(clientOrderId)
        .first();

    if (existing) {
      return {
        ok: true,
        duplicate: true,
        clientOrderId,
        order: existing,
      };
    }

    throw new Error(
      "Could not persist dry-run order intent"
    );
  }

  // This deliberately happens AFTER the intent is persisted.
  // No Alpaca request is made.
  await env.DB.prepare(
    `UPDATE orders
     SET
       status = 'dry_run_accepted',
       updated_at = ?,
       error_detail =
         'DRY RUN: persisted before simulated acceptance; no broker request sent'
     WHERE client_order_id = ?`
  )
    .bind(
      new Date().toISOString(),
      clientOrderId
    )
    .run();

  const order =
    await env.DB.prepare(
      `SELECT
        id,
        alert_fk,
        source,
        client_order_id,
        symbol,
        side,
        qty,
        order_type,
        time_in_force,
        status,
        submitted_at,
        updated_at,
        error_detail
       FROM orders
       WHERE client_order_id = ?`
    )
      .bind(clientOrderId)
      .first();

  return {
    ok: true,
    duplicate: false,
    clientOrderId,
    order,
  };
}

export async function simulateUnknownState(
  env: DryRunEnv,
  clientOrderId: string
) {
  const now = new Date().toISOString();

  const result =
    await env.DB.prepare(
      `UPDATE orders
       SET
         status = 'unknown',
         updated_at = ?,
         error_detail =
           'DRY RUN simulated timeout: broker state unknown; must reconcile and never resend'
       WHERE client_order_id = ?`
    )
      .bind(now, clientOrderId)
      .run();

  if (
    !result.meta ||
    result.meta.changes === 0
  ) {
    return null;
  }

  return env.DB.prepare(
    `SELECT
      id,
      client_order_id,
      symbol,
      side,
      qty,
      status,
      submitted_at,
      updated_at,
      error_detail
     FROM orders
     WHERE client_order_id = ?`
  )
    .bind(clientOrderId)
    .first();
}

export async function simulateReconcile(
  env: DryRunEnv,
  clientOrderId: string,
  found: boolean
) {
  const now = new Date().toISOString();

  const existing =
    await env.DB.prepare(
      `SELECT
        id,
        status
       FROM orders
       WHERE client_order_id = ?`
    )
      .bind(clientOrderId)
      .first<{
        id: number;
        status: string;
      }>();

  if (!existing) {
    return null;
  }

  if (
    existing.status !== "unknown" &&
    existing.status !== "submitting"
  ) {
    return env.DB.prepare(
      `SELECT *
       FROM orders
       WHERE client_order_id = ?`
    )
      .bind(clientOrderId)
      .first();
  }

  if (found) {
    await env.DB.prepare(
      `UPDATE orders
       SET
         status = 'dry_run_reconciled',
         updated_at = ?,
         error_detail =
           'DRY RUN reconciliation found simulated broker order; original intent was not resent'
       WHERE client_order_id = ?`
    )
      .bind(
        now,
        clientOrderId
      )
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE orders
       SET
         status = 'dry_run_failed',
         updated_at = ?,
         error_detail =
           'DRY RUN reconciliation did not find simulated broker order; marked failed and not resent'
       WHERE client_order_id = ?`
    )
      .bind(
        now,
        clientOrderId
      )
      .run();
  }

  return env.DB.prepare(
    `SELECT
      id,
      client_order_id,
      symbol,
      side,
      qty,
      status,
      submitted_at,
      updated_at,
      error_detail
     FROM orders
     WHERE client_order_id = ?`
  )
    .bind(clientOrderId)
    .first();
}
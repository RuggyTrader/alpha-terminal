import {
  createDryRunOrder,
} from "./dry_run_orders";

interface DryRunWebhookEnv {
  DB: D1Database;

  WEBHOOK_SECRET: string;

  ALPACA_KEY: string;
  ALPACA_SECRET: string;

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

const PAPER =
  "https://paper-api.alpaca.markets";

const DATA =
  "https://data.alpaca.markets";

function json(
  data: unknown,
  status = 200
): Response {
  return Response.json(
    data,
    { status }
  );
}

async function secureEqual(
  a: string,
  b: string
) {
  const encoder =
    new TextEncoder();

  const [aHash, bHash] =
    await Promise.all([
      crypto.subtle.digest(
        "SHA-256",
        encoder.encode(a)
      ),
      crypto.subtle.digest(
        "SHA-256",
        encoder.encode(b)
      ),
    ]);

  const aa =
    new Uint8Array(aHash);

  const bb =
    new Uint8Array(bHash);

  let diff = 0;

  for (
    let i = 0;
    i < aa.length;
    i++
  ) {
    diff |= aa[i] ^ bb[i];
  }

  return diff === 0;
}

function n(
  value: unknown
): number {
  const valueNumber =
    Number(value);

  return Number.isFinite(
    valueNumber
  )
    ? valueNumber
    : 0;
}

function flag(
  value: string
): boolean {
  return (
    value
      .trim()
      .toLowerCase() ===
    "true"
  );
}

function object(
  value: unknown
): Record<
  string,
  unknown
> {
  if (
    value &&
    typeof value ===
      "object" &&
    !Array.isArray(value)
  ) {
    return value as Record<
      string,
      unknown
    >;
  }

  return {};
}

function array(
  value: unknown
): Record<
  string,
  unknown
>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item) =>
      item &&
      typeof item ===
        "object" &&
      !Array.isArray(item)
  ) as Record<
    string,
    unknown
  >[];
}

function headers(
  env: DryRunWebhookEnv
): HeadersInit {
  return {
    "APCA-API-KEY-ID":
      env.ALPACA_KEY,
    "APCA-API-SECRET-KEY":
      env.ALPACA_SECRET,
    Accept:
      "application/json",
  };
}

async function get(
  env: DryRunWebhookEnv,
  url: string,
  allow404 = false
): Promise<
  | {
      ok: true;
      data: unknown;
    }
  | {
      ok: false;
      code: string;
      message: string;
    }
> {
  let response: Response;

  try {
    response =
      await fetch(url, {
        method: "GET",
        headers:
          headers(env),
      });
  } catch {
    return {
      ok: false,
      code:
        "BROKER_UNAVAILABLE",
      message:
        "Could not reach Alpaca PAPER",
    };
  }

  if (
    allow404 &&
    response.status === 404
  ) {
    return {
      ok: true,
      data: null,
    };
  }

  if (
    response.status === 401 ||
    response.status === 403
  ) {
    return {
      ok: false,
      code:
        "BROKER_AUTH_FAILED",
      message:
        "Alpaca PAPER rejected the API keys",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code:
        "BROKER_UNAVAILABLE",
      message:
        `Alpaca PAPER HTTP ${response.status}`,
    };
  }

  try {
    return {
      ok: true,
      data:
        await response.json(),
    };
  } catch {
    return {
      ok: false,
      code:
        "BROKER_UNAVAILABLE",
      message:
        "Alpaca returned invalid JSON",
    };
  }
}

type Intent = {
  symbol: string;
  action:
    | "buy"
    | "sell"
    | "close";
  qty: number | null;
  strategy: string;
};

function validate(
  body: Record<
    string,
    unknown
  >,
  env: DryRunWebhookEnv
):
  | {
      ok: true;
      intent: Intent;
    }
  | {
      ok: false;
      code: string;
      message: string;
    } {
  if (
    typeof body.symbol !==
    "string"
  ) {
    return {
      ok: false,
      code:
        "MISSING_FIELD",
      message:
        "symbol is required",
    };
  }

  let symbol =
    body.symbol
      .trim()
      .toUpperCase();

  if (
    symbol.includes(":")
  ) {
    symbol =
      symbol.split(
        ":",
        2
      )[1];
  }

  if (
    !/^[A-Z][A-Z0-9.]{0,9}$/.test(
      symbol
    )
  ) {
    return {
      ok: false,
      code:
        "INVALID_SYMBOL",
      message:
        "invalid stock symbol",
    };
  }

  const allowed =
    env.ALLOWED_SYMBOLS
      .split(",")
      .map(
        (s) =>
          s
            .trim()
            .toUpperCase()
      );

  if (
    !allowed.includes(
      symbol
    )
  ) {
    return {
      ok: false,
      code:
        "INVALID_SYMBOL",
      message:
        `${symbol} is not allowed`,
    };
  }

  if (
    typeof body.action !==
    "string"
  ) {
    return {
      ok: false,
      code:
        "MISSING_FIELD",
      message:
        "action is required",
    };
  }

  const action =
    body.action
      .trim()
      .toLowerCase();

  if (
    action !== "buy" &&
    action !== "sell" &&
    action !== "close"
  ) {
    return {
      ok: false,
      code:
        "INVALID_ACTION",
      message:
        "action must be buy, sell or close",
    };
  }

  let qty:
    number | null =
    null;

  if (action !== "close") {
    qty =
      Number(body.qty);

    if (
      !Number.isFinite(
        qty
      ) ||
      qty <= 0
    ) {
      return {
        ok: false,
        code:
          "INVALID_QUANTITY",
        message:
          "qty must be greater than zero",
      };
    }

    if (
      !flag(
        env.ALLOW_FRACTIONAL_QTY
      ) &&
      !Number.isInteger(
        qty
      )
    ) {
      return {
        ok: false,
        code:
          "INVALID_QUANTITY",
        message:
          "fractional quantities are disabled",
      };
    }
  }

  return {
    ok: true,
    intent: {
      symbol,
      action:
        action as
          | "buy"
          | "sell"
          | "close",
      qty,
      strategy:
        String(
          body.strategy ??
          "UNSPECIFIED"
        ).slice(0, 64),
    },
  };
}

export async function
handleDryRunWebhook(
  request: Request,
  env: DryRunWebhookEnv
): Promise<Response> {
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

  if (
    typeof body.secret !==
      "string" ||
    !(await secureEqual(
      body.secret,
      env.WEBHOOK_SECRET
    ))
  ) {
    return json(
      {
        ok: false,
        code:
          "UNAUTHORIZED",
      },
      401
    );
  }

  const alertId =
    String(
      body.id ?? ""
    ).trim();

  if (
    !/^[\x21-\x7E]{1,128}$/.test(
      alertId
    )
  ) {
    return json(
      {
        ok: false,
        code:
          "INVALID_ALERT_ID",
      },
      400
    );
  }

  const existing =
    await env.DB.prepare(
      `SELECT
         alert_id,
         status,
         response_code
       FROM alerts
       WHERE alert_id=?`
    )
      .bind(alertId)
      .first();

  if (existing) {
    return json({
      ok: true,
      status:
        "duplicate",
      code:
        "DUPLICATE",
      alert_id:
        alertId,
      broker_request_sent:
        false,
    });
  }

  const validation =
    validate(
      body,
      env
    );

  if (!validation.ok) {
    return json(
      validation,
      400
    );
  }

  const now =
    new Date()
      .toISOString();

  const sanitized = {
    ...body,
  };

  delete sanitized.secret;

  await env.DB.prepare(
    `INSERT INTO alerts
    (
      alert_id,
      received_at,
      symbol,
      action,
      strategy,
      payload_json,
      status,
      validation_result
    )
    VALUES (
      ?, ?, ?, ?, ?, ?,
      'processing',
      'passed'
    )`
  )
    .bind(
      alertId,
      now,
      validation.intent
        .symbol,
      validation.intent
        .action,
      validation.intent
        .strategy,
      JSON.stringify(
        sanitized
      ).slice(
        0,
        4000
      )
    )
    .run();

  const accountResult =
    await get(
      env,
      `${PAPER}/v2/account`
    );

  if (!accountResult.ok) {
    return json(
      accountResult,
      502
    );
  }

  const positionsResult =
    await get(
      env,
      `${PAPER}/v2/positions`
    );

  if (!positionsResult.ok) {
    return json(
      positionsResult,
      502
    );
  }

  const positionResult =
    await get(
      env,
      `${PAPER}/v2/positions/${encodeURIComponent(
        validation.intent
          .symbol
      )}`,
      true
    );

  if (!positionResult.ok) {
    return json(
      positionResult,
      502
    );
  }

  const account =
    object(
      accountResult.data
    );

  const positions =
    array(
      positionsResult.data
    );

  const position =
    positionResult.data ===
      null
      ? null
      : object(
          positionResult.data
        );

  const posQty =
    position
      ? n(position.qty)
      : 0;

  const available =
    position
      ? Math.abs(
          n(
            position.qty_available ??
              position.qty
          )
        )
      : 0;

  let side:
    "buy" | "sell";

  let finalQty: number;

  if (
    validation.intent
      .action ===
    "close"
  ) {
    if (posQty === 0) {
      await env.DB.prepare(
        `UPDATE alerts
         SET
           status='rejected',
           processed_at=?,
           response_code='NO_POSITION',
           rejection_reason='no open PAPER position to close'
         WHERE alert_id=?`
      )
        .bind(
          now,
          alertId
        )
        .run();

      return json(
        {
          ok: false,
          code:
            "NO_POSITION",
          broker_request_sent:
            false,
        },
        422
      );
    }

    side =
      posQty > 0
        ? "sell"
        : "buy";

    finalQty =
      available;
  } else {
    finalQty =
      validation.intent
        .qty ?? 0;

    if (
      finalQty >
      Number(
        env.MAX_ORDER_QTY
      )
    ) {
      return json(
        {
          ok: false,
          code:
            "MAX_ORDER_QTY",
          broker_request_sent:
            false,
        },
        422
      );
    }

    if (
      validation.intent
        .action ===
      "sell"
    ) {
      if (
        posQty <= 0 &&
        !flag(
          env.SHORT_SELLING_ENABLED
        )
      ) {
        return json(
          {
            ok: false,
            code:
              "NO_POSITION",
            broker_request_sent:
              false,
          },
          422
        );
      }

      if (
        posQty > 0 &&
        finalQty >
          posQty
      ) {
        return json(
          {
            ok: false,
            code:
              "SELL_EXCEEDS_POSITION",
            broker_request_sent:
              false,
          },
          422
        );
      }

      side = "sell";
    } else {
      side = "buy";
    }
  }

  let price:
    number | null =
    null;

  if (
    side === "buy" ||
    (
      side === "sell" &&
      posQty <= 0
    )
  ) {
    const priceResult =
      await get(
        env,
        `${DATA}/v2/stocks/${encodeURIComponent(
          validation.intent
            .symbol
        )}/trades/latest?feed=iex`
      );

    if (
      !priceResult.ok
    ) {
      return json(
        priceResult,
        502
      );
    }

    const priceBody =
      object(
        priceResult.data
      );

    const trade =
      object(
        priceBody.trade
      );

    price =
      n(trade.p);

    if (
      !price ||
      price <= 0
    ) {
      return json(
        {
          ok: false,
          code:
            "MARKET_DATA_UNAVAILABLE",
        },
        422
      );
    }

    const notional =
      finalQty *
      price;

    if (
      notional >
      Number(
        env.MAX_ORDER_NOTIONAL
      )
    ) {
      return json(
        {
          ok: false,
          code:
            "MAX_ORDER_NOTIONAL",
          broker_request_sent:
            false,
        },
        422
      );
    }

    if (
      notional >
      n(
        account.buying_power
      )
    ) {
      return json(
        {
          ok: false,
          code:
            "INSUFFICIENT_BUYING_POWER",
          broker_request_sent:
            false,
        },
        422
      );
    }

    const exposure =
      positions.reduce(
        (
          total,
          item
        ) =>
          total +
          Math.abs(
            n(
              item.market_value
            )
          ),
        0
      ) +
      notional;

    if (
      exposure >
      Number(
        env.MAX_TOTAL_EXPOSURE
      )
    ) {
      return json(
        {
          ok: false,
          code:
            "MAX_TOTAL_EXPOSURE",
          broker_request_sent:
            false,
        },
        422
      );
    }

    const today =
      n(account.equity) -
      n(
        account.last_equity
      );

    if (
      Number(
        env.DAILY_LOSS_LIMIT
      ) > 0 &&
      today <=
        -Number(
          env.DAILY_LOSS_LIMIT
        )
    ) {
      return json(
        {
          ok: false,
          code:
            "DAILY_LOSS_LIMIT",
          broker_request_sent:
            false,
        },
        422
      );
    }
  }

  const alertRow =
    await env.DB.prepare(
      `SELECT id
       FROM alerts
       WHERE alert_id=?`
    )
      .bind(alertId)
      .first<{
        id: number;
      }>();

  const order =
    await createDryRunOrder(
      env,
      {
        alertId,
        alertFk:
          alertRow?.id ??
          null,
        symbol:
          validation.intent
            .symbol,
        side,
        qty:
          finalQty,
        orderType:
          "market",
        timeInForce:
          "day",
      }
    );

  await env.DB.prepare(
    `UPDATE alerts
     SET
       status='dry_run',
       processed_at=?,
       accepted_qty=?,
       response_code='DRY_RUN_ACCEPTED',
       http_status=200,
       rejection_reason=NULL
     WHERE alert_id=?`
  )
    .bind(
      new Date()
        .toISOString(),
      String(finalQty),
      alertId
    )
    .run();

  return json({
    ok: true,
    status:
      "dry_run",
    code:
      "DRY_RUN_ACCEPTED",
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
        validation.intent
          .symbol,
      side,
      qty:
        finalQty,
      strategy:
        validation.intent
          .strategy,
    },
    reference_price:
      price,
    order,
  });
}
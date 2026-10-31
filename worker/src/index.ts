interface Env {
  DB: D1Database;

  ENABLE_TRADING: string;

  WEBHOOK_SECRET: string;
  ADMIN_SECRET: string;

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

const ALPACA_PAPER_BASE =
  "https://paper-api.alpaca.markets";

const ALPACA_DATA_BASE =
  "https://data.alpaca.markets";

// ------------------------------------------------------------
// BASIC HELPERS
// ------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function num(value: unknown): number {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return 0;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : 0;
}

function boolEnv(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

function asObject(
  value: unknown
): Record<string, unknown> {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }

  return {};
}

function asArray(
  value: unknown
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (v) =>
        v &&
        typeof v === "object" &&
        !Array.isArray(v)
    )
    .map(
      (v) => v as Record<string, unknown>
    );
}

async function secureEqual(
  a: string,
  b: string
): Promise<boolean> {
  const encoder = new TextEncoder();

  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(a)
    ),
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(b)
    ),
  ]);

  const aa = new Uint8Array(aHash);
  const bb = new Uint8Array(bHash);

  let diff = 0;

  for (let i = 0; i < aa.length; i++) {
    diff |= aa[i] ^ bb[i];
  }

  return diff === 0;
}

// ------------------------------------------------------------
// ADMIN AUTH
// ------------------------------------------------------------

async function requireAdmin(
  request: Request,
  env: Env
): Promise<Response | null> {
  const supplied =
    request.headers.get("x-admin-secret");

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
        status: "rejected",
        code: "UNAUTHORIZED",
        message: "invalid admin secret",
      },
      401
    );
  }

  return null;
}

// ------------------------------------------------------------
// ENGINE STATE
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// ALPACA PAPER READ-ONLY CLIENT
// ------------------------------------------------------------

function alpacaHeaders(
  env: Env
): HeadersInit {
  return {
    "APCA-API-KEY-ID":
      env.ALPACA_KEY,
    "APCA-API-SECRET-KEY":
      env.ALPACA_SECRET,
    Accept: "application/json",
  };
}

type AlpacaResult =
  | {
      ok: true;
      status: number;
      data: unknown;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    };

async function alpacaGet(
  env: Env,
  url: string,
  allow404 = false
): Promise<AlpacaResult> {
  if (
    !env.ALPACA_KEY ||
    !env.ALPACA_SECRET
  ) {
    return {
      ok: false,
      status: 503,
      code: "BROKER_NOT_CONFIGURED",
      message:
        "Alpaca PAPER keys are not configured on the server",
    };
  }

  let response: Response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: alpacaHeaders(env),
    });
  } catch {
    return {
      ok: false,
      status: 502,
      code: "BROKER_UNAVAILABLE",
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
      status: 404,
      data: null,
    };
  }

  if (
    response.status === 401 ||
    response.status === 403
  ) {
    return {
      ok: false,
      status: 502,
      code: "BROKER_AUTH_FAILED",
      message:
        "Alpaca PAPER rejected the API keys",
    };
  }

  if (response.status === 429) {
    return {
      ok: false,
      status: 502,
      code: "BROKER_UNAVAILABLE",
      message:
        "Alpaca PAPER rate limit reached",
    };
  }

  if (response.status >= 500) {
    return {
      ok: false,
      status: 502,
      code: "BROKER_UNAVAILABLE",
      message:
        "Alpaca PAPER returned a server error",
    };
  }

  if (response.status >= 400) {
    let message =
      "Alpaca PAPER rejected the request";

    try {
      const body =
        (await response.json()) as {
          message?: string;
        };

      if (body?.message) {
        message =
          String(body.message).slice(
            0,
            500
          );
      }
    } catch {}

    return {
      ok: false,
      status: 422,
      code: "BROKER_REJECTED",
      message,
    };
  }

  try {
    return {
      ok: true,
      status: response.status,
      data: await response.json(),
    };
  } catch {
    return {
      ok: false,
      status: 502,
      code: "BROKER_UNAVAILABLE",
      message:
        "Alpaca PAPER returned invalid JSON",
    };
  }
}

// ------------------------------------------------------------
// ALERT VALIDATION
// ------------------------------------------------------------

type ValidIntent = {
  ok: true;
  symbol: string;
  action:
    | "buy"
    | "sell"
    | "close";
  qty: number | null;
  strategy: string;
  orderType: "market";
  timeInForce: "day";
};

type InvalidIntent = {
  ok: false;
  code: string;
  message: string;
};

type ValidationResult =
  | ValidIntent
  | InvalidIntent;

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
      message:
        "symbol is required",
    };
  }

  if (
    typeof rawSymbol !== "string"
  ) {
    return {
      ok: false,
      code: "INVALID_SYMBOL",
      message:
        "symbol must be a string",
    };
  }

  let symbol =
    rawSymbol
      .trim()
      .toUpperCase();

  if (symbol.includes(":")) {
    symbol =
      symbol.split(":", 2)[1];
  }

  if (
    !/^[A-Z][A-Z0-9.]{0,9}$/.test(
      symbol
    )
  ) {
    return {
      ok: false,
      code: "INVALID_SYMBOL",
      message:
        "symbol format is not a supported stock ticker",
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
      )
      .filter(Boolean);

  if (!allowed.includes(symbol)) {
    return {
      ok: false,
      code: "INVALID_SYMBOL",
      message:
        `${symbol} is not in the allowed symbol list`,
    };
  }

  const rawAction =
    body.action;

  if (
    rawAction === undefined ||
    rawAction === null ||
    rawAction === ""
  ) {
    return {
      ok: false,
      code: "MISSING_FIELD",
      message:
        "action is required",
    };
  }

  if (
    typeof rawAction !== "string"
  ) {
    return {
      ok: false,
      code: "INVALID_ACTION",
      message:
        "action must be buy, sell or close",
    };
  }

  const action =
    rawAction
      .trim()
      .toLowerCase();

  if (
    ![
      "buy",
      "sell",
      "close",
    ].includes(action)
  ) {
    return {
      ok: false,
      code: "INVALID_ACTION",
      message:
        "action must be buy, sell or close",
    };
  }

  const rawOrderType =
    body.order_type !== undefined
      ? body.order_type
      : body.type ?? "market";

  if (
    typeof rawOrderType !==
      "string" ||
    rawOrderType
      .trim()
      .toLowerCase() !==
      "market"
  ) {
    return {
      ok: false,
      code:
        "UNSUPPORTED_ORDER_TYPE",
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
    rawTif
      .trim()
      .toLowerCase() !== "day"
  ) {
    return {
      ok: false,
      code:
        "UNSUPPORTED_TIME_IN_FORCE",
      message:
        "only time_in_force=day is supported",
    };
  }

  let qty: number | null =
    null;

  if (
    action === "buy" ||
    action === "sell"
  ) {
    if (
      body.qty === undefined ||
      body.qty === null ||
      body.qty === ""
    ) {
      return {
        ok: false,
        code: "MISSING_FIELD",
        message:
          "qty is required for buy and sell",
      };
    }

    if (
      typeof body.qty !==
        "number" &&
      typeof body.qty !==
        "string"
    ) {
      return {
        ok: false,
        code:
          "INVALID_QUANTITY",
        message:
          "qty must be a number",
      };
    }

    qty = Number(body.qty);

    if (
      !Number.isFinite(qty)
    ) {
      return {
        ok: false,
        code:
          "INVALID_QUANTITY",
        message:
          "qty must be a finite number",
      };
    }

    if (qty <= 0) {
      return {
        ok: false,
        code:
          "INVALID_QUANTITY",
        message:
          "qty must be greater than zero",
      };
    }

    if (
      !boolEnv(
        env.ALLOW_FRACTIONAL_QTY
      ) &&
      !Number.isInteger(qty)
    ) {
      return {
        ok: false,
        code:
          "INVALID_QUANTITY",
        message:
          "fractional quantities are disabled (ALLOW_FRACTIONAL_QTY=false)",
      };
    }
  }

  const strategy =
    body.strategy ===
      undefined ||
    body.strategy === null
      ? "UNSPECIFIED"
      : String(body.strategy)
          .trim()
          .slice(0, 64) ||
        "UNSPECIFIED";

  return {
    ok: true,
    symbol,
    action:
      action as
        | "buy"
        | "sell"
        | "close",
    qty,
    strategy,
    orderType: "market",
    timeInForce: "day",
  };
}

// ------------------------------------------------------------
// RISK ENGINE
// Mirrors v1.1.0 PAPER risk rules.
// ------------------------------------------------------------

type RiskCheck = {
  check: string;
  passed: boolean;
  detail: string;
};

type RiskResult = {
  approved: boolean;
  code: string;
  reason: string;
  side: string | null;
  finalQty: number | null;
  referencePrice:
    | number
    | null;
  estimatedNotional:
    | number
    | null;
  checks: RiskCheck[];
};

function evaluateRisk(
  intent: ValidIntent,
  env: Env,
  account:
    Record<string, unknown>,
  position:
    Record<string, unknown> | null,
  positions:
    Record<string, unknown>[],
  price: number | null
): RiskResult {
  const checks: RiskCheck[] = [];

  const add = (
    check: string,
    passed: boolean,
    detail: string
  ): boolean => {
    checks.push({
      check,
      passed,
      detail,
    });

    return passed;
  };

  const reject = (
    code: string,
    reason: string
  ): RiskResult => ({
    approved: false,
    code,
    reason,
    side: null,
    finalQty: null,
    referencePrice: price,
    estimatedNotional: null,
    checks,
  });

  // ACCOUNT STATUS

  const accountStatus =
    String(
      account.status ?? ""
    ).toUpperCase();

  if (
    !add(
      "account_active",
      accountStatus === "ACTIVE",
      `account status ${
        accountStatus ||
        "UNKNOWN"
      }`
    )
  ) {
    return reject(
      "ACCOUNT_RESTRICTED",
      `PAPER account status is ${
        accountStatus ||
        "UNKNOWN"
      }`
    );
  }

  const blocked =
    Boolean(
      account.trading_blocked
    ) ||
    Boolean(
      account.account_blocked
    );

  if (
    !add(
      "account_not_blocked",
      !blocked,
      "trading_blocked/account_blocked flags"
    )
  ) {
    return reject(
      "ACCOUNT_RESTRICTED",
      "PAPER account is blocked from trading"
    );
  }

  const posQty =
    position
      ? num(position.qty)
      : 0;

  const posAvailable =
    position
      ? Math.abs(
          num(
            position.qty_available ??
              position.qty
          )
        )
      : 0;

  // CLOSE
  // Risk reducing only.

  if (
    intent.action === "close"
  ) {
    if (
      !add(
        "position_exists",
        posQty !== 0,
        `current position ${posQty}`
      )
    ) {
      return reject(
        "NO_POSITION",
        `no open PAPER position in ${intent.symbol} to close`
      );
    }

    if (
      !add(
        "qty_available",
        posAvailable > 0,
        `available ${posAvailable}`
      )
    ) {
      return reject(
        "POSITION_LOCKED",
        "All shares are held by other open orders; nothing to close"
      );
    }

    const side =
      posQty > 0
        ? "sell"
        : "buy";

    add(
      "close_only_existing",
      true,
      `closes ${posAvailable} of ${Math.abs(
        posQty
      )} (risk-reducing; exposure limits not applied)`
    );

    return {
      approved: true,
      code: "APPROVED",
      reason: "CLOSE approved",
      side,
      finalQty:
        posAvailable,
      referencePrice: price,
      estimatedNotional:
        null,
      checks,
    };
  }

  const qty =
    intent.qty ?? 0;

  // MAX ORDER QTY

  const maxOrderQty =
    Number(env.MAX_ORDER_QTY);

  if (
    !add(
      "max_order_qty",
      qty <= maxOrderQty,
      `${qty} <= ${maxOrderQty}`
    )
  ) {
    return reject(
      "MAX_ORDER_QTY",
      `qty ${qty} is above the maximum order quantity ${maxOrderQty}`
    );
  }

  // SELL REDUCING LONG

  if (
    intent.action === "sell" &&
    posQty > 0
  ) {
    if (
      !add(
        "sell_within_position",
        qty <= posQty,
        `sell ${qty} <= position ${posQty}`
      )
    ) {
      return reject(
        "SELL_EXCEEDS_POSITION",
        `SELL ${qty} is greater than the open long position ${posQty}; it would create a short`
      );
    }

    if (
      !add(
        "sell_within_available",
        qty <= posAvailable,
        `sell ${qty} <= available ${posAvailable}`
      )
    ) {
      return reject(
        "SELL_EXCEEDS_AVAILABLE",
        `Only ${posAvailable} shares are available (others held by orders)`
      );
    }

    add(
      "risk_reducing",
      true,
      "sell reduces an existing long; exposure limits not applied"
    );

    return {
      approved: true,
      code: "APPROVED",
      reason: "SELL approved",
      side: "sell",
      finalQty: qty,
      referencePrice: price,
      estimatedNotional:
        null,
      checks,
    };
  }

  let side: "buy" | "sell";

  // SELL WHEN FLAT/SHORT

  if (
    intent.action === "sell"
  ) {
    const shortEnabled =
      boolEnv(
        env.SHORT_SELLING_ENABLED
      );

    if (
      !add(
        "short_selling_enabled",
        shortEnabled,
        "SHORT_SELLING_ENABLED"
      )
    ) {
      if (posQty === 0) {
        return reject(
          "NO_POSITION",
          `no open long position in ${intent.symbol}`
        );
      }

      return reject(
        "SHORT_DISABLED",
        "SELL would increase a short position; short selling is disabled"
      );
    }

    if (
      !add(
        "account_shorting_enabled",
        Boolean(
          account.shorting_enabled
        ),
        "Alpaca shorting_enabled"
      )
    ) {
      return reject(
        "SHORT_DISABLED",
        "Alpaca PAPER account does not allow shorting"
      );
    }

    side = "sell";
  } else {
    // BUY

    if (
      !add(
        "no_short_present",
        posQty >= 0,
        `current position ${posQty}`
      )
    ) {
      return reject(
        "SHORT_POSITION_PRESENT",
        "BUY would cover a short position; ALPHA TERMINAL does not reverse positions automatically"
      );
    }

    side = "buy";
  }

  // EXPOSURE-INCREASING ORDER
  // Price is required.

  if (
    !add(
      "market_data_available",
      price !== null &&
        price > 0,
      "latest trade price for notional estimate"
    )
  ) {
    return reject(
      "MARKET_DATA_UNAVAILABLE",
      "No market price available to verify order notional"
    );
  }

  const safePrice =
    price as number;

  const notional =
    Math.round(
      qty *
        safePrice *
        100
    ) / 100;

  // MAX ORDER NOTIONAL

  const maxOrderNotional =
    Number(
      env.MAX_ORDER_NOTIONAL
    );

  if (
    !add(
      "max_order_notional",
      notional <=
        maxOrderNotional,
      `${notional} <= ${maxOrderNotional}`
    )
  ) {
    return reject(
      "MAX_ORDER_NOTIONAL",
      `Estimated notional $${notional} is above the limit $${maxOrderNotional}`
    );
  }

  // POSITION EXPOSURE

  const currentPositionValue =
    position
      ? Math.abs(
          num(
            position.market_value
          )
        )
      : 0;

  const newPositionExposure =
    currentPositionValue +
    notional;

  const maxPositionExposure =
    Number(
      env.MAX_POSITION_EXPOSURE
    );

  if (
    !add(
      "max_position_exposure",
      newPositionExposure <=
        maxPositionExposure,
      `${newPositionExposure} <= ${maxPositionExposure}`
    )
  ) {
    return reject(
      "MAX_POSITION_EXPOSURE",
      `Position exposure would be $${newPositionExposure}, above $${maxPositionExposure}`
    );
  }

  // TOTAL EXPOSURE

  const currentTotalExposure =
    positions.reduce(
      (total, p) =>
        total +
        Math.abs(
          num(p.market_value)
        ),
      0
    );

  const newTotalExposure =
    currentTotalExposure +
    notional;

  const maxTotalExposure =
    Number(
      env.MAX_TOTAL_EXPOSURE
    );

  if (
    !add(
      "max_total_exposure",
      newTotalExposure <=
        maxTotalExposure,
      `${newTotalExposure} <= ${maxTotalExposure}`
    )
  ) {
    return reject(
      "MAX_TOTAL_EXPOSURE",
      `Total PAPER exposure would be $${newTotalExposure}, above $${maxTotalExposure}`
    );
  }

  // OPEN POSITION COUNT

  const openCount =
    positions.filter(
      (p) =>
        num(p.qty) !== 0
    ).length;

  if (
    !position ||
    posQty === 0
  ) {
    const maxOpenPositions =
      Number(
        env.MAX_OPEN_POSITIONS
      );

    if (
      !add(
        "max_open_positions",
        openCount <
          maxOpenPositions,
        `${openCount} open < ${maxOpenPositions}`
      )
    ) {
      return reject(
        "MAX_OPEN_POSITIONS",
        `Already at the maximum of ${maxOpenPositions} open positions`
      );
    }
  }

  // BUYING POWER

  const buyingPower =
    num(
      account.buying_power
    );

  if (
    !add(
      "buying_power",
      notional <=
        buyingPower,
      `${notional} <= ${buyingPower}`
    )
  ) {
    return reject(
      "INSUFFICIENT_BUYING_POWER",
      `Estimated $${notional} exceeds PAPER buying power $${buyingPower}`
    );
  }

  // DAILY LOSS LIMIT

  const dailyLossLimit =
    Number(
      env.DAILY_LOSS_LIMIT
    );

  if (
    dailyLossLimit > 0
  ) {
    const todaysPnl =
      num(account.equity) -
      num(
        account.last_equity
      );

    const allowed =
      todaysPnl >
      -dailyLossLimit;

    if (
      !add(
        "daily_loss_limit",
        allowed,
        `today ${todaysPnl} > -${dailyLossLimit}`
      )
    ) {
      return reject(
        "DAILY_LOSS_LIMIT",
        `Today's PAPER P&L ${todaysPnl} hit the daily loss limit`
      );
    }
  }

  return {
    approved: true,
    code: "APPROVED",
    reason:
      `${intent.action.toUpperCase()} approved`,
    side,
    finalQty: qty,
    referencePrice:
      safePrice,
    estimatedNotional:
      notional,
    checks,
  };
}

// ------------------------------------------------------------
// FETCH REAL PAPER SNAPSHOT + EVALUATE
// ------------------------------------------------------------

async function runRiskEvaluation(
  env: Env,
  intent: ValidIntent
): Promise<
  | {
      ok: true;
      risk: RiskResult;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    }
> {
  const [
    accountResult,
    positionsResult,
    positionResult,
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
      `${ALPACA_PAPER_BASE}/v2/positions/${encodeURIComponent(
        intent.symbol
      )}`,
      true
    ),
  ]);

  if (!accountResult.ok) {
    return accountResult;
  }

  if (!positionsResult.ok) {
    return positionsResult;
  }

  if (!positionResult.ok) {
    return positionResult;
  }

  const account =
    asObject(
      accountResult.data
    );

  const positions =
    asArray(
      positionsResult.data
    );

  const position =
    positionResult.data === null
      ? null
      : asObject(
          positionResult.data
        );

  let price: number | null =
    null;

  const needsPrice =
    intent.action === "buy" ||
    (
      intent.action === "sell" &&
      (
        position === null ||
        num(position.qty) <= 0
      )
    );

  if (needsPrice) {
    const priceResult =
      await alpacaGet(
        env,
        `${ALPACA_DATA_BASE}/v2/stocks/${encodeURIComponent(
          intent.symbol
        )}/trades/latest?feed=iex`
      );

    if (priceResult.ok) {
      const priceBody =
        asObject(
          priceResult.data
        );

      const trade =
        asObject(
          priceBody.trade
        );

      const p =
        num(trade.p);

      price =
        p > 0 ? p : null;
    }
  }

  return {
    ok: true,
    risk: evaluateRisk(
      intent,
      env,
      account,
      position,
      positions,
      price
    ),
  };
}

// ------------------------------------------------------------
// PERSIST RISK RESULT
// ------------------------------------------------------------

async function saveRiskDecision(
  env: Env,
  alertFk: number | null,
  risk: RiskResult
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO risk_decisions
    (
      alert_fk,
      decided_at,
      approved,
      code,
      reason,
      side,
      final_qty,
      reference_price,
      reference_price_time,
      estimated_notional,
      checks_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      alertFk,
      new Date().toISOString(),
      risk.approved ? 1 : 0,
      risk.code,
      risk.reason,
      risk.side,
      risk.finalQty === null
        ? null
        : String(
            risk.finalQty
          ),
      risk.referencePrice === null
        ? null
        : String(
            risk.referencePrice
          ),
      risk.referencePrice === null
        ? null
        : new Date().toISOString(),
      risk.estimatedNotional ===
        null
        ? null
        : String(
            risk.estimatedNotional
          ),
      JSON.stringify(
        risk.checks
      )
    )
    .run();
}

// ------------------------------------------------------------
// ENGINE CONTROLS
// ------------------------------------------------------------

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
    new Date().toISOString();

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
    pathname === "/kill"
  ) {
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
      code:
        "KILL_SWITCH_ACTIVE",
      message:
        "New PAPER orders blocked. Existing positions and open orders were not touched.",
      data:
        await getEngine(env),
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
         reason = 'Kill switch reset; engine remains STOPPED until started'
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
        await getEngine(env),
    });
  }

  if (
    pathname ===
    "/engine/start"
  ) {
    if (
      current.kill_switch === 1
    ) {
      return json(
        {
          ok: false,
          status: "rejected",
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
          status: "rejected",
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
          status: "rejected",
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
          status: "rejected",
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
      current.kill_switch === 1
    ) {
      return json(
        {
          ok: false,
          status: "rejected",
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
          status: "rejected",
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
    data: updated,
  });
}

// ------------------------------------------------------------
// MAIN WORKER
// ------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const url =
      new URL(request.url);

    // --------------------------------------------------------
    // HEALTH
    // --------------------------------------------------------

    if (
      url.pathname ===
        "/health" &&
      request.method === "GET"
    ) {
      try {
        const db =
          await env.DB.prepare(
            "SELECT 1 AS ok"
          ).first<{
            ok: number;
          }>();

        return json({
          ok: true,
          service:
            "alpha-terminal-api",
          mode: "PAPER",
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
            await getEngine(env),
        });
      } catch {
        return json(
          {
            ok: false,
            service:
              "alpha-terminal-api",
            mode: "PAPER",
            database: "error",
            enable_trading:
              false,
          },
          500
        );
      }
    }

    // --------------------------------------------------------
    // READ-ONLY BROKER ENDPOINTS
    // --------------------------------------------------------

    if (
      request.method ===
        "GET" &&
      [
        "/api/broker/account",
        "/api/broker/positions",
        "/api/broker/clock",
      ].includes(url.pathname)
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      let target: string;

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

      if (!result.ok) {
        return json(
          {
            ok: false,
            status: "error",
            code: result.code,
            message:
              result.message,
          },
          result.status
        );
      }

      return json({
        ok: true,
        status: "ok",
        mode: "PAPER",
        data: result.data,
      });
    }

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
        decodeURIComponent(
          url.pathname.slice(
            "/api/broker/price/"
              .length
          )
        )
          .trim()
          .toUpperCase();

      if (
        !/^[A-Z][A-Z0-9.]{0,9}$/.test(
          symbol
        )
      ) {
        return json(
          {
            ok: false,
            status:
              "rejected",
            code:
              "INVALID_SYMBOL",
            message:
              "invalid stock symbol",
          },
          400
        );
      }

      const result =
        await alpacaGet(
          env,
          `${ALPACA_DATA_BASE}/v2/stocks/${encodeURIComponent(
            symbol
          )}/trades/latest?feed=iex`
        );

      if (!result.ok) {
        return json(
          {
            ok: false,
            status: "error",
            code: result.code,
            message:
              result.message,
          },
          result.status
        );
      }

      return json({
        ok: true,
        status: "ok",
        mode: "PAPER",
        symbol,
        data: result.data,
      });
    }

    // --------------------------------------------------------
    // READ-ONLY RISK PREVIEW
    // --------------------------------------------------------

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

      if (!validation.ok) {
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

      if (!result.ok) {
        return json(
          {
            ok: false,
            status: "error",
            code: result.code,
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
        status: "ok",
        mode: "PAPER",
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

    // --------------------------------------------------------
    // ENGINE CONTROLS
    // --------------------------------------------------------

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
      ].includes(url.pathname)
    ) {
      return handleEngineControl(
        request,
        env,
        url.pathname
      );
    }

    // --------------------------------------------------------
    // TRADINGVIEW WEBHOOK
    // --------------------------------------------------------

    if (
      url.pathname ===
        "/webhook" &&
      request.method ===
        "POST"
    ) {
      const now =
        new Date().toISOString();

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

      // ALERT ID

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

      // CLAIM ALERT

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
            status:
              "duplicate",
            code: "DUPLICATE",
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
            status: "error",
            code:
              "DATABASE_ERROR",
            message:
              "Could not persist alert",
          },
          500
        );
      }

      // VALIDATE

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

      // ENGINE GATE

      const engine =
        await getEngine(env);

      if (
        engine?.kill_switch ===
        1
      ) {
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
          .bind(
            now,
            alertId
          )
          .run();

        return json(
          {
            ok: false,
            status:
              "rejected",
            code:
              "KILL_SWITCH_ACTIVE",
            message:
              "Kill switch is active; new PAPER orders are blocked",
            alert_id:
              alertId,
          },
          403
        );
      }

      if (
        !engine ||
        engine.state ===
          "STOPPED"
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
          .bind(
            now,
            alertId
          )
          .run();

        return json(
          {
            ok: false,
            status:
              "rejected",
            code:
              "ENGINE_STOPPED",
            message:
              "Execution engine is STOPPED; no PAPER order submitted",
            alert_id:
              alertId,
          },
          403
        );
      }

      if (
        engine.state ===
        "PAUSED"
      ) {
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
          .bind(
            now,
            alertId
          )
          .run();

        return json(
          {
            ok: false,
            status:
              "rejected",
            code:
              "ENGINE_PAUSED",
            message:
              "Execution engine is PAUSED; no PAPER order submitted",
            alert_id:
              alertId,
          },
          403
        );
      }

      if (
        env.ENABLE_TRADING !==
        "true"
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
          .bind(
            now,
            alertId
          )
          .run();

        return json(
          {
            ok: false,
            status:
              "rejected",
            code:
              "EXECUTION_DISABLED",
            message:
              "ENABLE_TRADING is false on the server",
            alert_id:
              alertId,
          },
          403
        );
      }

      // FULL PAPER RISK CHECK
      // No broker submission exists yet.

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
            now,
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

      await saveRiskDecision(
        env,
        alertRow?.id ?? null,
        riskResult.risk
      );

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
            now,
            riskResult.risk.code,
            riskResult.risk.reason,
            alertId
          )
          .run();

        return json(
          {
            ok: false,
            status:
              "rejected",
            code:
              riskResult.risk
                .code,
            message:
              riskResult.risk
                .reason,
            alert_id:
              alertId,
            data: {
              risk:
                riskResult.risk,
            },
          },
          422
        );
      }

      // IMPORTANT:
      // There is intentionally NO order POST.
      // PAPER execution is not implemented yet.

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
             'Risk approved but broker execution is not enabled in this migration stage'
         WHERE alert_id = ?`
      )
        .bind(
          now,
          riskResult.risk
            .finalQty === null
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
          status: "error",
          code:
            "BROKER_EXECUTION_NOT_IMPLEMENTED",
          message:
            "Risk approved, but broker execution is not enabled in this migration stage",
          alert_id:
            alertId,
          data: {
            risk:
              riskResult.risk,
          },
        },
        503
      );
    }

    return json(
      {
        ok: false,
        code: "NOT_FOUND",
        message:
          "Route not found",
      },
      404
    );
  },
};
export interface TradeCoreEnv {
  DB: D1Database;

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

// ============================================================
// SHARED HELPERS
// ============================================================

export function num(
  value: unknown
): number {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : 0;
}

export function boolEnv(
  value: string
): boolean {
  return (
    value
      .trim()
      .toLowerCase() === "true"
  );
}

export function asObject(
  value: unknown
): Record<string, unknown> {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as Record<
      string,
      unknown
    >;
  }

  return {};
}

export function asArray(
  value: unknown
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item)
  ) as Record<string, unknown>[];
}

export async function secureEqual(
  a: string,
  b: string
): Promise<boolean> {
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

// ============================================================
// PAPER BROKER READ-ONLY CLIENT
// ============================================================

function alpacaHeaders(
  env: TradeCoreEnv
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

export type AlpacaResult =
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

export async function alpacaGet(
  env: TradeCoreEnv,
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
      code:
        "BROKER_NOT_CONFIGURED",
      message:
        "Alpaca PAPER keys are not configured",
    };
  }

  let response: Response;

  try {
    response =
      await fetch(url, {
        method: "GET",
        headers:
          alpacaHeaders(env),
      });
  } catch {
    return {
      ok: false,
      status: 502,
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
      code:
        "BROKER_AUTH_FAILED",
      message:
        "Alpaca PAPER rejected the API keys",
    };
  }

  if (
    response.status === 429
  ) {
    return {
      ok: false,
      status: 502,
      code:
        "BROKER_UNAVAILABLE",
      message:
        "Alpaca PAPER rate limit reached",
    };
  }

  if (
    response.status >= 500
  ) {
    return {
      ok: false,
      status: 502,
      code:
        "BROKER_UNAVAILABLE",
      message:
        "Alpaca PAPER returned a server error",
    };
  }

  if (
    response.status >= 400
  ) {
    let message =
      "Alpaca PAPER rejected the request";

    try {
      const body =
        (await response.json()) as {
          message?: string;
        };

      if (body.message) {
        message =
          String(
            body.message
          ).slice(
            0,
            500
          );
      }
    } catch {}

    return {
      ok: false,
      status: 422,
      code:
        "BROKER_REJECTED",
      message,
    };
  }

  try {
    return {
      ok: true,
      status:
        response.status,
      data:
        await response.json(),
    };
  } catch {
    return {
      ok: false,
      status: 502,
      code:
        "BROKER_UNAVAILABLE",
      message:
        "Alpaca PAPER returned invalid JSON",
    };
  }
}

// ============================================================
// SHARED INTENT VALIDATION
// ============================================================

export type ValidIntent = {
  ok: true;

  symbol: string;

  action:
    | "buy"
    | "sell"
    | "close";

  qty:
    | number
    | null;

  strategy: string;

  orderType:
    "market";

  timeInForce:
    "day";
};

export type InvalidIntent = {
  ok: false;

  code: string;

  message: string;
};

export type ValidationResult =
  | ValidIntent
  | InvalidIntent;

export function validateIntent(
  body:
    Record<
      string,
      unknown
    >,
  env:
    TradeCoreEnv
): ValidationResult {
  const rawSymbol =
    body.symbol;

  if (
    rawSymbol ===
      undefined ||
    rawSymbol === null ||
    rawSymbol === ""
  ) {
    return {
      ok: false,
      code:
        "MISSING_FIELD",
      message:
        "symbol is required",
    };
  }

  if (
    typeof rawSymbol !==
    "string"
  ) {
    return {
      ok: false,
      code:
        "INVALID_SYMBOL",
      message:
        "symbol must be a string",
    };
  }

  let symbol =
    rawSymbol
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
        `${symbol} is not in the allowed symbol list`,
    };
  }

  const rawAction =
    body.action;

  if (
    rawAction ===
      undefined ||
    rawAction === null ||
    rawAction === ""
  ) {
    return {
      ok: false,
      code:
        "MISSING_FIELD",
      message:
        "action is required",
    };
  }

  if (
    typeof rawAction !==
    "string"
  ) {
    return {
      ok: false,
      code:
        "INVALID_ACTION",
      message:
        "action must be buy, sell or close",
    };
  }

  const action =
    rawAction
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

  const rawOrderType =
    body.order_type !==
      undefined
      ? body.order_type
      : body.type ??
        "market";

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
    body.time_in_force !==
      undefined
      ? body.time_in_force
      : "day";

  if (
    typeof rawTif !==
      "string" ||
    rawTif
      .trim()
      .toLowerCase() !==
      "day"
  ) {
    return {
      ok: false,
      code:
        "UNSUPPORTED_TIME_IN_FORCE",
      message:
        "only time_in_force=day is supported",
    };
  }

  let qty:
    number | null =
    null;

  if (
    action === "buy" ||
    action === "sell"
  ) {
    if (
      body.qty ===
        undefined ||
      body.qty === null ||
      body.qty === ""
    ) {
      return {
        ok: false,
        code:
          "MISSING_FIELD",
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

    qty =
      Number(body.qty);

    if (
      !Number.isFinite(
        qty
      )
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
      !Number.isInteger(
        qty
      )
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
      : String(
          body.strategy
        )
          .trim()
          .slice(
            0,
            64
          ) ||
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
    orderType:
      "market",
    timeInForce:
      "day",
  };
}

// ============================================================
// SHARED PAPER RISK ENGINE
// ============================================================

export type RiskCheck = {
  check: string;
  passed: boolean;
  detail: string;
};

export type RiskResult = {
  approved: boolean;

  code: string;

  reason: string;

  side:
    | "buy"
    | "sell"
    | null;

  finalQty:
    | number
    | null;

  referencePrice:
    | number
    | null;

  estimatedNotional:
    | number
    | null;

  checks:
    RiskCheck[];
};

export function evaluateRisk(
  intent:
    ValidIntent,

  env:
    TradeCoreEnv,

  account:
    Record<
      string,
      unknown
    >,

  position:
    Record<
      string,
      unknown
    > | null,

  positions:
    Record<
      string,
      unknown
    >[],

  price:
    number | null
): RiskResult {
  const checks:
    RiskCheck[] = [];

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
    referencePrice:
      price,
    estimatedNotional:
      null,
    checks,
  });

  // ----------------------------------------------------------
  // ACCOUNT STATUS
  // ----------------------------------------------------------

  const accountStatus =
    String(
      account.status ??
        ""
    ).toUpperCase();

  if (
    !add(
      "account_active",
      accountStatus ===
        "ACTIVE",
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
      ? num(
          position.qty
        )
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

  // ----------------------------------------------------------
  // CLOSE
  // ----------------------------------------------------------

  if (
    intent.action ===
    "close"
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
      code:
        "APPROVED",
      reason:
        "CLOSE approved",
      side,
      finalQty:
        posAvailable,
      referencePrice:
        price,
      estimatedNotional:
        null,
      checks,
    };
  }

  const qty =
    intent.qty ?? 0;

  // ----------------------------------------------------------
  // MAX ORDER QTY
  // ----------------------------------------------------------

  const maxOrderQty =
    Number(
      env.MAX_ORDER_QTY
    );

  if (
    !add(
      "max_order_qty",
      qty <=
        maxOrderQty,
      `${qty} <= ${maxOrderQty}`
    )
  ) {
    return reject(
      "MAX_ORDER_QTY",
      `qty ${qty} is above the maximum order quantity ${maxOrderQty}`
    );
  }

  // ----------------------------------------------------------
  // SELL REDUCING EXISTING LONG
  // ----------------------------------------------------------

  if (
    intent.action ===
      "sell" &&
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
        qty <=
          posAvailable,
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
      code:
        "APPROVED",
      reason:
        "SELL approved",
      side:
        "sell",
      finalQty:
        qty,
      referencePrice:
        price,
      estimatedNotional:
        null,
      checks,
    };
  }

  let side:
    "buy" | "sell";

  // ----------------------------------------------------------
  // SELL FROM FLAT / SHORT
  // ----------------------------------------------------------

  if (
    intent.action ===
    "sell"
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
      if (
        posQty === 0
      ) {
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

    side =
      "sell";
  } else {
    // --------------------------------------------------------
    // BUY
    // --------------------------------------------------------

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

    side =
      "buy";
  }

  // ----------------------------------------------------------
  // PRICE REQUIRED FOR EXPOSURE-INCREASING ORDER
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // MAX ORDER NOTIONAL
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // POSITION EXPOSURE
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // TOTAL EXPOSURE
  // ----------------------------------------------------------

  const currentTotalExposure =
    positions.reduce(
      (
        total,
        positionItem
      ) =>
        total +
        Math.abs(
          num(
            positionItem.market_value
          )
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

  // ----------------------------------------------------------
  // OPEN POSITION COUNT
  // ----------------------------------------------------------

  const openCount =
    positions.filter(
      (p) =>
        num(
          p.qty
        ) !== 0
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

  // ----------------------------------------------------------
  // BUYING POWER
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // DAILY LOSS LIMIT
  // ----------------------------------------------------------

  const dailyLossLimit =
    Number(
      env.DAILY_LOSS_LIMIT
    );

  if (
    dailyLossLimit > 0
  ) {
    const todaysPnl =
      num(
        account.equity
      ) -
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
    code:
      "APPROVED",
    reason:
      `${intent.action.toUpperCase()} approved`,
    side,
    finalQty:
      qty,
    referencePrice:
      safePrice,
    estimatedNotional:
      notional,
    checks,
  };
}

// ============================================================
// FETCH REAL PAPER SNAPSHOT + RUN SHARED RISK
// ============================================================

export async function runRiskEvaluation(
  env:
    TradeCoreEnv,

  intent:
    ValidIntent
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

  if (
    !accountResult.ok
  ) {
    return accountResult;
  }

  if (
    !positionsResult.ok
  ) {
    return positionsResult;
  }

  if (
    !positionResult.ok
  ) {
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
    positionResult.data ===
      null
      ? null
      : asObject(
          positionResult.data
        );

  let price:
    number | null =
    null;

  const needsPrice =
    intent.action ===
      "buy" ||
    (
      intent.action ===
        "sell" &&
      (
        position === null ||
        num(
          position.qty
        ) <= 0
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

    if (
      !priceResult.ok
    ) {
      return priceResult;
    }

    const priceBody =
      asObject(
        priceResult.data
      );

    const trade =
      asObject(
        priceBody.trade
      );

    const p =
      num(
        trade.p
      );

    price =
      p > 0
        ? p
        : null;
  }

  return {
    ok: true,

    risk:
      evaluateRisk(
        intent,
        env,
        account,
        position,
        positions,
        price
      ),
  };
}

// ============================================================
// SHARED D1 RISK PERSISTENCE
// ============================================================

export async function saveRiskDecision(
  env:
    TradeCoreEnv,

  alertFk:
    number | null,

  risk:
    RiskResult
): Promise<void> {
  const now =
    new Date()
      .toISOString();

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

      now,

      risk.approved
        ? 1
        : 0,

      risk.code,

      risk.reason,

      risk.side,

      risk.finalQty ===
        null
        ? null
        : String(
            risk.finalQty
          ),

      risk.referencePrice ===
        null
        ? null
        : String(
            risk.referencePrice
          ),

      risk.referencePrice ===
        null
        ? null
        : now,

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
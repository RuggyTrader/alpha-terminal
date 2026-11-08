import {
  getInstrument,
  normalizeSymbol,
  qtyProblem,
  referencePrice,
  type Instrument,
} from "./instruments";

import {
  ledgerRiskSnapshot,
} from "./paper_ledger";

export interface TradeCoreEnv {
  DB: D1Database;

  ALPACA_KEY: string;
  ALPACA_SECRET: string;

  ALLOWED_SYMBOLS: string;

  // Optional loopback override for tests only (see instruments.krakenBase).
  KRAKEN_API_BASE?: string;

  MAX_ORDER_QTY: string;
  MAX_ORDER_NOTIONAL: string;
  // Futures only: ceiling on one order's contract notional (contracts x price x point value), USD.
  MAX_FUTURES_ORDER_NOTIONAL: string;
  MAX_POSITION_EXPOSURE: string;
  MAX_TOTAL_EXPOSURE: string;
  MAX_OPEN_POSITIONS: string;

  SHORT_SELLING_ENABLED: string;
  DAILY_LOSS_LIMIT: string;
}

const ALPACA_PAPER_BASE =
  "https://paper-api.alpaca.markets";

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

  // Only the instruments in instruments.ts, and only those listed in ALLOWED_SYMBOLS.
  const symbol =
    normalizeSymbol(
      rawSymbol
    );

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
    symbol === null ||
    !allowed.includes(
      symbol
    )
  ) {
    return {
      ok: false,
      code:
        "INVALID_SYMBOL",
      message:
        `${rawSymbol.trim().toUpperCase().slice(0, 32)} is not in the allowed instrument list (${allowed.join(", ")})`,
    };
  }

  const instrument =
    getInstrument(
      symbol
    ) as Instrument;

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

    const problem =
      qtyProblem(
        instrument,
        qty
      );

    if (problem) {
      return {
        ok: false,
        code:
          "INVALID_QUANTITY",
        message:
          problem,
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

  // Where referencePrice came from and when (set by runRiskEvaluation).
  priceSource?:
    | string
    | null;

  priceAt?:
    | string
    | null;
};

/**
 * The account facts the risk rules need, from one source:
 *   ALPACA_PAPER   the optional Alpaca PAPER account (risk-check and execution endpoints);
 *   ALPHA_PAPER_D1 the internal ALPHA PAPER ledger in D1 (the dry-run webhook): the strategy balance and
 *                  PAPER P&L recorded in D1. No broker is contacted.
 * null means unknown: the rule that needs it rejects instead of assuming a value.
 */
export interface RiskAccount {
  source: "ALPACA_PAPER" | "ALPHA_PAPER_D1";
  status: string;
  blocked: boolean;
  shortingEnabled: boolean;
  /** Cash available for an exposure-increasing order (no leverage for ALPHA PAPER). */
  buyingPower: number | null;
  buyingPowerLabel: string;
  insufficientCode: string;
  /** Today's PAPER P&L for the daily loss limit. */
  todaysPnl: number | null;
  todaysPnlLabel: string;
  /** Why a null value is unknown. */
  unavailableReason?: string;
}

const isRiskAccount = (a: unknown): a is RiskAccount =>
  typeof a === "object" && a !== null && "source" in a && "buyingPower" in a;

/** Maps an Alpaca PAPER /v2/account response (unchanged rules: crypto uses non-marginable buying power). */
export function alpacaRiskAccount(
  account: Record<string, unknown>,
  assetClass: string | undefined
): RiskAccount {
  return {
    source: "ALPACA_PAPER",
    status: String(account.status ?? "").toUpperCase(),
    blocked: Boolean(account.trading_blocked) || Boolean(account.account_blocked),
    shortingEnabled: Boolean(account.shorting_enabled),
    buyingPower:
      assetClass === "crypto"
        ? num(account.non_marginable_buying_power ?? account.buying_power)
        : num(account.buying_power),
    buyingPowerLabel: "PAPER buying power",
    insufficientCode: "INSUFFICIENT_BUYING_POWER",
    todaysPnl: num(account.equity) - num(account.last_equity),
    todaysPnlLabel: "Alpaca PAPER equity − last equity",
  };
}

export function evaluateRisk(
  intent:
    ValidIntent,

  env:
    TradeCoreEnv,

  // An Alpaca PAPER /v2/account object, or a RiskAccount (e.g. from the ALPHA PAPER ledger).
  rawAccount:
    | Record<
        string,
        unknown
      >
    | RiskAccount,

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
    number | null,

  // Why the price is missing, when the instrument has no truthful market-data source.
  priceUnavailableReason:
    string | null = null,

  // requireFillPrice: SELL and CLOSE also need a truthful price, because the ALPHA PAPER
  // ledger fills them at that price.
  options: {
    requireFillPrice?: boolean;
  } = {}
): RiskResult {
  const instrument =
    getInstrument(
      intent.symbol
    );

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

  const account: RiskAccount =
    isRiskAccount(rawAccount)
      ? rawAccount
      : alpacaRiskAccount(
          rawAccount,
          instrument?.assetClass
        );

  const accountStatus =
    account.status;

  if (
    !add(
      "account_active",
      accountStatus ===
        "ACTIVE",
      `${account.source} status ${
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
    account.blocked;

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
        options.requireFillPrice
          ? `no open ALPHA PAPER position in ${intent.symbol} to close`
          : instrument &&
          instrument.alpacaPaperSymbol ===
            null
          ? `no open PAPER position in ${intent.symbol} to close (no PAPER broker account can hold ${intent.symbol})`
          : `no open PAPER position in ${intent.symbol} to close`
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
        "All units are held by other open orders; nothing to close"
      );
    }

    if (
      options.requireFillPrice &&
      !add(
        "fill_price_available",
        price !== null &&
          price > 0,
        priceUnavailableReason ??
          "truthful price for the simulated fill"
      )
    ) {
      return reject(
        "MARKET_DATA_UNAVAILABLE",
        priceUnavailableReason ??
          "No truthful market price to simulate this fill; the position is unchanged"
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

  // MAX_ORDER_QTY counts futures contracts. Crypto and gold quantities are coin or ounce
  // amounts, so they are limited by the USD notional and exposure limits below instead.
  if (
    instrument?.qtyRule ===
      "contracts" &&
    !add(
      "max_order_qty",
      qty <=
        maxOrderQty,
      `${qty} contracts <= ${maxOrderQty}`
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
        `Only ${posAvailable} units are available (others held by orders)`
      );
    }

    if (
      options.requireFillPrice &&
      !add(
        "fill_price_available",
        price !== null &&
          price > 0,
        priceUnavailableReason ??
          "truthful price for the simulated fill"
      )
    ) {
      return reject(
        "MARKET_DATA_UNAVAILABLE",
        priceUnavailableReason ??
          "No truthful market price to simulate this fill; the position is unchanged"
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
        account.shortingEnabled,
        `${account.source} shorting`
      )
    ) {
      return reject(
        "SHORT_DISABLED",
        account.source ===
          "ALPHA_PAPER_D1"
          ? "The ALPHA PAPER ledger is long-only; it cannot hold a short"
          : "Alpaca PAPER account does not allow shorting"
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
      priceUnavailableReason ??
        "latest trade price for notional estimate"
    )
  ) {
    return reject(
      "MARKET_DATA_UNAVAILABLE",
      priceUnavailableReason ??
        "No market price available to verify order notional"
    );
  }

  const safePrice =
    price as number;

  // Futures notional = contracts x price x point value.
  const notional =
    Math.round(
      qty *
        safePrice *
        (instrument?.multiplier ?? 1) *
        100
    ) / 100;

  const isFutures =
    instrument?.assetClass ===
    "futures";

  if (isFutures) {
    // --------------------------------------------------------
    // FUTURES ORDER NOTIONAL (futures only)
    //
    // A futures contract is not a cash purchase, so the cash
    // notional, exposure and buying-power rules below do not
    // apply. Instead one order's contract notional must stay
    // within MAX_FUTURES_ORDER_NOTIONAL. Contract count is
    // already capped by MAX_ORDER_QTY. No broker margin is
    // modelled: no PAPER broker here can hold futures.
    // --------------------------------------------------------

    const maxFuturesNotional =
      Number(
        env.MAX_FUTURES_ORDER_NOTIONAL
      );

    if (
      !add(
        "max_futures_order_notional",
        maxFuturesNotional > 0 &&
          notional <=
            maxFuturesNotional,
        `${qty} x ${safePrice} x ${instrument?.multiplier} = ${notional} <= ${maxFuturesNotional}`
      )
    ) {
      return reject(
        "MAX_FUTURES_ORDER_NOTIONAL",
        maxFuturesNotional > 0
          ? `Futures contract notional $${notional} is above the limit $${maxFuturesNotional}`
          : "MAX_FUTURES_ORDER_NOTIONAL is not configured; futures orders are rejected"
      );
    }

    add(
      "cash_limits_not_applied",
      true,
      "futures: cash notional, exposure and buying-power limits do not apply; no futures margin is modelled"
    );
  } else {
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

  if (!isFutures) {
    // ----------------------------------------------------------
    // BUYING POWER
    // ----------------------------------------------------------

    // Alpaca: crypto is not marginable, so it uses non-marginable buying power (see alpacaRiskAccount).
    // ALPHA PAPER: the strategy balance's available funds; an unfunded balance is $0, never assumed.
    const buyingPower =
      account.buyingPower;

    if (
      !add(
        "buying_power",
        buyingPower !== null &&
          notional <=
            buyingPower,
        buyingPower === null
          ? `${account.buyingPowerLabel} unknown`
          : `${notional} <= ${buyingPower} (${account.buyingPowerLabel})`
      )
    ) {
      return buyingPower === null
        ? reject(
            "ACCOUNT_DATA_UNAVAILABLE",
            account.unavailableReason ??
              `${account.buyingPowerLabel} is unavailable; nothing is assumed`
          )
        : reject(
            account.insufficientCode,
            `Estimated $${notional} exceeds ${account.buyingPowerLabel} $${buyingPower}`
          );
    }
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
      account.todaysPnl;

    if (
      !add(
        "daily_loss_limit",
        todaysPnl !== null &&
          todaysPnl >
            -dailyLossLimit,
        todaysPnl === null
          ? `${account.todaysPnlLabel} unknown`
          : `today ${todaysPnl} > -${dailyLossLimit} (${account.todaysPnlLabel})`
      )
    ) {
      return todaysPnl === null
        ? reject(
            "ACCOUNT_DATA_UNAVAILABLE",
            account.unavailableReason ??
              "Today's PAPER P&L is unavailable; the daily loss limit cannot be checked"
          )
        : reject(
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
    ValidIntent,

  // "ledger": positions come from the ALPHA PAPER ledger (dry-run path), not Alpaca.
  opts: {
    positionSource?:
      | "alpaca"
      | "ledger";
  } = {}
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
  const instrument =
    getInstrument(
      intent.symbol
    );

  if (!instrument) {
    return {
      ok: false,
      status: 400,
      code:
        "INVALID_SYMBOL",
      message:
        `${intent.symbol} is not a supported instrument`,
    };
  }

  // The position is read from Alpaca PAPER only when Alpaca PAPER can hold the instrument.
  // (Alpaca's "GOLD" is a stock, so it is never queried for gold.)
  const paperSymbol =
    instrument.alpacaPaperSymbol;

  const useLedger =
    opts.positionSource ===
    "ledger";

  let account:
    | Record<
        string,
        unknown
      >
    | RiskAccount;

  let positions:
    Record<
      string,
      unknown
    >[];

  let position:
    | Record<
        string,
        unknown
      >
    | null;

  if (useLedger) {
    // ALPHA PAPER: account, positions, exposure and today's P&L all come from D1. No broker request,
    // so Alpaca keys are not needed. If D1 cannot be read, nothing is approved.
    try {
      const snapshot =
        await ledgerRiskSnapshot(
          env,
          intent.symbol
        );

      account =
        snapshot.account;

      position =
        snapshot.position;

      positions =
        snapshot.positions;
    } catch {
      return {
        ok: false,
        status: 503,
        code:
          "ACCOUNT_DATA_UNAVAILABLE",
        message:
          "The ALPHA PAPER ledger could not be read; nothing was approved",
      };
    }
  } else {
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

      paperSymbol === null
        ? Promise.resolve<AlpacaResult>({
            ok: true,
            status: 404,
            data: null,
          })
        : alpacaGet(
            env,
            `${ALPACA_PAPER_BASE}/v2/positions/${encodeURIComponent(
              paperSymbol
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

    account =
      asObject(
        accountResult.data
      );

    positions =
      asArray(
        positionsResult.data
      );

    position =
      positionResult.data ===
        null
        ? null
        : asObject(
            positionResult.data
          );
  }

  let price:
    number | null =
    null;

  let priceUnavailableReason:
    string | null =
    null;

  let priceSource:
    string | null =
    null;

  let priceAt:
    string | null =
    null;

  // The ledger fills every action at a truthful price, so it always needs one.
  const needsPrice =
    useLedger ||
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
      await referencePrice(
        instrument,
        env
      );

    if (
      !priceResult.ok
    ) {
      return priceResult;
    }

    if (
      priceResult.price ===
      null
    ) {
      priceUnavailableReason =
        priceResult.reason;
    } else {
      price =
        priceResult.price;

      priceSource =
        priceResult.source;

      priceAt =
        priceResult.at;
    }
  }

  const risk =
    evaluateRisk(
      intent,
      env,
      account,
      position,
      positions,
      price,
      priceUnavailableReason,
      {
        requireFillPrice:
          useLedger,
      }
    );

  return {
    ok: true,

    risk: {
      ...risk,

      priceSource:
        risk.referencePrice ===
        null
          ? null
          : priceSource,

      priceAt:
        risk.referencePrice ===
        null
          ? null
          : priceAt,
    },
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
): Promise<number | null> {
  const now =
    new Date()
      .toISOString();

  const result = await env.DB.prepare(
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

  return typeof result.meta?.last_row_id === "number"
    ? result.meta.last_row_id
    : null;
}

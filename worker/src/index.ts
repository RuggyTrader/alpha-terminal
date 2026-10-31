import {
  createDryRunOrder,
  simulateUnknownState,
  simulateReconcile,
} from "./dry_run_orders";

import {
  handleDryRunWebhook,
} from "./webhook_dry_run";

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

// ============================================================
// HELPERS
// ============================================================

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function num(value: unknown): number {
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

  return value.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item)
  ) as Record<string, unknown>[];
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

// ============================================================
// ADMIN AUTH
// ============================================================

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

// ============================================================
// ENGINE
// ============================================================

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

async function handleEngineControl(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  const authError =
    await requireAdmin(request, env);

  if (authError) {
    return authError;
  }

  const now = new Date().toISOString();
  const current = await getEngine(env);

  if (!current) {
    return json(
      {
        ok: false,
        code: "ENGINE_STATE_MISSING",
      },
      500
    );
  }

  if (pathname === "/kill") {
    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state='STOPPED',
         kill_switch=1,
         killed_at=?,
         updated_at=?,
         updated_by='admin',
         reason='Emergency kill switch: new PAPER orders blocked'
       WHERE id=1`
    )
      .bind(now, now)
      .run();

    return json({
      ok: true,
      status: "ok",
      code: "KILL_SWITCH_ACTIVE",
      data: await getEngine(env),
    });
  }

  if (pathname === "/kill/reset") {
    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state='STOPPED',
         kill_switch=0,
         killed_at=NULL,
         updated_at=?,
         updated_by='admin',
         reason='Kill switch reset; engine remains STOPPED until started'
       WHERE id=1`
    )
      .bind(now)
      .run();

    return json({
      ok: true,
      status: "ok",
      code: "KILL_SWITCH_RESET",
      data: await getEngine(env),
    });
  }

  if (pathname === "/engine/start") {
    if (current.kill_switch === 1) {
      return json(
        {
          ok: false,
          code: "KILL_SWITCH_ACTIVE",
        },
        409
      );
    }

    if (env.ENABLE_TRADING !== "true") {
      return json(
        {
          ok: false,
          code: "EXECUTION_DISABLED",
          message:
            "ENABLE_TRADING is false. PAPER execution cannot start.",
        },
        409
      );
    }

    if (current.state !== "STOPPED") {
      return json(
        {
          ok: false,
          code: "INVALID_TRANSITION",
        },
        409
      );
    }

    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state='RUNNING',
         updated_at=?,
         updated_by='admin',
         reason='start by admin'
       WHERE id=1`
    )
      .bind(now)
      .run();
  }

  if (pathname === "/engine/pause") {
    if (current.state !== "RUNNING") {
      return json(
        {
          ok: false,
          code: "INVALID_TRANSITION",
        },
        409
      );
    }

    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state='PAUSED',
         updated_at=?,
         updated_by='admin',
         reason='pause by admin'
       WHERE id=1`
    )
      .bind(now)
      .run();
  }

  if (pathname === "/engine/resume") {
    if (current.kill_switch === 1) {
      return json(
        {
          ok: false,
          code: "KILL_SWITCH_ACTIVE",
        },
        409
      );
    }

    if (current.state !== "PAUSED") {
      return json(
        {
          ok: false,
          code: "INVALID_TRANSITION",
        },
        409
      );
    }

    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state='RUNNING',
         updated_at=?,
         updated_by='admin',
         reason='resume by admin'
       WHERE id=1`
    )
      .bind(now)
      .run();
  }

  if (pathname === "/engine/stop") {
    await env.DB.prepare(
      `UPDATE engine_state
       SET
         state='STOPPED',
         updated_at=?,
         updated_by='admin',
         reason='stop by admin'
       WHERE id=1`
    )
      .bind(now)
      .run();
  }

  return json({
    ok: true,
    status: "ok",
    data: await getEngine(env),
  });
}

// ============================================================
// ALPACA PAPER — READ ONLY
// ============================================================

function alpacaHeaders(env: Env): HeadersInit {
  return {
    "APCA-API-KEY-ID": env.ALPACA_KEY,
    "APCA-API-SECRET-KEY": env.ALPACA_SECRET,
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
  if (!env.ALPACA_KEY || !env.ALPACA_SECRET) {
    return {
      ok: false,
      status: 503,
      code: "BROKER_NOT_CONFIGURED",
      message:
        "Alpaca PAPER keys are not configured",
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
      message: "Could not reach Alpaca PAPER",
    };
  }

  if (allow404 && response.status === 404) {
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
      message: "Alpaca rate limit reached",
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
    return {
      ok: false,
      status: 422,
      code: "BROKER_REJECTED",
      message:
        "Alpaca PAPER rejected the request",
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

// ============================================================
// VALIDATION
// ============================================================

type ValidIntent = {
  ok: true;
  symbol: string;
  action: "buy" | "sell" | "close";
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
  if (typeof body.symbol !== "string") {
    return {
      ok: false,
      code: "MISSING_FIELD",
      message: "symbol is required",
    };
  }

  let symbol =
    body.symbol.trim().toUpperCase();

  if (symbol.includes(":")) {
    symbol = symbol.split(":", 2)[1];
  }

  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return {
      ok: false,
      code: "INVALID_SYMBOL",
      message: "invalid stock ticker",
    };
  }

  const allowed =
    env.ALLOWED_SYMBOLS
      .split(",")
      .map((x) => x.trim().toUpperCase());

  if (!allowed.includes(symbol)) {
    return {
      ok: false,
      code: "INVALID_SYMBOL",
      message:
        `${symbol} is not in the allowed symbol list`,
    };
  }

  if (typeof body.action !== "string") {
    return {
      ok: false,
      code: "MISSING_FIELD",
      message: "action is required",
    };
  }

  const action =
    body.action.trim().toLowerCase();

  if (
    action !== "buy" &&
    action !== "sell" &&
    action !== "close"
  ) {
    return {
      ok: false,
      code: "INVALID_ACTION",
      message:
        "action must be buy, sell or close",
    };
  }

  const rawOrderType =
    body.order_type ??
    body.type ??
    "market";

  if (
    String(rawOrderType).toLowerCase() !==
    "market"
  ) {
    return {
      ok: false,
      code: "UNSUPPORTED_ORDER_TYPE",
      message:
        "only market orders are supported",
    };
  }

  const tif =
    String(
      body.time_in_force ?? "day"
    ).toLowerCase();

  if (tif !== "day") {
    return {
      ok: false,
      code: "UNSUPPORTED_TIME_IN_FORCE",
      message:
        "only time_in_force=day is supported",
    };
  }

  let qty: number | null = null;

  if (action !== "close") {
    qty = Number(body.qty);

    if (!Number.isFinite(qty) || qty <= 0) {
      return {
        ok: false,
        code: "INVALID_QUANTITY",
        message:
          "qty must be greater than zero",
      };
    }

    if (
      !boolEnv(env.ALLOW_FRACTIONAL_QTY) &&
      !Number.isInteger(qty)
    ) {
      return {
        ok: false,
        code: "INVALID_QUANTITY",
        message:
          "fractional quantities are disabled",
      };
    }
  }

  const strategy =
    body.strategy
      ? String(body.strategy).slice(0, 64)
      : "UNSPECIFIED";

  return {
    ok: true,
    symbol,
    action,
    qty,
    strategy,
    orderType: "market",
    timeInForce: "day",
  };
}

// ============================================================
// RISK ENGINE
// ============================================================

type RiskCheck = {
  check: string;
  passed: boolean;
  detail: string;
};

type RiskResult = {
  approved: boolean;
  code: string;
  reason: string;
  side: "buy" | "sell" | null;
  finalQty: number | null;
  referencePrice: number | null;
  estimatedNotional: number | null;
  checks: RiskCheck[];
};

function evaluateRisk(
  intent: ValidIntent,
  env: Env,
  account: Record<string, unknown>,
  position: Record<string, unknown> | null,
  positions: Record<string, unknown>[],
  price: number | null
): RiskResult {
  const checks: RiskCheck[] = [];

  const add = (
    check: string,
    passed: boolean,
    detail: string
  ) => {
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

  const status =
    String(account.status ?? "").toUpperCase();

  if (
    !add(
      "account_active",
      status === "ACTIVE",
      `account status ${status}`
    )
  ) {
    return reject(
      "ACCOUNT_RESTRICTED",
      `PAPER account status is ${status}`
    );
  }

  const blocked =
    Boolean(account.trading_blocked) ||
    Boolean(account.account_blocked);

  if (
    !add(
      "account_not_blocked",
      !blocked,
      "account block flags"
    )
  ) {
    return reject(
      "ACCOUNT_RESTRICTED",
      "PAPER account is blocked"
    );
  }

  const posQty =
    position ? num(position.qty) : 0;

  const available =
    position
      ? Math.abs(
          num(
            position.qty_available ??
              position.qty
          )
        )
      : 0;

  if (intent.action === "close") {
    if (
      !add(
        "position_exists",
        posQty !== 0,
        `position ${posQty}`
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
        available > 0,
        `available ${available}`
      )
    ) {
      return reject(
        "POSITION_LOCKED",
        "No shares available to close"
      );
    }

    return {
      approved: true,
      code: "APPROVED",
      reason: "CLOSE approved",
      side:
        posQty > 0 ? "sell" : "buy",
      finalQty: available,
      referencePrice: price,
      estimatedNotional: null,
      checks,
    };
  }

  const qty = intent.qty ?? 0;

  const maxQty =
    Number(env.MAX_ORDER_QTY);

  if (
    !add(
      "max_order_qty",
      qty <= maxQty,
      `${qty} <= ${maxQty}`
    )
  ) {
    return reject(
      "MAX_ORDER_QTY",
      `qty ${qty} is above the maximum order quantity ${maxQty}`
    );
  }

  if (
    intent.action === "sell" &&
    posQty > 0
  ) {
    if (qty > posQty) {
      return reject(
        "SELL_EXCEEDS_POSITION",
        "SELL would create a short position"
      );
    }

    if (qty > available) {
      return reject(
        "SELL_EXCEEDS_AVAILABLE",
        "Not enough available shares"
      );
    }

    return {
      approved: true,
      code: "APPROVED",
      reason: "SELL approved",
      side: "sell",
      finalQty: qty,
      referencePrice: price,
      estimatedNotional: null,
      checks,
    };
  }

  let side: "buy" | "sell";

  if (intent.action === "sell") {
    if (!boolEnv(env.SHORT_SELLING_ENABLED)) {
      if (posQty === 0) {
        return reject(
          "NO_POSITION",
          `no open long position in ${intent.symbol}`
        );
      }

      return reject(
        "SHORT_DISABLED",
        "short selling is disabled"
      );
    }

    if (!Boolean(account.shorting_enabled)) {
      return reject(
        "SHORT_DISABLED",
        "Alpaca PAPER account does not allow shorting"
      );
    }

    side = "sell";
  } else {
    if (posQty < 0) {
      return reject(
        "SHORT_POSITION_PRESENT",
        "BUY would cover an existing short"
      );
    }

    side = "buy";
  }

  if (!price || price <= 0) {
    return reject(
      "MARKET_DATA_UNAVAILABLE",
      "No market price available"
    );
  }

  const notional =
    Math.round(qty * price * 100) / 100;

  const maxNotional =
    Number(env.MAX_ORDER_NOTIONAL);

  if (notional > maxNotional) {
    return reject(
      "MAX_ORDER_NOTIONAL",
      `Estimated notional $${notional} exceeds $${maxNotional}`
    );
  }

  const currentPositionValue =
    position
      ? Math.abs(
          num(position.market_value)
        )
      : 0;

  const positionExposure =
    currentPositionValue + notional;

  const maxPosition =
    Number(env.MAX_POSITION_EXPOSURE);

  if (positionExposure > maxPosition) {
    return reject(
      "MAX_POSITION_EXPOSURE",
      `Position exposure would be $${positionExposure}`
    );
  }

  const totalExisting =
    positions.reduce(
      (sum, p) =>
        sum +
        Math.abs(
          num(p.market_value)
        ),
      0
    );

  const totalExposure =
    totalExisting + notional;

  const maxTotal =
    Number(env.MAX_TOTAL_EXPOSURE);

  if (totalExposure > maxTotal) {
    return reject(
      "MAX_TOTAL_EXPOSURE",
      `Total PAPER exposure would be $${totalExposure}`
    );
  }

  const openCount =
    positions.filter(
      (p) => num(p.qty) !== 0
    ).length;

  if (!position || posQty === 0) {
    if (
      openCount >=
      Number(env.MAX_OPEN_POSITIONS)
    ) {
      return reject(
        "MAX_OPEN_POSITIONS",
        "Maximum open positions reached"
      );
    }
  }

  const buyingPower =
    num(account.buying_power);

  if (notional > buyingPower) {
    return reject(
      "INSUFFICIENT_BUYING_POWER",
      `Estimated $${notional} exceeds PAPER buying power $${buyingPower}`
    );
  }

  const dailyLimit =
    Number(env.DAILY_LOSS_LIMIT);

  if (dailyLimit > 0) {
    const today =
      num(account.equity) -
      num(account.last_equity);

    if (today <= -dailyLimit) {
      return reject(
        "DAILY_LOSS_LIMIT",
        `Today's PAPER P&L ${today} hit the daily loss limit`
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
    referencePrice: price,
    estimatedNotional: notional,
    checks,
  };
}

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
    asObject(accountResult.data);

  const positions =
    asArray(positionsResult.data);

  const position =
    positionResult.data === null
      ? null
      : asObject(positionResult.data);

  let price: number | null = null;

  const needsPrice =
    intent.action === "buy" ||
    (
      intent.action === "sell" &&
      (!position || num(position.qty) <= 0)
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
      const body =
        asObject(priceResult.data);

      const trade =
        asObject(body.trade);

      const p = num(trade.p);

      price = p > 0 ? p : null;
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

async function saveRiskDecision(
  env: Env,
  alertFk: number | null,
  risk: RiskResult
) {
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
        : String(risk.finalQty),
      risk.referencePrice === null
        ? null
        : String(risk.referencePrice),
      risk.referencePrice === null
        ? null
        : new Date().toISOString(),
      risk.estimatedNotional === null
        ? null
        : String(risk.estimatedNotional),
      JSON.stringify(risk.checks)
    )
    .run();
}

// ============================================================
// MAIN
// ============================================================

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const url = new URL(request.url);

    // --------------------------------------------------------
    // HEALTH
    // --------------------------------------------------------

    if (
      url.pathname === "/health" &&
      request.method === "GET"
    ) {
      const db =
        await env.DB.prepare(
          "SELECT 1 AS ok"
        ).first<{ ok: number }>();

      return json({
        ok: db?.ok === 1,
        service: "alpha-terminal-api",
        mode: "PAPER",
        database: "connected",
        enable_trading:
          env.ENABLE_TRADING === "true",
        alpaca_configured: Boolean(
          env.ALPACA_KEY &&
            env.ALPACA_SECRET
        ),
        engine:
          await getEngine(env),
      });
    }

    // --------------------------------------------------------
    // READ-ONLY BROKER
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
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
          result,
          result.status
        );
      }

      return json({
        ok: true,
        mode: "PAPER",
        data: result.data,
      });
    }

    if (
      request.method === "GET" &&
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
            "/api/broker/price/".length
          )
        )
          .trim()
          .toUpperCase();

      const result =
        await alpacaGet(
          env,
          `${ALPACA_DATA_BASE}/v2/stocks/${encodeURIComponent(
            symbol
          )}/trades/latest?feed=iex`
        );

      if (!result.ok) {
        return json(
          result,
          result.status
        );
      }

      return json({
        ok: true,
        mode: "PAPER",
        symbol,
        data: result.data,
      });
    }

    // --------------------------------------------------------
    // RISK PREVIEW
    // --------------------------------------------------------

    if (
      url.pathname ===
        "/api/risk/preview" &&
      request.method === "POST"
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      const body =
        await request.json<
          Record<string, unknown>
        >();

      const validation =
        validateIntent(
          body,
          env
        );

      if (!validation.ok) {
        return json(
          validation,
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
          result,
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
        mode: "PAPER",
        execution:
          "NOT_ATTEMPTED",
        intent: validation,
        risk: result.risk,
      });
    }

    // --------------------------------------------------------
    // DRY-RUN ORDER CREATE
    // --------------------------------------------------------

    if (
      url.pathname ===
        "/api/dry-run/order" &&
      request.method === "POST"
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      const body =
        await request.json<
          Record<string, unknown>
        >();

      const alertId =
        String(
          body.alert_id ?? ""
        ).trim();

      const symbol =
        String(
          body.symbol ?? ""
        )
          .trim()
          .toUpperCase();

      const side =
        String(
          body.side ?? ""
        )
          .trim()
          .toLowerCase();

      const qty =
        Number(body.qty);

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
        !Number.isFinite(qty) ||
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
            alertFk: null,
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
        mode: "PAPER",
        execution:
          "DRY_RUN_ONLY",
        broker_request_sent:
          false,
        ...result,
      });
    }

    // --------------------------------------------------------
    // DRY-RUN UNKNOWN
    // --------------------------------------------------------

    if (
      url.pathname ===
        "/api/dry-run/unknown" &&
      request.method === "POST"
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      const body =
        await request.json<
          Record<string, unknown>
        >();

      const clientOrderId =
        String(
          body.client_order_id ??
            ""
        ).trim();

      if (!clientOrderId) {
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
        mode: "PAPER",
        execution:
          "DRY_RUN_ONLY",
        broker_request_sent:
          false,
        order,
      });
    }

    // --------------------------------------------------------
    // DRY-RUN RECONCILE
    // --------------------------------------------------------

    if (
      url.pathname ===
        "/api/dry-run/reconcile" &&
      request.method === "POST"
    ) {
      const authError =
        await requireAdmin(
          request,
          env
        );

      if (authError) {
        return authError;
      }

      const body =
        await request.json<
          Record<string, unknown>
        >();

      const clientOrderId =
        String(
          body.client_order_id ??
            ""
        ).trim();

      const found =
        body.found === true;

      if (!clientOrderId) {
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
        mode: "PAPER",
        execution:
          "DRY_RUN_ONLY",
        broker_request_sent:
          false,
        reconciled_found:
          found,
        order,
      });
    }

    // --------------------------------------------------------
    // ENGINE CONTROLS
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // TRADINGVIEW FULL DRY-RUN WEBHOOK
    // Runs validation + PAPER data/risk + D1 order intent.
    // Never submits an Alpaca order.
    // --------------------------------------------------------

    if (
      url.pathname === "/webhook/dry-run" &&
      request.method === "POST"
    ) {
      return handleDryRunWebhook(
        request,
        env
      );
    }

    // --------------------------------------------------------
    // TRADINGVIEW WEBHOOK
    // Still cannot submit any Alpaca order.
    // --------------------------------------------------------

    if (
      url.pathname === "/webhook" &&
      request.method === "POST"
    ) {
      const now =
        new Date().toISOString();

      const body =
        await request.json<
          Record<string, unknown>
        >();

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
            code: "UNAUTHORIZED",
          },
          401
        );
      }

      const alertId =
        String(body.id ?? "").trim();

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
          VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`
        )
          .bind(
            alertId,
            now,
            request.headers.get(
              "cf-connecting-ip"
            ),
            body.symbol ?? null,
            body.action ?? null,
            body.strategy ?? null,
            JSON.stringify(
              sanitized
            ).slice(0, 4000)
          )
          .run();
      } catch {
        const existing =
          await env.DB.prepare(
            `SELECT
              status,
              response_code
             FROM alerts
             WHERE alert_id=?`
          )
            .bind(alertId)
            .first();

        if (existing) {
          await env.DB.prepare(
            `UPDATE alerts
             SET
               duplicate_count =
                 duplicate_count + 1,
               last_duplicate_at=?
             WHERE alert_id=?`
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
            alert_id:
              alertId,
          });
        }

        return json(
          {
            ok: false,
            code:
              "DATABASE_ERROR",
          },
          500
        );
      }

      const validation =
        validateIntent(
          body,
          env
        );

      if (!validation.ok) {
        await env.DB.prepare(
          `UPDATE alerts
           SET
             status='rejected',
             processed_at=?,
             validation_result='failed',
             response_code=?,
             http_status=400,
             rejection_reason=?
           WHERE alert_id=?`
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
           symbol=?,
           action=?,
           strategy=?,
           order_type=?,
           requested_qty=?,
           validation_result='passed'
         WHERE alert_id=?`
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
        await getEngine(env);

      if (
        engine?.kill_switch ===
        1
      ) {
        return json(
          {
            ok: false,
            code:
              "KILL_SWITCH_ACTIVE",
          },
          403
        );
      }

      if (
        !engine ||
        engine.state ===
          "STOPPED"
      ) {
        return json(
          {
            ok: false,
            code:
              "ENGINE_STOPPED",
          },
          403
        );
      }

      if (
        engine.state ===
        "PAUSED"
      ) {
        return json(
          {
            ok: false,
            code:
              "ENGINE_PAUSED",
          },
          403
        );
      }

      if (
        env.ENABLE_TRADING !==
        "true"
      ) {
        return json(
          {
            ok: false,
            code:
              "EXECUTION_DISABLED",
          },
          403
        );
      }

      const risk =
        await runRiskEvaluation(
          env,
          validation
        );

      if (!risk.ok) {
        return json(
          risk,
          risk.status
        );
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

      await saveRiskDecision(
        env,
        alertRow?.id ?? null,
        risk.risk
      );

      if (!risk.risk.approved) {
        return json(
          {
            ok: false,
            code:
              risk.risk.code,
            message:
              risk.risk.reason,
          },
          422
        );
      }

      // IMPORTANT:
      // No broker POST exists here.
      // This Worker remains PAPER-only and execution-disabled.

      return json(
        {
          ok: false,
          code:
            "BROKER_EXECUTION_NOT_IMPLEMENTED",
          message:
            "Risk approved, but broker submission is intentionally not implemented.",
        },
        503
      );
    }

    return json(
      {
        ok: false,
        code: "NOT_FOUND",
      },
      404
    );
  },
};
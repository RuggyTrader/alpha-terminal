"""Webhook payload validation and the shared API response shape."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from .config import Settings

ALERT_ID_RE = re.compile(r"^[\x21-\x7E]{1,128}$")  # printable ASCII, no spaces
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
SUPPORTED_ACTIONS = ("buy", "sell", "close")
SUPPORTED_ORDER_TYPES = ("market",)
SUPPORTED_TIME_IN_FORCE = ("day",)
MAX_BODY_BYTES = 16 * 1024


def api_response(
    *, ok: bool, status: str, code: str, message: str, alert_id: str | None = None, data: Any = None
) -> dict[str, Any]:
    """Every webhook / control endpoint answers with this shape."""
    return {"ok": ok, "status": status, "code": code, "message": message, "alert_id": alert_id, "data": data}


@dataclass(frozen=True)
class OrderIntent:
    alert_id: str
    symbol: str
    action: str  # buy | sell | close
    qty: Decimal | None  # None for close
    strategy: str
    order_type: str
    time_in_force: str


@dataclass(frozen=True)
class ValidationFailure:
    code: str
    message: str
    http_status: int = 400


def validate_alert_id(value: Any) -> str | None:
    if isinstance(value, (int,)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if ALERT_ID_RE.match(value) else None


def parse_qty(value: Any, *, allow_fractional: bool) -> Decimal | ValidationFailure:
    if value is None or value == "":
        return ValidationFailure("MISSING_FIELD", "qty is required for buy and sell")
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return ValidationFailure("INVALID_QUANTITY", "qty must be a number")
    try:
        qty = Decimal(str(value).strip())
    except InvalidOperation:
        return ValidationFailure("INVALID_QUANTITY", "qty must be a number")
    if not qty.is_finite():
        return ValidationFailure("INVALID_QUANTITY", "qty must be a finite number")
    if qty <= 0:
        return ValidationFailure("INVALID_QUANTITY", "qty must be greater than zero")
    if not allow_fractional and qty != qty.to_integral_value():
        return ValidationFailure("INVALID_QUANTITY", "fractional quantities are disabled (ALLOW_FRACTIONAL_QTY=false)")
    if qty.as_tuple().exponent < -6:  # type: ignore[operator]
        return ValidationFailure("INVALID_QUANTITY", "qty has too many decimal places")
    return qty.normalize() if qty == qty.to_integral_value() else qty


def parse_intent(alert_id: str, data: dict[str, Any], settings: Settings) -> OrderIntent | ValidationFailure:
    symbol_raw = data.get("symbol")
    if symbol_raw is None or (isinstance(symbol_raw, str) and not symbol_raw.strip()):
        return ValidationFailure("MISSING_FIELD", "symbol is required")
    if not isinstance(symbol_raw, str):
        return ValidationFailure("INVALID_SYMBOL", "symbol must be a string")
    symbol = symbol_raw.strip().upper()
    if ":" in symbol:  # e.g. "NASDAQ:AAPL" from {{exchange}}:{{ticker}}
        symbol = symbol.split(":", 1)[1]
    if not SYMBOL_RE.match(symbol):
        return ValidationFailure("INVALID_SYMBOL", "symbol format is not a supported stock ticker")
    if symbol not in settings.allowed_symbols:
        return ValidationFailure("INVALID_SYMBOL", f"{symbol} is not in the allowed symbol list")

    action_raw = data.get("action")
    if action_raw is None or (isinstance(action_raw, str) and not action_raw.strip()):
        return ValidationFailure("MISSING_FIELD", "action is required")
    if not isinstance(action_raw, str) or action_raw.strip().lower() not in SUPPORTED_ACTIONS:
        return ValidationFailure("INVALID_ACTION", "action must be buy, sell or close")
    action = action_raw.strip().lower()

    order_type_raw = data.get("order_type", data.get("type", "market"))
    if not isinstance(order_type_raw, str) or order_type_raw.strip().lower() not in SUPPORTED_ORDER_TYPES:
        return ValidationFailure(
            "UNSUPPORTED_ORDER_TYPE", "only market orders are supported; the alert was not converted"
        )
    order_type = order_type_raw.strip().lower()

    tif_raw = data.get("time_in_force", "day")
    if not isinstance(tif_raw, str) or tif_raw.strip().lower() not in SUPPORTED_TIME_IN_FORCE:
        return ValidationFailure("UNSUPPORTED_TIME_IN_FORCE", "only time_in_force=day is supported")

    qty: Decimal | None = None
    if action in ("buy", "sell"):
        parsed = parse_qty(data.get("qty"), allow_fractional=settings.allow_fractional_qty)
        if isinstance(parsed, ValidationFailure):
            return parsed
        qty = parsed

    strategy_raw = data.get("strategy", "")
    strategy = str(strategy_raw).strip()[:64] if strategy_raw is not None else ""
    return OrderIntent(
        alert_id=alert_id,
        symbol=symbol,
        action=action,
        qty=qty,
        strategy=strategy or "UNSPECIFIED",
        order_type=order_type,
        time_in_force="day",
    )

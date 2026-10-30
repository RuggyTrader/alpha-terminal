"""Server-side risk checks. Pure functions over a broker snapshot.

Nothing here loosens a rule to make an order go through. Every check that is
evaluated is recorded with its result so the dashboard can show why.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from .broker import PriceInfo
from .config import Settings
from .schemas import OrderIntent


@dataclass
class RiskResult:
    approved: bool
    code: str
    reason: str
    side: str | None = None
    final_qty: Decimal | None = None
    reference_price: PriceInfo | None = None
    estimated_notional: Decimal | None = None
    checks: list[dict[str, Any]] = field(default_factory=list)


def _d(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal("0")


class _Checks:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    def add(self, name: str, passed: bool, detail: str) -> bool:
        self.items.append({"check": name, "passed": passed, "detail": detail})
        return passed


def evaluate(
    intent: OrderIntent,
    settings: Settings,
    *,
    account: dict[str, Any],
    position: dict[str, Any] | None,
    positions: list[dict[str, Any]],
    price: PriceInfo | None,
) -> RiskResult:
    c = _Checks()

    def reject(code: str, reason: str) -> RiskResult:
        return RiskResult(False, code, reason, checks=c.items, reference_price=price)

    # Account restrictions
    status = str(account.get("status", "")).upper()
    if not c.add("account_active", status == "ACTIVE", f"account status {status or 'UNKNOWN'}"):
        return reject("ACCOUNT_RESTRICTED", f"PAPER account status is {status or 'UNKNOWN'}")
    blocked = bool(account.get("trading_blocked")) or bool(account.get("account_blocked"))
    if not c.add("account_not_blocked", not blocked, "trading_blocked/account_blocked flags"):
        return reject("ACCOUNT_RESTRICTED", "PAPER account is blocked from trading")

    pos_qty = _d(position.get("qty")) if position else Decimal("0")  # negative when short
    pos_available = abs(_d(position.get("qty_available", position.get("qty")))) if position else Decimal("0")

    if intent.action == "close":
        if not c.add("position_exists", pos_qty != 0, f"current position {pos_qty}"):
            return reject("NO_POSITION", f"no open PAPER position in {intent.symbol} to close")
        if not c.add("qty_available", pos_available > 0, f"available {pos_available}"):
            return reject("POSITION_LOCKED", "All shares are held by other open orders; nothing to close")
        side = "sell" if pos_qty > 0 else "buy"
        detail = f"closes {pos_available} of {abs(pos_qty)} (risk-reducing; exposure limits not applied)"
        c.add("close_only_existing", True, detail)
        return RiskResult(True, "APPROVED", "CLOSE approved", side=side, final_qty=pos_available, checks=c.items)

    qty = intent.qty or Decimal("0")
    if not c.add("max_order_qty", qty <= settings.max_order_qty, f"{qty} <= {settings.max_order_qty}"):
        return reject("MAX_ORDER_QTY", f"qty {qty} is above the maximum order quantity {settings.max_order_qty}")

    if intent.action == "sell" and pos_qty > 0:
        # Reducing an existing long. Never allow the sell to pass through zero.
        if not c.add("sell_within_position", qty <= pos_qty, f"sell {qty} <= position {pos_qty}"):
            return reject(
                "SELL_EXCEEDS_POSITION",
                f"SELL {qty} is greater than the open long position {pos_qty}; it would create a short",
            )
        if not c.add("sell_within_available", qty <= pos_available, f"sell {qty} <= available {pos_available}"):
            return reject("SELL_EXCEEDS_AVAILABLE", f"Only {pos_available} shares are available (others held by orders)")
        c.add("risk_reducing", True, "sell reduces an existing long; exposure limits not applied")
        return RiskResult(True, "APPROVED", "SELL approved", side="sell", final_qty=qty, checks=c.items)

    if intent.action == "sell":
        # Flat or already short: this SELL would open/increase a short.
        if not c.add("short_selling_enabled", settings.short_selling_enabled, "SHORT_SELLING_ENABLED"):
            if pos_qty == 0:
                return reject("NO_POSITION", f"no open long position in {intent.symbol}")
            return reject("SHORT_DISABLED", "SELL would increase a short position; short selling is disabled")
        if not c.add("account_shorting_enabled", bool(account.get("shorting_enabled")), "Alpaca shorting_enabled"):
            return reject("SHORT_DISABLED", "Alpaca PAPER account does not allow shorting")
        side = "sell"
    else:  # buy
        if not c.add("no_short_present", pos_qty >= 0, f"current position {pos_qty}"):
            return reject(
                "SHORT_POSITION_PRESENT",
                "BUY would cover a short position; ALPHA TERMINAL does not reverse positions automatically",
            )
        side = "buy"

    # Exposure-increasing order (BUY, or SELL-short when explicitly enabled)
    if not c.add("market_data_available", price is not None, "latest trade price for notional estimate"):
        return reject("MARKET_DATA_UNAVAILABLE", "No market price available to verify order notional")
    assert price is not None
    notional = (qty * price.price).quantize(Decimal("0.01"))
    if not c.add("max_order_notional", notional <= settings.max_order_notional, f"{notional} <= {settings.max_order_notional}"):
        return reject("MAX_ORDER_NOTIONAL", f"Estimated notional ${notional} is above the limit ${settings.max_order_notional}")

    pos_mv = abs(_d(position.get("market_value"))) if position else Decimal("0")
    new_pos = pos_mv + notional
    if not c.add("max_position_exposure", new_pos <= settings.max_position_exposure, f"{new_pos} <= {settings.max_position_exposure}"):
        return reject("MAX_POSITION_EXPOSURE", f"Position exposure would be ${new_pos}, above ${settings.max_position_exposure}")

    total = sum((abs(_d(p.get("market_value"))) for p in positions), Decimal("0")) + notional
    if not c.add("max_total_exposure", total <= settings.max_total_exposure, f"{total} <= {settings.max_total_exposure}"):
        return reject("MAX_TOTAL_EXPOSURE", f"Total PAPER exposure would be ${total}, above ${settings.max_total_exposure}")

    open_count = len([p for p in positions if _d(p.get("qty")) != 0])
    if position is None or pos_qty == 0:
        ok = open_count < settings.max_open_positions
        if not c.add("max_open_positions", ok, f"{open_count} open < {settings.max_open_positions}"):
            return reject("MAX_OPEN_POSITIONS", f"Already at the maximum of {settings.max_open_positions} open positions")

    buying_power = _d(account.get("buying_power"))
    if not c.add("buying_power", notional <= buying_power, f"{notional} <= {buying_power}"):
        return reject("INSUFFICIENT_BUYING_POWER", f"Estimated ${notional} exceeds PAPER buying power ${buying_power}")

    if settings.daily_loss_limit > 0:
        today = _d(account.get("equity")) - _d(account.get("last_equity"))
        ok = today > -settings.daily_loss_limit
        if not c.add("daily_loss_limit", ok, f"today {today} > -{settings.daily_loss_limit}"):
            return reject("DAILY_LOSS_LIMIT", f"Today's PAPER P&L {today} hit the daily loss limit")

    return RiskResult(
        True,
        "APPROVED",
        f"{intent.action.upper()} approved",
        side=side,
        final_qty=qty,
        reference_price=price,
        estimated_notional=notional,
        checks=c.items,
    )

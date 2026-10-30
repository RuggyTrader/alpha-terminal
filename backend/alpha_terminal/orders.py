"""PAPER order submission, reconciliation and status sync."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .broker import BrokerError, BrokerRejected, parse_ts
from .context import AppContext
from .models import Alert, Order

# Alpaca statuses after which an order will not change any more.
TERMINAL_STATUSES = {"filled", "canceled", "expired", "rejected", "replaced", "failed", "broker_rejected"}
# Local states that need reconciliation with Alpaca by client_order_id.
RECONCILE_STATUSES = {"submitting", "unknown"}
QUEUED_STATUSES = {"new", "accepted", "pending_new", "accepted_for_bidding"}


def client_order_id_for_alert(alert_id: str) -> str:
    """Deterministic: the same TradingView alert always maps to the same Alpaca
    client_order_id, so Alpaca itself also refuses a second submission."""
    return "at-" + hashlib.sha256(alert_id.encode("utf-8")).hexdigest()[:40]


def _dec(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    return Decimal(str(value))


def apply_alpaca_order(order: Order, data: dict[str, Any]) -> bool:
    """Copy Alpaca's view of the order onto our row. Returns True if fills changed."""
    before = (order.status, order.filled_qty, order.filled_avg_price)
    order.alpaca_order_id = str(data.get("id") or order.alpaca_order_id or "") or None
    order.status = str(data.get("status") or order.status)
    order.alpaca_created_at = parse_ts(data.get("created_at")) or order.alpaca_created_at
    order.filled_qty = _dec(data.get("filled_qty")) or Decimal("0")
    order.filled_avg_price = _dec(data.get("filled_avg_price"))
    order.filled_at = parse_ts(data.get("filled_at")) or order.filled_at
    order.canceled_at = parse_ts(data.get("canceled_at")) or order.canceled_at
    order.last_synced_at = datetime.now(UTC)
    return before != (order.status, order.filled_qty, order.filled_avg_price)


@dataclass
class SubmitOutcome:
    ok: bool
    code: str
    message: str
    http_status: int
    order: Order


def submit_paper_order(
    ctx: AppContext,
    db: Session,
    *,
    alert: Alert | None,
    symbol: str,
    side: str,
    qty: Decimal,
    client_order_id: str,
    source: str,
    order_type: str = "market",
    time_in_force: str = "day",
    market_open: bool | None = None,
) -> SubmitOutcome:
    order = Order(
        alert_fk=alert.id if alert else None,
        source=source,
        client_order_id=client_order_id,
        symbol=symbol,
        side=side,
        qty=qty,
        order_type=order_type,
        time_in_force=time_in_force,
        status="submitting",
        market_open_at_submit=market_open,
        submitted_at=datetime.now(UTC),
    )
    db.add(order)
    db.commit()  # persisted before the broker call: a crash mid-call is reconciled later

    log = ctx.activity.log
    alert_id = alert.alert_id if alert else None
    try:
        data = ctx.broker.submit_order(
            symbol=symbol,
            qty=qty,
            side=side,
            order_type=order_type,
            time_in_force=time_in_force,
            client_order_id=client_order_id,
        )
    except BrokerRejected as exc:
        order.status = "broker_rejected"
        order.error_detail = f"{exc.message} ({exc.detail})"
        db.commit()
        log("BROKER", "error", f"Alpaca PAPER rejected order — {exc.message}", alert_id=alert_id, symbol=symbol,
            action=side, qty=str(qty), rejection_reason=exc.message, error_detail=exc.detail)
        return SubmitOutcome(False, "BROKER_REJECTED", f"Alpaca PAPER rejected the order: {exc.message}", 422, order)
    except BrokerError as exc:
        if exc.maybe_submitted:
            # The request may have reached Alpaca. Look it up by client_order_id.
            found = None
            try:
                found = ctx.broker.get_order_by_client_id(client_order_id)
            except BrokerError:
                found = None
            if found:
                apply_alpaca_order(order, found)
                db.commit()
                log("BROKER", "success", "PAPER order confirmed after timeout (reconciled by client_order_id)",
                    alert_id=alert_id, symbol=symbol, action=side, qty=str(qty),
                    alpaca_order_id=order.alpaca_order_id, alpaca_status=order.status)
                return SubmitOutcome(True, "ACCEPTED", "PAPER order submitted (confirmed after timeout)", 200, order)
            order.status = "unknown"
            order.error_detail = f"{exc.code}: {exc.message}"
            db.commit()
            log("BROKER", "error", f"{exc.message}; order status unknown, reconciling by client_order_id",
                alert_id=alert_id, symbol=symbol, action=side, qty=str(qty), error_detail=exc.code)
            return SubmitOutcome(
                False, exc.code, f"{exc.message}. Order status is UNKNOWN and will be reconciled; it will not be resent.",
                exc.http_status, order,
            )
        order.status = "failed"
        order.error_detail = f"{exc.code}: {exc.message}"
        db.commit()
        log("BROKER", "error", f"PAPER order not submitted — {exc.message}", alert_id=alert_id, symbol=symbol,
            action=side, qty=str(qty), error_detail=exc.code)
        return SubmitOutcome(False, exc.code, exc.message, exc.http_status, order)

    apply_alpaca_order(order, data)
    db.commit()
    log("BROKER", "success", "Alpaca PAPER order submitted", alert_id=alert_id, symbol=symbol, action=side,
        qty=str(qty), alpaca_order_id=order.alpaca_order_id, alpaca_status=order.status)
    if order.status == "filled":
        log("BROKER", "success", f"PAPER order filled @ {order.filled_avg_price}", alert_id=alert_id, symbol=symbol,
            action=side, qty=str(order.filled_qty), alpaca_order_id=order.alpaca_order_id, alpaca_status=order.status)
    return SubmitOutcome(True, "ACCEPTED", "PAPER order submitted", 200, order)


def sync_orders(ctx: AppContext) -> int:
    """Refresh every non-terminal order from Alpaca. Returns number of changed orders."""
    if not ctx.broker.configured:
        return 0
    from .ledger import rebuild_trades

    changed = 0
    with ctx.database.session() as db:
        pending = db.scalars(select(Order).where(Order.status.not_in(TERMINAL_STATUSES))).all()
        for order in pending:
            try:
                if order.alpaca_order_id:
                    data: dict[str, Any] | None = ctx.broker.get_order(order.alpaca_order_id)
                else:
                    data = ctx.broker.get_order_by_client_id(order.client_order_id)
            except BrokerError:
                continue
            if data is None:
                if order.status in RECONCILE_STATUSES and (datetime.now(UTC) - order.submitted_at).total_seconds() > 120:
                    order.status = "failed"
                    order.error_detail = (order.error_detail or "") + " | not found at Alpaca after reconciliation"
                    db.commit()
                    ctx.activity.log("BROKER", "error", "Unconfirmed PAPER order not found at Alpaca; marked failed",
                                     symbol=order.symbol, action=order.side)
                continue
            old_status = order.status
            if apply_alpaca_order(order, data):
                changed += 1
                db.commit()
                level = "success" if order.status in ("filled", "partially_filled") else (
                    "error" if order.status in ("rejected", "expired", "canceled") else "info")
                if order.status != old_status:
                    ctx.activity.log("BROKER", level, f"PAPER order {order.status.replace('_', ' ')}",
                                     symbol=order.symbol, action=order.side, qty=str(order.filled_qty),
                                     alpaca_order_id=order.alpaca_order_id, alpaca_status=order.status,
                                     alert_id=order.alert.alert_id if order.alert else None)
            else:
                db.commit()
        if changed:
            rebuild_trades(db)
    return changed

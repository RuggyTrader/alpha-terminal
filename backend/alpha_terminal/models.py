"""Persistent data models.

Money and quantities are stored as decimal strings so SQLite and PostgreSQL
keep exact values.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, TypeDecorator
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class DecimalString(TypeDecorator[Decimal]):
    impl = String(40)
    cache_ok = True

    def process_bind_param(self, value, dialect):  # type: ignore[no-untyped-def]
        if value is None:
            return None
        return format(Decimal(value), "f")

    def process_result_value(self, value, dialect):  # type: ignore[no-untyped-def]
        if value is None:
            return None
        return Decimal(value)


class UTCDateTime(TypeDecorator[datetime]):
    """Always returns timezone-aware UTC datetimes (SQLite drops tzinfo)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):  # type: ignore[no-untyped-def]
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def process_result_value(self, value, dialect):  # type: ignore[no-untyped-def]
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class Alert(Base):
    """One authenticated TradingView alert. alert_id is UNIQUE: this row is the
    persistent duplicate guard, so a retried alert can never be processed twice."""

    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    alert_id: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    received_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    source_ip: Mapped[str | None] = mapped_column(String(64))
    symbol: Mapped[str | None] = mapped_column(String(32))
    action: Mapped[str | None] = mapped_column(String(16))
    strategy: Mapped[str | None] = mapped_column(String(64))
    order_type: Mapped[str | None] = mapped_column(String(32))
    requested_qty: Mapped[Decimal | None] = mapped_column(DecimalString)
    accepted_qty: Mapped[Decimal | None] = mapped_column(DecimalString)
    payload_json: Mapped[str | None] = mapped_column(Text)  # secret removed before storing
    # processing | accepted | rejected | error
    status: Mapped[str] = mapped_column(String(16), default="processing", nullable=False)
    validation_result: Mapped[str | None] = mapped_column(String(16))  # passed | failed
    response_code: Mapped[str | None] = mapped_column(String(48))
    http_status: Mapped[int | None] = mapped_column(Integer)
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    duplicate_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_duplicate_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    orders: Mapped[list[Order]] = relationship(back_populates="alert")
    risk_decisions: Mapped[list[RiskDecision]] = relationship(back_populates="alert")


class RiskDecision(Base):
    __tablename__ = "risk_decisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    alert_fk: Mapped[int | None] = mapped_column(ForeignKey("alerts.id"))
    decided_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    approved: Mapped[bool] = mapped_column(Boolean, nullable=False)
    code: Mapped[str] = mapped_column(String(48), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    side: Mapped[str | None] = mapped_column(String(8))
    final_qty: Mapped[Decimal | None] = mapped_column(DecimalString)
    reference_price: Mapped[Decimal | None] = mapped_column(DecimalString)
    reference_price_time: Mapped[datetime | None] = mapped_column(UTCDateTime)
    estimated_notional: Mapped[Decimal | None] = mapped_column(DecimalString)
    checks_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)

    alert: Mapped[Alert | None] = relationship(back_populates="risk_decisions")


class Order(Base):
    """A PAPER order this application submitted (or tried to submit) to Alpaca."""

    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    alert_fk: Mapped[int | None] = mapped_column(ForeignKey("alerts.id"))
    source: Mapped[str] = mapped_column(String(24), default="webhook", nullable=False)  # webhook | manual_close
    client_order_id: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    alpaca_order_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    qty: Mapped[Decimal] = mapped_column(DecimalString, nullable=False)
    order_type: Mapped[str] = mapped_column(String(16), default="market", nullable=False)
    time_in_force: Mapped[str] = mapped_column(String(8), default="day", nullable=False)
    # Alpaca's own status string, or one of our pre-broker states:
    # submitting | unknown (timeout/5xx, being reconciled) | failed (never reached Alpaca)
    # | broker_rejected (Alpaca refused the request)
    status: Mapped[str] = mapped_column(String(32), default="submitting", nullable=False)
    market_open_at_submit: Mapped[bool | None] = mapped_column(Boolean)
    submitted_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    alpaca_created_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    filled_qty: Mapped[Decimal] = mapped_column(DecimalString, default=Decimal("0"), nullable=False)
    filled_avg_price: Mapped[Decimal | None] = mapped_column(DecimalString)
    filled_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    canceled_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False)
    last_synced_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    error_detail: Mapped[str | None] = mapped_column(Text)

    alert: Mapped[Alert | None] = relationship(back_populates="orders")


class Trade(Base):
    """A round trip derived from filled PAPER orders (rebuilt by ledger.py)."""

    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    direction: Mapped[str] = mapped_column(String(8), nullable=False)  # long | short
    status: Mapped[str] = mapped_column(String(8), nullable=False)  # open | closed
    strategy: Mapped[str | None] = mapped_column(String(64))
    open_alert_id: Mapped[str | None] = mapped_column(String(128))
    open_order_id: Mapped[str | None] = mapped_column(String(64))
    close_order_id: Mapped[str | None] = mapped_column(String(64))
    entry_qty: Mapped[Decimal] = mapped_column(DecimalString, nullable=False)
    entry_avg_price: Mapped[Decimal] = mapped_column(DecimalString, nullable=False)
    exit_qty: Mapped[Decimal] = mapped_column(DecimalString, default=Decimal("0"), nullable=False)
    exit_avg_price: Mapped[Decimal | None] = mapped_column(DecimalString)
    open_qty: Mapped[Decimal] = mapped_column(DecimalString, nullable=False)
    closed_cost_basis: Mapped[Decimal] = mapped_column(DecimalString, default=Decimal("0"), nullable=False)
    realized_pnl: Mapped[Decimal] = mapped_column(DecimalString, default=Decimal("0"), nullable=False)
    return_pct: Mapped[Decimal | None] = mapped_column(DecimalString)
    opened_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    leg_order_ids_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)  # local Order.id list


class ActivityEvent(Base):
    __tablename__ = "activity_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False, index=True)
    category: Mapped[str] = mapped_column(String(16), nullable=False)  # WEBHOOK AUTH RISK BROKER ENGINE SYSTEM SECURITY
    level: Mapped[str] = mapped_column(String(12), nullable=False)  # success decision error info
    message: Mapped[str] = mapped_column(Text, nullable=False)
    alert_id: Mapped[str | None] = mapped_column(String(128))
    symbol: Mapped[str | None] = mapped_column(String(32))
    action: Mapped[str | None] = mapped_column(String(16))
    strategy: Mapped[str | None] = mapped_column(String(64))
    qty: Mapped[str | None] = mapped_column(String(40))
    validation_result: Mapped[str | None] = mapped_column(String(16))
    risk_result: Mapped[str | None] = mapped_column(String(48))
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    alpaca_order_id: Mapped[str | None] = mapped_column(String(64))
    alpaca_status: Mapped[str | None] = mapped_column(String(32))
    error_detail: Mapped[str | None] = mapped_column(Text)


class EngineStateRow(Base):
    """Singleton row (id=1) holding execution engine state."""

    __tablename__ = "engine_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    state: Mapped[str] = mapped_column(String(16), default="STOPPED", nullable=False)
    kill_switch: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    killed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    reason: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(32))


class AppMeta(Base):
    """Small key/value store: schema version, counters, PAPER baseline equity."""

    __tablename__ = "app_meta"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


class AuthSession(Base):
    """Dashboard login session. Only a SHA-256 hash of the token is stored."""

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    ip: Mapped[str | None] = mapped_column(String(64))

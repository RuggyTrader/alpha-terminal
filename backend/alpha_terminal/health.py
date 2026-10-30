"""System health. Every status is computed from a real check; nothing defaults to HEALTHY."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select

from . import engine as engine_mod
from .broker import BrokerError, PriceInfo
from .context import AppContext
from .models import Alert, Order
from .version import VERSION

HEALTHY, DEGRADED, OFFLINE, STOPPED, STALE, ERROR, NOT_CONFIGURED = (
    "HEALTHY", "DEGRADED", "OFFLINE", "STOPPED", "STALE", "ERROR", "NOT CONFIGURED",
)
# Components that make the whole system DEGRADED when not HEALTHY.
CRITICAL = ("webhook", "database", "alpaca_paper", "duplicate_protection", "activity_logging", "authentication")


def _cached(ctx: AppContext, key: str, ttl: float, fn: Any) -> Any:
    hit = ctx.cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < ttl:
        return hit[1]
    value = fn()
    ctx.cache[key] = (now, value)
    return value


def alpaca_status(ctx: AppContext, *, fresh: bool = False) -> dict[str, Any]:
    def check() -> dict[str, Any]:
        if not ctx.broker.configured:
            return {"status": NOT_CONFIGURED, "detail": "ALPACA_KEY / ALPACA_SECRET not set", "checked_at": None}
        try:
            account = ctx.broker.get_account()
            status = str(account.get("status", "")).upper()
            ok = status == "ACTIVE" and not account.get("trading_blocked")
            return {"status": HEALTHY if ok else DEGRADED, "detail": f"account {status}",
                    "checked_at": datetime.now(UTC).isoformat()}
        except BrokerError as exc:
            return {"status": OFFLINE if exc.code in ("BROKER_TIMEOUT", "BROKER_UNAVAILABLE") else ERROR,
                    "detail": exc.message, "checked_at": datetime.now(UTC).isoformat()}

    if fresh:
        ctx.cache.pop("alpaca_status", None)
    return _cached(ctx, "alpaca_status", 30, check)  # type: ignore[no-any-return]


def market_data_status(ctx: AppContext) -> dict[str, Any]:
    def check() -> dict[str, Any]:
        if not ctx.broker.configured:
            return {"status": NOT_CONFIGURED, "detail": "Alpaca keys not set"}
        symbol = ctx.settings.allowed_symbols[0]
        try:
            info: PriceInfo = ctx.broker.latest_price(symbol)
        except BrokerError as exc:
            return {"status": ERROR, "detail": exc.message}
        age = info.age_seconds()
        status = HEALTHY if age <= ctx.settings.market_data_max_age_seconds else STALE
        return {"status": status, "detail": f"{symbol} last trade {info.timestamp.isoformat()} (IEX feed)",
                "last_trade_at": info.timestamp.isoformat(), "age_seconds": int(age)}

    return _cached(ctx, "market_data_status", 60, check)  # type: ignore[no-any-return]


def compute_health(ctx: AppContext) -> dict[str, Any]:
    s = ctx.settings
    db_ok = ctx.database.ping()
    integrity: dict[str, Any] = {}
    engine_state = "UNKNOWN"
    kill = None
    last_accepted = last_order = None
    if db_ok:
        try:
            integrity = ctx.database.integrity_report()
            with ctx.database.session() as db:
                snap = engine_mod.snapshot(db)
                engine_state, kill = snap.state, snap.kill_switch
                last_accepted = db.scalar(select(func.max(Alert.processed_at)).where(Alert.status == "accepted"))
                last_order = db.scalar(select(func.max(Order.submitted_at)).where(
                    Order.alpaca_order_id.is_not(None), Order.status.not_in(["broker_rejected", "failed"])))
        except Exception:
            db_ok = False

    components: dict[str, dict[str, Any]] = {}
    components["database"] = {"status": HEALTHY if db_ok else ERROR,
                              "detail": "query ok" if db_ok else "database query failed"}
    components["webhook"] = (
        {"status": HEALTHY, "detail": "POST /webhook accepting authenticated alerts"}
        if s.webhook_secret and db_ok else
        {"status": NOT_CONFIGURED if not s.webhook_secret else ERROR,
         "detail": "WEBHOOK_SECRET not set" if not s.webhook_secret else "database unavailable"}
    )
    components["alpaca_paper"] = alpaca_status(ctx)
    if engine_state == engine_mod.RUNNING:
        components["execution_engine"] = {"status": HEALTHY if s.enable_trading else DEGRADED, "detail": "RUNNING"}
    elif engine_state in (engine_mod.STOPPED, engine_mod.PAUSED):
        components["execution_engine"] = {"status": STOPPED, "detail": engine_state + (" (kill switch)" if kill else "")}
    else:
        components["execution_engine"] = {"status": ERROR, "detail": "engine state unreadable"}
    dup_ok = bool(integrity.get("duplicate_guard_unique_index"))
    components["duplicate_protection"] = {"status": HEALTHY if dup_ok else ERROR,
                                          "detail": "UNIQUE(alert_id) index present" if dup_ok else "unique index missing"}
    components["market_data"] = market_data_status(ctx)
    log_ok = ctx.activity.last_write_ok
    components["activity_logging"] = {
        "status": ERROR if log_ok is False or not db_ok else HEALTHY,
        "detail": ctx.activity.last_error or ("writes ok" if db_ok else "database unavailable"),
    }
    components["authentication"] = (
        {"status": HEALTHY, "detail": "server-side sessions; ADMIN_SECRET set"} if s.admin_secret
        else {"status": NOT_CONFIGURED, "detail": "ADMIN_SECRET not set; dashboard login disabled"}
    )
    overall = HEALTHY if all(components[k]["status"] == HEALTHY for k in CRITICAL) else DEGRADED
    return {
        "components": components,
        "system_health": overall,
        "engine_state": engine_state,
        "kill_switch": kill,
        "last_webhook_at": ctx.meta_get("last_webhook_at") if db_ok else None,
        "last_accepted_alert_at": last_accepted.isoformat() if last_accepted else None,
        "last_successful_order_at": last_order.isoformat() if last_order else None,
        "version": VERSION,
    }


def public_health(ctx: AppContext) -> dict[str, Any]:
    h = compute_health(ctx)
    c = h["components"]
    return {
        "server": "ONLINE",
        "version": h["version"],
        "mode": "PAPER",
        "paper_only": True,
        "engine_state": h["engine_state"],
        "database": c["database"]["status"],
        "alpaca_paper": c["alpaca_paper"]["status"],
        "last_webhook_at": h["last_webhook_at"],
        "last_accepted_alert_at": h["last_accepted_alert_at"],
        "last_successful_order_at": h["last_successful_order_at"],
        "system_health": h["system_health"],
        "components": {k: v["status"] for k, v in c.items()},
    }

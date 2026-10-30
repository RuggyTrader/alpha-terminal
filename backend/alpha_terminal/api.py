"""Private (authenticated) API used by the dashboard. All data comes from
Alpaca PAPER or from persisted records; unavailable values are null."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func, select

from . import engine as engine_mod
from .auth import get_ctx, require_admin
from .broker import BrokerError
from .context import AppContext
from .health import compute_health
from .ledger import ledger_stats, rebuild_trades
from .models import ActivityEvent, Alert, Order, RiskDecision, Trade
from .orders import submit_paper_order, sync_orders
from .schemas import SUPPORTED_ORDER_TYPES, api_response

router = APIRouter(dependencies=[Depends(require_admin)])


# ---------------------------------------------------------------- helpers
def _s(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _d(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _market(asset_class: Any) -> str:
    return "CRYPTO" if str(asset_class) == "crypto" else "STOCKS"


def _try(fn: Any) -> tuple[Any, str | None]:
    try:
        return fn(), None
    except BrokerError as exc:
        return None, exc.message


def _baseline(ctx: AppContext, account: dict[str, Any]) -> dict[str, Any]:
    if ctx.settings.paper_starting_equity is not None:
        return {"equity": ctx.settings.paper_starting_equity, "source": "PAPER_STARTING_EQUITY", "set_at": None}
    account_id = str(account.get("id", ""))
    stored_id = ctx.meta_get("baseline_account_id")
    stored_eq = ctx.meta_get("baseline_equity")
    if stored_eq is None or stored_id != account_id:
        equity = str(account.get("equity"))
        now = datetime.now(UTC).isoformat()
        if stored_id and stored_id != account_id:
            ctx.activity.log("SYSTEM", "decision", "PAPER account changed or was reset — return baseline re-captured")
        ctx.meta_set("baseline_equity", equity)
        ctx.meta_set("baseline_account_id", account_id)
        ctx.meta_set("baseline_set_at", now)
        return {"equity": Decimal(equity), "source": "captured_first_connection", "set_at": now}
    return {"equity": Decimal(stored_eq), "source": "captured_first_connection", "set_at": ctx.meta_get("baseline_set_at")}


def _counters(ctx: AppContext, db: Any) -> dict[str, int]:
    accepted = db.scalar(select(func.count()).select_from(Alert).where(Alert.status == "accepted")) or 0
    rejected = db.scalar(select(func.count()).select_from(Alert).where(Alert.status.in_(["rejected", "error"]))) or 0
    dups = db.scalar(select(func.coalesce(func.sum(Alert.duplicate_count), 0))) or 0
    return {
        "alerts_received": int(ctx.meta_get("webhook_received") or 0),
        "alerts_accepted": int(accepted),
        "alerts_rejected": int(rejected) + int(ctx.meta_get("webhook_rejected_pre_claim") or 0),
        "duplicates_blocked": int(dups),
    }


def _alert_brief(a: Alert | None) -> dict[str, Any] | None:
    if a is None:
        return None
    return {
        "id": a.id, "alert_id": a.alert_id, "received_at": _s(a.received_at), "symbol": a.symbol,
        "action": a.action, "strategy": a.strategy, "status": a.status, "code": a.response_code,
        "rejection_reason": a.rejection_reason, "requested_qty": _s(a.requested_qty),
        "accepted_qty": _s(a.accepted_qty), "duplicate_count": a.duplicate_count,
    }


def _order_dict(o: Order) -> dict[str, Any]:
    return {
        "id": o.id, "source": o.source, "symbol": o.symbol, "market": "STOCKS", "side": o.side, "qty": _s(o.qty),
        "order_type": o.order_type, "time_in_force": o.time_in_force, "status": o.status,
        "alpaca_order_id": o.alpaca_order_id, "client_order_id": o.client_order_id,
        "submitted_at": _s(o.submitted_at), "alpaca_created_at": _s(o.alpaca_created_at),
        "filled_qty": _s(o.filled_qty), "filled_avg_price": _s(o.filled_avg_price), "filled_at": _s(o.filled_at),
        "canceled_at": _s(o.canceled_at), "market_open_at_submit": o.market_open_at_submit,
        "last_synced_at": _s(o.last_synced_at), "error_detail": o.error_detail,
        "alert_id": o.alert.alert_id if o.alert else None,
        "verified": bool(o.alpaca_order_id) and o.status not in ("unknown", "submitting", "failed", "broker_rejected"),
    }


def _risk_dict(r: RiskDecision) -> dict[str, Any]:
    return {
        "id": r.id, "decided_at": _s(r.decided_at), "approved": r.approved, "code": r.code, "reason": r.reason,
        "side": r.side, "final_qty": _s(r.final_qty), "reference_price": _s(r.reference_price),
        "reference_price_time": _s(r.reference_price_time), "estimated_notional": _s(r.estimated_notional),
        "checks": json.loads(r.checks_json or "[]"),
    }


def _alert_detail(a: Alert) -> dict[str, Any]:
    payload = json.loads(a.payload_json) if a.payload_json else None
    return {
        **(_alert_brief(a) or {}),
        "database_record_id": a.id, "processed_at": _s(a.processed_at), "order_type": a.order_type,
        "validation_result": a.validation_result, "http_status": a.http_status,
        "last_duplicate_at": _s(a.last_duplicate_at), "payload": payload,  # secret was stripped before storage
        "risk_decisions": [_risk_dict(r) for r in a.risk_decisions],
        "orders": [_order_dict(o) for o in a.orders],
    }


# ---------------------------------------------------------------- engine
def _engine_action(request: Request, action: str) -> dict[str, Any]:
    ctx = get_ctx(request)
    with ctx.database.session() as db:
        try:
            snap = engine_mod.transition(db, action, enable_trading=ctx.settings.enable_trading)
        except engine_mod.EngineTransitionError as exc:
            ctx.activity.log("ENGINE", "error", f"Engine {action} refused — {exc.message}", rejection_reason=exc.code)
            raise HTTPException(409, detail={"code": exc.code, "message": exc.message}) from exc
    ctx.activity.log("ENGINE", "decision" if snap.state != "RUNNING" else "success", f"Engine {snap.state}")
    return api_response(ok=True, status="ok", code=f"ENGINE_{snap.state}", message=f"Engine {snap.state}",
                        data=snap.as_dict())


@router.post("/engine/start")
def engine_start(request: Request) -> dict[str, Any]:
    return _engine_action(request, "start")


@router.post("/engine/pause")
def engine_pause(request: Request) -> dict[str, Any]:
    return _engine_action(request, "pause")


@router.post("/engine/resume")
def engine_resume(request: Request) -> dict[str, Any]:
    return _engine_action(request, "resume")


@router.post("/engine/stop")
def engine_stop(request: Request) -> dict[str, Any]:
    return _engine_action(request, "stop")


@router.post("/kill")
def kill(request: Request) -> dict[str, Any]:
    """STOP NEW ORDERS. Does not cancel or close anything."""
    ctx = get_ctx(request)
    with ctx.database.session() as db:
        snap = engine_mod.kill(db)
    ctx.activity.log("ENGINE", "error", "KILL SWITCH ENGAGED — new PAPER orders blocked (positions untouched)")
    return api_response(ok=True, status="ok", code="KILL_SWITCH_ACTIVE",
                        message="New PAPER orders blocked. Existing positions and open orders were not touched.",
                        data=snap.as_dict())


@router.post("/kill/reset")
def kill_reset(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    with ctx.database.session() as db:
        snap = engine_mod.reset_kill(db)
    ctx.activity.log("ENGINE", "decision", "Kill switch reset — engine remains STOPPED")
    return api_response(ok=True, status="ok", code="KILL_SWITCH_RESET", message="Kill switch reset; engine STOPPED",
                        data=snap.as_dict())


# ---------------------------------------------------------------- summary
@router.get("/api/summary")
def summary(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    account, account_err = _try(ctx.broker.get_account) if ctx.broker.configured else (None, "NOT CONFIGURED")
    positions, pos_err = _try(ctx.broker.get_positions) if ctx.broker.configured else (None, "NOT CONFIGURED")
    with ctx.database.session() as db:
        stats = ledger_stats(db)
        snap = engine_mod.snapshot(db)
    realized: Decimal = stats["realized_pnl"]  # type: ignore[assignment]
    acct: dict[str, Any] = {"available": account is not None, "error": account_err}
    unrealized = exposure = None
    if positions is not None:
        unrealized = sum((_d(p.get("unrealized_pl")) or Decimal(0) for p in positions), Decimal(0))
        exposure = sum((abs(_d(p.get("market_value")) or Decimal(0)) for p in positions), Decimal(0))
    if account is not None:
        equity = _d(account.get("equity"))
        last_equity = _d(account.get("last_equity"))
        base = _baseline(ctx, account)
        verified = (equity - base["equity"]) if equity is not None else None
        ret = (verified / base["equity"] * 100) if verified is not None and base["equity"] > 0 else None
        acct.update({
            "broker": "ALPACA PAPER",
            "account_number": account.get("account_number"),
            "status": account.get("status"),
            "currency": account.get("currency"),
            "equity": _s(equity),
            "buying_power": _s(_d(account.get("buying_power"))),
            "cash": _s(_d(account.get("cash"))),
            "last_equity": _s(last_equity),
            "todays_pnl": _s((equity - last_equity).quantize(Decimal("0.01"))) if equity is not None and last_equity is not None else None,
            "baseline_equity": _s(base["equity"]),
            "baseline_source": base["source"],
            "baseline_set_at": base["set_at"],
            "verified_pnl": _s(verified.quantize(Decimal("0.01"))) if verified is not None else None,
            "account_return_pct": _s(ret.quantize(Decimal("0.01"))) if ret is not None else None,
            "pattern_day_trader": account.get("pattern_day_trader"),
            "shorting_enabled": account.get("shorting_enabled"),
        })
    return {
        "mode": "PAPER",
        "engine": snap.as_dict(),
        "account": acct,
        "positions_available": positions is not None,
        "positions_error": pos_err,
        "open_positions": len(positions) if positions is not None else None,
        "open_exposure": _s(exposure),
        "realized_pnl": _s(realized),
        "unrealized_pnl": _s(unrealized.quantize(Decimal("0.01"))) if unrealized is not None else None,
        "total_pnl": _s((realized + unrealized).quantize(Decimal("0.01"))) if unrealized is not None else None,
        "closed_trades": stats["closed_trades"],
        "winning_trades": stats["winning_trades"],
        "win_rate_pct": _s(stats["win_rate_pct"]),
        "closed_trade_return_pct": _s(stats["closed_trade_return_pct"]),
        "markets": {
            "stocks": {"provider": "ALPACA PAPER", "status": "ACTIVE" if ctx.broker.configured else "NOT CONFIGURED"},
            "crypto": {"provider": "NOT CONFIGURED", "status": "NOT CONFIGURED"},
        },
        "as_of": datetime.now(UTC).isoformat(),
    }


@router.get("/api/positions")
def positions(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    if not ctx.broker.configured:
        return {"available": False, "error": "NOT CONFIGURED", "positions": []}
    raw, err = _try(ctx.broker.get_positions)
    if raw is None:
        return {"available": False, "error": err, "positions": []}
    with ctx.database.session() as db:
        open_trades: dict[str, Trade] = ledger_stats(db)["open_trade_by_symbol"]  # type: ignore[assignment]
    out = []
    for p in raw:
        symbol = str(p.get("symbol"))
        price_info, price_err = _try(lambda s=symbol: ctx.broker.latest_price(s))
        price_block: dict[str, Any] = {"status": "UNAVAILABLE", "price": None, "as_of": None,
                                       "detail": price_err or "MARKET DATA UNAVAILABLE"}
        if price_info is not None:
            age = price_info.age_seconds()
            price_block = {
                "status": "CURRENT" if age <= ctx.settings.market_data_max_age_seconds else "STALE",
                "price": _s(price_info.price), "as_of": price_info.timestamp.isoformat(), "age_seconds": int(age),
                "detail": "latest IEX trade",
            }
        qty = _d(p.get("qty")) or Decimal(0)
        trade = open_trades.get(symbol)
        plpc = _d(p.get("unrealized_plpc"))
        out.append({
            "symbol": symbol, "market": _market(p.get("asset_class")),
            "direction": "LONG" if qty > 0 else "SHORT", "qty": _s(qty),
            "qty_available": p.get("qty_available"), "avg_entry_price": p.get("avg_entry_price"),
            "current": price_block, "alpaca_current_price": p.get("current_price"),
            "market_value": p.get("market_value"), "cost_basis": p.get("cost_basis"),
            "unrealized_pnl": p.get("unrealized_pl"),
            "unrealized_pct": _s((plpc * 100).quantize(Decimal("0.01"))) if plpc is not None else None,
            "strategy": trade.strategy if trade else None,
            "opened_at": _s(trade.opened_at) if trade else None,
            "alert_id": trade.open_alert_id if trade else None,
            "tracked_by_terminal": bool(trade and trade.open_qty == abs(qty)),
        })
    return {"available": True, "error": None, "positions": out, "as_of": datetime.now(UTC).isoformat()}


# ---------------------------------------------------------------- trades / alerts
def _trade_dict(t: Trade, orders_by_id: dict[int, Order]) -> dict[str, Any]:
    legs = [orders_by_id[i] for i in json.loads(t.leg_order_ids_json or "[]") if i in orders_by_id]
    first = legs[0] if legs else None
    return {
        "id": t.id, "symbol": t.symbol, "market": "STOCKS", "strategy": t.strategy, "direction": t.direction.upper(),
        "side": "BUY" if t.direction == "long" else "SELL", "status": t.status.upper(),
        "qty": _s(t.entry_qty), "open_qty": _s(t.open_qty), "order_type": (first.order_type if first else "market").upper(),
        "entry_price": _s(t.entry_avg_price), "exit_price": _s(t.exit_avg_price), "exit_qty": _s(t.exit_qty),
        "realized_pnl": _s(t.realized_pnl), "return_pct": _s(t.return_pct),
        "opened_at": _s(t.opened_at), "closed_at": _s(t.closed_at), "alert_id": t.open_alert_id,
        "alpaca_order_id": t.open_order_id, "close_order_id": t.close_order_id,
        "order_status": first.status if first else None,
        "badge": "VERIFIED PAPER" if legs and all(o.alpaca_order_id for o in legs) else "PAPER ORDER",
        "leg_count": len(legs),
    }


@router.get("/api/trades")
def trades(request: Request, limit: int = Query(100, ge=1, le=500)) -> dict[str, Any]:
    ctx = get_ctx(request)
    with ctx.database.session() as db:
        rows = db.scalars(select(Trade).order_by(Trade.opened_at.desc()).limit(limit)).all()
        orders_by_id = {o.id: o for o in db.scalars(select(Order)).all()}
        return {"trades": [_trade_dict(t, orders_by_id) for t in rows]}


@router.get("/api/trades/{trade_id}")
def trade_detail(request: Request, trade_id: int) -> dict[str, Any]:
    ctx = get_ctx(request)
    with ctx.database.session() as db:
        t = db.get(Trade, trade_id)
        if t is None:
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Trade not found"})
        orders_by_id = {o.id: o for o in db.scalars(select(Order)).all()}
        legs = []
        for oid in json.loads(t.leg_order_ids_json or "[]"):
            o = orders_by_id.get(oid)
            if o is None:
                continue
            legs.append({"order": _order_dict(o), "alert": _alert_detail(o.alert) if o.alert else None})
        result = {**_trade_dict(t, orders_by_id), "database_record_id": t.id, "legs": legs,
                  "closed_cost_basis": _s(t.closed_cost_basis), "unrealized": None}
    if t.status == "open" and ctx.broker.configured:
        pos, err = _try(lambda: ctx.broker.get_position(t.symbol))
        result["unrealized"] = (
            {"available": True, "pnl": pos.get("unrealized_pl"), "source": "Alpaca PAPER position"} if pos
            else {"available": False, "detail": err or "no Alpaca position"}
        )
    return result


@router.get("/api/alerts")
def alerts(request: Request, limit: int = Query(100, ge=1, le=500)) -> dict[str, Any]:
    ctx = get_ctx(request)
    with ctx.database.session() as db:
        rows = db.scalars(select(Alert).order_by(Alert.id.desc()).limit(limit)).all()
        out = []
        for a in rows:
            item = _alert_brief(a) or {}
            item["order"] = _order_dict(a.orders[-1]) if a.orders else None
            out.append(item)
        return {"alerts": out}


@router.get("/api/alerts/{record_id}")
def alert_detail(request: Request, record_id: int) -> dict[str, Any]:
    ctx = get_ctx(request)
    with ctx.database.session() as db:
        a = db.get(Alert, record_id)
        if a is None:
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Alert not found"})
        return _alert_detail(a)


@router.get("/api/activity")
def activity(request: Request, limit: int = Query(100, ge=1, le=500), after_id: int | None = None) -> dict[str, Any]:
    ctx = get_ctx(request)
    with ctx.database.session() as db:
        q = select(ActivityEvent)
        if after_id is not None:
            q = q.where(ActivityEvent.id > after_id)
        rows = db.scalars(q.order_by(ActivityEvent.id.desc()).limit(limit)).all()
        cols = ("alert_id", "symbol", "action", "strategy", "qty", "validation_result", "risk_result",
                "rejection_reason", "alpaca_order_id", "alpaca_status", "error_detail")
        return {"events": [
            {"id": e.id, "ts": _s(e.ts), "category": e.category, "level": e.level, "message": e.message,
             **{c: getattr(e, c) for c in cols}}
            for e in rows
        ]}


# ---------------------------------------------------------------- engine / settings
@router.get("/api/engine")
def engine_overview(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    health = compute_health(ctx)
    with ctx.database.session() as db:
        snap = engine_mod.snapshot(db)
        last = db.scalars(select(Alert).order_by(Alert.id.desc()).limit(1)).first()
        last_ok = db.scalars(select(Alert).where(Alert.status == "accepted").order_by(Alert.id.desc()).limit(1)).first()
        last_bad = db.scalars(select(Alert).where(Alert.status.in_(["rejected", "error"])).order_by(Alert.id.desc()).limit(1)).first()
        last_order = db.scalars(select(Order).order_by(Order.id.desc()).limit(1)).first()
        counters = _counters(ctx, db)
        data = {
            "engine": snap.as_dict(),
            "enable_trading": ctx.settings.enable_trading,
            "counters": counters,
            "last_alert": _alert_brief(last),
            "last_accepted_alert": _alert_brief(last_ok),
            "last_rejected_alert": _alert_brief(last_bad),
            "last_order": _order_dict(last_order) if last_order else None,
            "last_webhook_at": health["last_webhook_at"],
        }
    open_positions = None
    if ctx.broker.configured:
        raw, _ = _try(ctx.broker.get_positions)
        open_positions = len(raw) if raw is not None else None
    data["open_positions"] = open_positions
    data["health"] = health
    return data


@router.get("/api/system/health")
def system_health(request: Request) -> dict[str, Any]:
    return compute_health(get_ctx(request))


@router.get("/api/settings")
def settings_view(request: Request, auth_method: str = Depends(require_admin)) -> dict[str, Any]:
    ctx = get_ctx(request)
    s = ctx.settings
    return {
        "mode": "PAPER",
        "paper_only": True,
        "broker": {"name": "ALPACA PAPER", "configured": s.alpaca_configured,
                   "trading_host": "paper-api.alpaca.markets", "market_data_host": "data.alpaca.markets (IEX feed)"},
        "tradingview": {"webhook_url": s.webhook_url, "webhook_secret_configured": bool(s.webhook_secret),
                        "rate_limit_per_minute": s.webhook_rate_limit_per_minute,
                        "ip_allowlist_enabled": bool(s.tradingview_ip_allowlist)},
        "markets": {
            "stocks": {"provider": "ALPACA PAPER", "status": "ACTIVE" if s.alpaca_configured else "NOT CONFIGURED"},
            "crypto": {"provider": "NOT CONFIGURED", "status": "NOT CONFIGURED"},
        },
        "execution": {"enable_trading": s.enable_trading, "allowed_order_types": [t.upper() for t in SUPPORTED_ORDER_TYPES],
                      "time_in_force": ["DAY"], "short_selling_enabled": s.short_selling_enabled,
                      "fractional_qty_enabled": s.allow_fractional_qty},
        "risk": {
            "max_order_qty": _s(s.max_order_qty), "max_order_notional": _s(s.max_order_notional),
            "max_position_exposure": _s(s.max_position_exposure), "max_total_exposure": _s(s.max_total_exposure),
            "max_open_positions": s.max_open_positions, "short_selling_protection": not s.short_selling_enabled,
            "duplicate_protection": True, "allowed_symbols": list(s.allowed_symbols),
            "daily_loss_limit": _s(s.daily_loss_limit) if s.daily_loss_limit > 0 else None,
        },
        "security": {"session_auth": True, "auth_method": auth_method, "admin_secret_configured": bool(s.admin_secret),
                     "cookie_secure": s.cookie_secure, "csrf_header_required": True,
                     "frontend_origins": list(s.frontend_origins), "api_docs_enabled": s.enable_api_docs},
        "system": {"version": ctx_version(), "database": "sqlite" if s.database_url.startswith("sqlite") else "external",
                   "started_at": ctx.started_at.isoformat(), "order_sync_interval_seconds": s.order_sync_interval_seconds},
    }


def ctx_version() -> str:
    from .version import VERSION

    return VERSION


# ---------------------------------------------------------------- explicit position / order actions
@router.post("/api/orders/sync")
async def orders_sync(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    changed = await run_in_threadpool(sync_orders, ctx)
    return api_response(ok=True, status="ok", code="SYNCED", message=f"{changed} order(s) updated")


def _manual_close(ctx: AppContext, symbol: str) -> dict[str, Any]:
    pos, err = _try(lambda: ctx.broker.get_position(symbol))
    if err:
        raise HTTPException(502, detail={"code": "BROKER_UNAVAILABLE", "message": err})
    if not pos:
        return api_response(ok=False, status="rejected", code="NO_POSITION", message=f"No PAPER position in {symbol}")
    qty = _d(pos.get("qty")) or Decimal(0)
    avail = abs(_d(pos.get("qty_available", pos.get("qty"))) or Decimal(0))
    if avail <= 0:
        return api_response(ok=False, status="rejected", code="POSITION_LOCKED", message="All shares held by open orders")
    with ctx.execution_lock, ctx.database.session() as db:
        outcome = submit_paper_order(ctx, db, alert=None, symbol=symbol, side="sell" if qty > 0 else "buy", qty=avail,
                                     client_order_id=f"at-manual-{uuid.uuid4().hex[:24]}", source="manual_close")
        if outcome.order.filled_qty and outcome.order.filled_qty > 0:
            rebuild_trades(db)
        return api_response(ok=outcome.ok, status="accepted" if outcome.ok else "rejected", code=outcome.code,
                            message=outcome.message, data=_order_dict(outcome.order))


@router.post("/api/positions/{symbol}/close")
def close_position(request: Request, symbol: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """CLOSE POSITIONS (explicit, per symbol). Separate from the kill switch."""
    ctx = get_ctx(request)
    symbol = symbol.upper()
    if body.get("confirm") != symbol:
        raise HTTPException(400, detail={"code": "CONFIRMATION_REQUIRED", "message": f'Send {{"confirm": "{symbol}"}}'})
    ctx.activity.log("ENGINE", "decision", f"Manual CLOSE requested for {symbol}", symbol=symbol, action="close")
    return _manual_close(ctx, symbol)


@router.post("/api/positions/close-all")
def close_all(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    ctx = get_ctx(request)
    if body.get("confirm") != "CLOSE ALL PAPER POSITIONS":
        raise HTTPException(400, detail={"code": "CONFIRMATION_REQUIRED", "message": 'Send {"confirm": "CLOSE ALL PAPER POSITIONS"}'})
    raw, err = _try(ctx.broker.get_positions)
    if raw is None:
        raise HTTPException(502, detail={"code": "BROKER_UNAVAILABLE", "message": err or "unavailable"})
    ctx.activity.log("ENGINE", "decision", f"Manual CLOSE ALL requested ({len(raw)} positions)")
    results = [_manual_close(ctx, str(p.get("symbol"))) for p in raw]
    return api_response(ok=all(r["ok"] for r in results), status="ok", code="CLOSE_ALL_SUBMITTED",
                        message=f"{len(results)} close order(s) attempted", data=results)


@router.post("/api/orders/cancel-open")
def cancel_open(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    ctx = get_ctx(request)
    if body.get("confirm") != "CANCEL OPEN ORDERS":
        raise HTTPException(400, detail={"code": "CONFIRMATION_REQUIRED", "message": 'Send {"confirm": "CANCEL OPEN ORDERS"}'})
    result, err = _try(ctx.broker.cancel_all_orders)
    if err:
        raise HTTPException(502, detail={"code": "BROKER_UNAVAILABLE", "message": err})
    ctx.activity.log("BROKER", "decision", f"Cancel requested for {len(result or [])} open PAPER order(s)")
    sync_orders(ctx)
    return api_response(ok=True, status="ok", code="CANCEL_REQUESTED", message=f"{len(result or [])} cancel request(s) sent")

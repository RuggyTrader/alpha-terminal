"""POST /webhook — TradingView alert → validated, de-duplicated, risk-checked PAPER order.

Pipeline (each step logs to the activity log):
  1. rate limit / optional source-IP allowlist            429 / 403
  2. body size + JSON parse                               413 / 400 INVALID_JSON
  3. webhook secret (constant-time)                       401 UNAUTHORIZED
  4. alert id present + well formed                       400 MISSING_FIELD
  5. claim alert id (UNIQUE insert, survives restarts)    200 DUPLICATE
  6. field validation (symbol whitelist, action, qty...)  400
  7. engine state / kill switch / ENABLE_TRADING          403
  8. broker snapshot + risk checks                        422 / 502 / 504
  9. Alpaca PAPER submission with deterministic client_order_id
"""

from __future__ import annotations

import hmac
import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from . import engine as engine_mod
from .broker import BrokerError, PriceInfo
from .context import AppContext
from .ledger import rebuild_trades
from .models import Alert, RiskDecision
from .orders import QUEUED_STATUSES, client_order_id_for_alert, submit_paper_order
from .risk import evaluate
from .schemas import MAX_BODY_BYTES, ValidationFailure, api_response, parse_intent, validate_alert_id

router = APIRouter()


def client_ip(request: Request, ctx: AppContext) -> str:
    if ctx.settings.trust_proxy_headers:
        for header in ("cf-connecting-ip", "fly-client-ip"):
            value = request.headers.get(header)
            if value:
                return value.strip()[:64]
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "unknown")[:64]


@router.post("/webhook")
async def webhook(request: Request) -> JSONResponse:
    ctx: AppContext = request.app.state.ctx
    ip = client_ip(request, ctx)
    if not ctx.webhook_limiter.allow(ip):
        ctx.activity.log("SECURITY", "error", "Webhook rate limit exceeded", rejection_reason=f"ip={ip}")
        return JSONResponse(
            api_response(ok=False, status="rejected", code="RATE_LIMITED", message="Too many requests"), 429
        )
    body = await request.body()
    status, payload = await run_in_threadpool(process_webhook, ctx, body, ip)
    return JSONResponse(payload, status_code=status)


def _reply(status: int, *, ok: bool, state: str, code: str, message: str, alert_id: str | None = None,
           data: Any = None) -> tuple[int, dict[str, Any]]:
    return status, api_response(ok=ok, status=state, code=code, message=message, alert_id=alert_id, data=data)


def process_webhook(ctx: AppContext, body: bytes, ip: str) -> tuple[int, dict[str, Any]]:
    s = ctx.settings
    log = ctx.activity.log
    now = datetime.now(UTC)
    ctx.meta_set("last_webhook_at", now.isoformat())
    ctx.meta_incr("webhook_received")

    def pre_claim_reject(status: int, code: str, message: str, category: str = "WEBHOOK") -> tuple[int, dict[str, Any]]:
        ctx.meta_incr("webhook_rejected_pre_claim")
        log(category, "error", f"Webhook rejected — {message}", rejection_reason=code)
        return _reply(status, ok=False, state="rejected", code=code, message=message)

    if s.tradingview_ip_allowlist and ip not in s.tradingview_ip_allowlist:
        return pre_claim_reject(403, "FORBIDDEN_SOURCE", "source IP is not in TRADINGVIEW_IP_ALLOWLIST", "SECURITY")
    if not s.webhook_secret:
        return pre_claim_reject(503, "WEBHOOK_NOT_CONFIGURED", "WEBHOOK_SECRET is not configured on the server")
    if len(body) > MAX_BODY_BYTES:
        return pre_claim_reject(413, "PAYLOAD_TOO_LARGE", "payload is larger than 16 KB")

    log("WEBHOOK", "decision", "TradingView alert received")
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return pre_claim_reject(400, "INVALID_JSON", "body is not valid JSON")
    if not isinstance(data, dict):
        return pre_claim_reject(400, "INVALID_JSON", "body must be a JSON object")

    secret = data.get("secret")
    if not isinstance(secret, str) or not hmac.compare_digest(secret.encode(), s.webhook_secret.encode()):
        return pre_claim_reject(401, "UNAUTHORIZED", "invalid webhook secret", "AUTH")

    if "id" not in data or data.get("id") in (None, ""):
        return pre_claim_reject(400, "MISSING_FIELD", "id (unique alert id) is required")
    alert_id = validate_alert_id(data.get("id"))
    if alert_id is None:
        return pre_claim_reject(400, "INVALID_ALERT_ID", "id must be 1-128 printable characters without spaces")

    log("AUTH", "success", "Alert authenticated", alert_id=alert_id)
    sanitized = {k: v for k, v in data.items() if k != "secret"}
    payload_json = json.dumps(sanitized, default=str)[:4000]

    with ctx.database.session() as db:
        # ---- 5. claim the alert id (persistent duplicate guard) -------------
        alert = Alert(
            alert_id=alert_id,
            received_at=now,
            source_ip=ip,
            symbol=str(data.get("symbol"))[:32] if data.get("symbol") is not None else None,
            action=str(data.get("action"))[:16] if data.get("action") is not None else None,
            strategy=str(data.get("strategy"))[:64] if data.get("strategy") is not None else None,
            payload_json=payload_json,
            status="processing",
        )
        db.add(alert)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.query(Alert).filter(Alert.alert_id == alert_id).one()
            existing.duplicate_count += 1
            existing.last_duplicate_at = now
            db.commit()
            log("WEBHOOK", "decision", "Duplicate alert blocked", alert_id=alert_id, symbol=existing.symbol,
                action=existing.action, strategy=existing.strategy, rejection_reason="DUPLICATE")
            return _reply(200, ok=True, state="duplicate", code="DUPLICATE",
                          message="Alert id already processed; no order submitted", alert_id=alert_id,
                          data={"original_status": existing.status, "original_code": existing.response_code})

        def finish(status: int, *, ok: bool, state: str, code: str, message: str,
                   validation: str | None = None, data_out: Any = None) -> tuple[int, dict[str, Any]]:
            alert.status = "accepted" if ok else ("error" if status >= 500 else "rejected")
            alert.processed_at = datetime.now(UTC)
            alert.response_code = code
            alert.http_status = status
            if validation:
                alert.validation_result = validation
            if not ok:
                alert.rejection_reason = message
            db.commit()
            return _reply(status, ok=ok, state=state, code=code, message=message, alert_id=alert_id, data=data_out)

        # ---- 6. validation ------------------------------------------------
        parsed = parse_intent(alert_id, data, s)
        if isinstance(parsed, ValidationFailure):
            log("WEBHOOK", "error", f"Alert rejected — {parsed.message}", alert_id=alert_id,
                symbol=alert.symbol, action=alert.action, strategy=alert.strategy,
                validation_result="failed", rejection_reason=parsed.code)
            return finish(parsed.http_status, ok=False, state="rejected", code=parsed.code, message=parsed.message,
                          validation="failed")
        intent = parsed
        alert.symbol, alert.action, alert.strategy = intent.symbol, intent.action, intent.strategy
        alert.order_type = intent.order_type
        alert.requested_qty = intent.qty
        alert.validation_result = "passed"
        db.commit()
        fields = {"alert_id": alert_id, "symbol": intent.symbol, "action": intent.action,
                  "strategy": intent.strategy, "qty": str(intent.qty) if intent.qty is not None else None}

        # ---- 7. engine gate ------------------------------------------------
        def engine_gate() -> tuple[str, str] | None:
            snap = engine_mod.snapshot(db)
            if snap.kill_switch:
                return "KILL_SWITCH_ACTIVE", "Kill switch is active; new PAPER orders are blocked"
            if snap.state == engine_mod.STOPPED:
                return "ENGINE_STOPPED", "Execution engine is STOPPED; no PAPER order submitted"
            if snap.state == engine_mod.PAUSED:
                return "ENGINE_PAUSED", "Execution engine is PAUSED; no PAPER order submitted"
            if not s.enable_trading:
                return "EXECUTION_DISABLED", "ENABLE_TRADING is false on the server"
            return None

        gate = engine_gate()
        if gate:
            log("RISK", "error", f"{intent.action.upper()} rejected — {gate[1]}", **fields,
                validation_result="passed", risk_result=gate[0], rejection_reason=gate[0])
            return finish(403, ok=False, state="rejected", code=gate[0], message=gate[1])
        if not ctx.broker.configured:
            log("BROKER", "error", "Alpaca PAPER keys not configured", **fields, rejection_reason="BROKER_NOT_CONFIGURED")
            return finish(503, ok=False, state="error", code="BROKER_NOT_CONFIGURED",
                          message="Alpaca PAPER keys are not configured on the server")

        with ctx.execution_lock:
            db.expire_all()
            gate = engine_gate()  # re-check: a kill may have landed while we waited
            if gate:
                log("RISK", "error", f"{intent.action.upper()} rejected — {gate[1]}", **fields, risk_result=gate[0],
                    rejection_reason=gate[0])
                return finish(403, ok=False, state="rejected", code=gate[0], message=gate[1])

            # ---- 8. broker snapshot + risk --------------------------------
            price: PriceInfo | None = None
            try:
                account = ctx.broker.get_account()
                position = ctx.broker.get_position(intent.symbol)
                positions = ctx.broker.get_positions()
                needs_price = intent.action == "buy" or (
                    intent.action == "sell" and (position is None or float(position.get("qty", 0)) <= 0)
                )
                if needs_price:
                    try:
                        price = ctx.broker.latest_price(intent.symbol)
                    except BrokerError:
                        price = None
            except BrokerError as exc:
                log("BROKER", "error", f"Pre-trade check failed — {exc.message}", **fields, error_detail=exc.code,
                    rejection_reason=exc.code)
                return finish(exc.http_status, ok=False, state="error", code=exc.code,
                              message=f"{exc.message}; no PAPER order submitted")

            result = evaluate(intent, s, account=account, position=position, positions=positions, price=price)
            db.add(RiskDecision(
                alert_fk=alert.id, approved=result.approved, code=result.code, reason=result.reason, side=result.side,
                final_qty=result.final_qty,
                reference_price=result.reference_price.price if result.reference_price else None,
                reference_price_time=result.reference_price.timestamp if result.reference_price else None,
                estimated_notional=result.estimated_notional, checks_json=json.dumps(result.checks),
            ))
            db.commit()
            if not result.approved:
                log("RISK", "error", f"{intent.action.upper()} rejected — {result.reason}", **fields,
                    validation_result="passed", risk_result=result.code, rejection_reason=result.reason)
                return finish(422, ok=False, state="rejected", code=result.code, message=result.reason)
            log("RISK", "decision", f"{intent.action.upper()} accepted", **fields, validation_result="passed",
                risk_result="APPROVED")
            alert.accepted_qty = result.final_qty
            db.commit()

            market_open: bool | None = None
            next_open = None
            try:
                clock = ctx.broker.get_clock()
                market_open = bool(clock.get("is_open"))
                next_open = clock.get("next_open")
            except BrokerError:
                market_open = None

            # ---- 9. submit -------------------------------------------------
            assert result.side and result.final_qty is not None
            outcome = submit_paper_order(
                ctx, db, alert=alert, symbol=intent.symbol, side=result.side, qty=result.final_qty,
                client_order_id=client_order_id_for_alert(alert_id), source="webhook",
                order_type=intent.order_type, time_in_force=intent.time_in_force, market_open=market_open,
            )
            order = outcome.order
            if order.filled_qty and order.filled_qty > 0:
                rebuild_trades(db)

        order_data = {
            "alpaca_order_id": order.alpaca_order_id,
            "client_order_id": order.client_order_id,
            "order_status": order.status,
            "side": order.side,
            "qty": str(order.qty),
            "filled_qty": str(order.filled_qty),
            "filled_avg_price": str(order.filled_avg_price) if order.filled_avg_price is not None else None,
            "market_open": market_open,
        }
        if not outcome.ok:
            return finish(outcome.http_status, ok=False, state="error" if outcome.http_status >= 500 else "rejected",
                          code=outcome.code, message=outcome.message, data_out=order_data)
        message = f"PAPER order {order.status}"
        if market_open is False and order.status in QUEUED_STATUSES:
            message = f"Market closed: Alpaca PAPER accepted the order ({order.status}); it is queued, not filled"
            if next_open:
                message += f". Next open {next_open}"
            log("BROKER", "decision", "Market closed — PAPER order queued by Alpaca", **fields,
                alpaca_order_id=order.alpaca_order_id, alpaca_status=order.status)
        return finish(200, ok=True, state="accepted", code="ACCEPTED", message=message, data_out=order_data)

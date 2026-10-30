from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from conftest import WEBHOOK_SECRET, FakeBroker, Harness

from alpha_terminal.broker import BrokerRejected, BrokerTimeout, BrokerUnavailable
from alpha_terminal.models import ActivityEvent, Alert, Order


def _db(h: Harness):
    return h.app.state.ctx.database.session()


# ------------------------------------------------------------------ happy paths
def test_valid_buy_submits_paper_order(running: Harness) -> None:
    r = running.alert(id="buy-1", action="BUY", qty=2)
    body = r.json()
    assert r.status_code == 200, body
    assert body["ok"] and body["status"] == "accepted" and body["code"] == "ACCEPTED"
    assert body["data"]["order_status"] == "filled"
    call = running.broker.submit_calls[0]
    assert call["side"] == "buy" and call["qty"] == Decimal("2") and call["type"] == "market"
    assert call["client_order_id"].startswith("at-")
    with _db(running) as db:
        alert = db.query(Alert).filter_by(alert_id="buy-1").one()
        assert alert.status == "accepted" and alert.accepted_qty == Decimal("2")
        assert db.query(Order).one().alpaca_order_id == "order-1"


def test_valid_sell_reduces_long(running: Harness) -> None:
    running.broker.set_position("SPY", "5")
    r = running.alert(action="sell", qty=3)
    assert r.status_code == 200, r.json()
    assert running.broker.submit_calls[-1]["side"] == "sell"
    assert running.broker.positions["SPY"]["qty"] == "2"


def test_valid_close_sells_entire_available_position(running: Harness) -> None:
    running.broker.set_position("SPY", "4")
    r = running.alert(action="close", qty=None)
    assert r.status_code == 200, r.json()
    call = running.broker.submit_calls[-1]
    assert call["side"] == "sell" and call["qty"] == Decimal("4")
    assert "SPY" not in running.broker.positions


# ------------------------------------------------------------------ authentication / parsing
def test_invalid_secret_rejected_and_not_persisted(running: Harness) -> None:
    r = running.alert(secret="wrong", id="bad-secret")
    assert r.status_code == 401 and r.json()["code"] == "UNAUTHORIZED"
    with _db(running) as db:
        assert db.query(Alert).filter_by(alert_id="bad-secret").count() == 0
    assert running.broker.submit_calls == []


def test_missing_secret_rejected(running: Harness, drop: object) -> None:
    assert running.alert(secret=drop).status_code == 401


def test_malformed_json(running: Harness) -> None:
    r = running.c.post("/webhook", content=b"{not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 400 and r.json()["code"] == "INVALID_JSON"
    r = running.c.post("/webhook", content=b"[1,2]")
    assert r.status_code == 400 and r.json()["code"] == "INVALID_JSON"


def test_missing_fields(running: Harness, drop: object) -> None:
    assert running.alert(id=drop).json()["code"] == "MISSING_FIELD"
    assert running.alert(symbol=drop).json()["code"] == "MISSING_FIELD"
    assert running.alert(action=drop).json()["code"] == "MISSING_FIELD"
    r = running.alert(qty=drop)
    assert r.status_code == 400 and r.json()["code"] == "MISSING_FIELD"
    assert running.broker.submit_calls == []


def test_unsupported_action(running: Harness) -> None:
    r = running.alert(action="short")
    assert r.status_code == 400 and r.json()["code"] == "INVALID_ACTION"


def test_action_casing_normalized(running: Harness) -> None:
    assert running.alert(action="  Buy ").status_code == 200


def test_unsupported_symbol(running: Harness) -> None:
    r = running.alert(symbol="TSLA")
    assert r.status_code == 400 and r.json()["code"] == "INVALID_SYMBOL"
    r = running.alert(symbol="SPY; DROP TABLE")
    assert r.status_code == 400 and r.json()["code"] == "INVALID_SYMBOL"


def test_exchange_prefixed_symbol_accepted(running: Harness) -> None:
    assert running.alert(symbol="AMEX:SPY").status_code == 200


def test_quantity_above_max(running: Harness) -> None:
    r = running.alert(qty=11)
    assert r.status_code == 422 and r.json()["code"] == "MAX_ORDER_QTY"
    assert running.broker.submit_calls == []


def test_zero_and_negative_and_bad_quantity(running: Harness) -> None:
    for bad in (0, -1, "-5", "abc", True, "NaN", 1.5):
        r = running.alert(qty=bad)
        assert r.status_code == 400 and r.json()["code"] == "INVALID_QUANTITY", (bad, r.json())
    assert running.broker.submit_calls == []


def test_unsupported_order_type_is_not_converted(running: Harness) -> None:
    r = running.alert(order_type="limit")
    assert r.status_code == 400 and r.json()["code"] == "UNSUPPORTED_ORDER_TYPE"
    assert running.broker.submit_calls == []


# ------------------------------------------------------------------ duplicates
def test_duplicate_alert_blocked(running: Harness) -> None:
    assert running.alert(id="dup-1").status_code == 200
    r = running.alert(id="dup-1")
    assert r.status_code == 200 and r.json()["status"] == "duplicate" and r.json()["code"] == "DUPLICATE"
    assert len(running.broker.submit_calls) == 1
    with _db(running) as db:
        assert db.query(Alert).filter_by(alert_id="dup-1").one().duplicate_count == 1
        assert db.query(ActivityEvent).filter(ActivityEvent.message == "Duplicate alert blocked").count() == 1


def test_duplicate_after_restart(running: Harness) -> None:
    assert running.alert(id="restart-1").status_code == 200
    broker = running.broker
    running.start(broker=broker)  # brand-new app object, same database file
    assert running.engine("start").status_code == 200
    r = running.alert(id="restart-1")
    assert r.json()["status"] == "duplicate"
    assert len(broker.submit_calls) == 1


def test_rejected_alert_id_is_also_burned(running: Harness) -> None:
    running.alert(id="rej-1", symbol="TSLA")
    assert running.alert(id="rej-1").json()["status"] == "duplicate"


def test_alpaca_client_order_id_is_deterministic(running: Harness) -> None:
    from alpha_terminal.orders import client_order_id_for_alert

    running.alert(id="coid-1")
    assert running.broker.submit_calls[0]["client_order_id"] == client_order_id_for_alert("coid-1")


# ------------------------------------------------------------------ engine state
def test_engine_starts_stopped_and_blocks_orders(h: Harness) -> None:
    assert h.c.get("/api/engine", headers=h.admin_headers()).json()["engine"]["state"] == "STOPPED"
    r = h.alert()
    assert r.status_code == 403 and r.json()["code"] == "ENGINE_STOPPED"
    assert h.broker.submit_calls == []


def test_engine_boots_stopped_even_if_running_before(running: Harness) -> None:
    running.start(broker=running.broker)
    r = running.alert()
    assert r.status_code == 403 and r.json()["code"] == "ENGINE_STOPPED"


def test_engine_paused_blocks_orders(running: Harness) -> None:
    assert running.engine("pause").json()["data"]["state"] == "PAUSED"
    r = running.alert()
    assert r.status_code == 403 and r.json()["code"] == "ENGINE_PAUSED"
    assert running.engine("resume").json()["data"]["state"] == "RUNNING"
    assert running.alert().status_code == 200


def test_invalid_transitions(h: Harness) -> None:
    assert h.engine("pause").status_code == 409
    assert h.engine("resume").status_code == 409
    assert h.engine("start").status_code == 200
    assert h.engine("start").status_code == 409
    assert h.engine("stop").json()["data"]["state"] == "STOPPED"


def test_enable_trading_false_refuses_start(h: Harness) -> None:
    h.start(enable_trading=False)
    r = h.engine("start")
    assert r.status_code == 409 and r.json()["code"] == "EXECUTION_DISABLED"


# ------------------------------------------------------------------ position safety
def test_sell_with_no_position(running: Harness) -> None:
    r = running.alert(action="sell", qty=1)
    assert r.status_code == 422 and r.json()["code"] == "NO_POSITION"
    assert running.broker.submit_calls == []


def test_sell_quantity_above_position(running: Harness) -> None:
    running.broker.set_position("SPY", "2")
    r = running.alert(action="sell", qty=3)
    assert r.status_code == 422 and r.json()["code"] == "SELL_EXCEEDS_POSITION"
    assert running.broker.submit_calls == []


def test_sell_above_available_shares(running: Harness) -> None:
    running.broker.set_position("SPY", "5", available="1")
    r = running.alert(action="sell", qty=2)
    assert r.status_code == 422 and r.json()["code"] == "SELL_EXCEEDS_AVAILABLE"


def test_short_prevention(running: Harness) -> None:
    # Flat: SELL must never open a short.
    running.alert(action="sell", qty=1)
    # Existing short (e.g. created outside the app): SELL would grow it, BUY would cover/reverse.
    running.broker.set_position("SPY", "-3")
    r = running.alert(action="sell", qty=1)
    assert r.status_code == 422 and r.json()["code"] == "SHORT_DISABLED"
    r = running.alert(action="buy", qty=1)
    assert r.status_code == 422 and r.json()["code"] == "SHORT_POSITION_PRESENT"
    assert running.broker.submit_calls == []


def test_close_with_no_position(running: Harness) -> None:
    r = running.alert(action="close")
    assert r.status_code == 422 and r.json()["code"] == "NO_POSITION"
    assert running.broker.submit_calls == []


# ------------------------------------------------------------------ risk limits
def test_notional_and_exposure_limits(running: Harness) -> None:
    running.broker.price = Decimal("600")
    r = running.alert(qty=9)  # 5400 > 5000
    assert r.json()["code"] == "MAX_ORDER_NOTIONAL"
    running.broker.price = Decimal("100")
    running.broker.set_position("SPY", "95")  # 9500 + 1000 > 10000
    assert running.alert(qty=10).json()["code"] == "MAX_POSITION_EXPOSURE"


def test_buying_power_and_daily_loss(running: Harness) -> None:
    running.broker.account["buying_power"] = "50"
    assert running.alert(qty=1).json()["code"] == "INSUFFICIENT_BUYING_POWER"
    running.broker.account["buying_power"] = "200000"
    running.broker.account["equity"] = "97000"  # -3000 today
    assert running.alert(qty=1).json()["code"] == "DAILY_LOSS_LIMIT"


def test_max_open_positions(running: Harness) -> None:
    running.start(broker=running.broker, max_open_positions=1)
    running.engine("start")
    running.broker.set_position("QQQ", "1")
    assert running.alert(symbol="SPY").json()["code"] == "MAX_OPEN_POSITIONS"


def test_account_restricted(running: Harness) -> None:
    running.broker.account["trading_blocked"] = True
    assert running.alert().json()["code"] == "ACCOUNT_RESTRICTED"


# ------------------------------------------------------------------ kill switch
def test_kill_switch(running: Harness) -> None:
    running.broker.set_position("SPY", "3")
    r = running.c.post("/kill", headers=running.admin_headers())
    assert r.status_code == 200 and r.json()["data"]["kill_switch"] is True
    r = running.alert(action="buy")
    assert r.status_code == 403 and r.json()["code"] == "KILL_SWITCH_ACTIVE"
    assert running.engine("start").json()["code"] == "KILL_SWITCH_ACTIVE"
    assert running.broker.positions["SPY"]["qty"] == "3"  # positions untouched
    assert running.broker.submit_calls == []
    r = running.c.post("/kill/reset", headers=running.admin_headers())
    assert r.json()["data"]["state"] == "STOPPED" and r.json()["data"]["kill_switch"] is False


def test_kill_requires_auth(running: Harness) -> None:
    assert running.c.post("/kill").status_code == 401
    assert running.c.post("/kill", headers={"Authorization": "Bearer nope"}).status_code == 401


# ------------------------------------------------------------------ broker failures (fake broker)
def test_alpaca_rejection(running: Harness) -> None:
    running.broker.submit_error = BrokerRejected("insufficient buying power", status_code=403)
    r = running.alert()
    assert r.status_code == 422 and r.json()["code"] == "BROKER_REJECTED"
    with _db(running) as db:
        assert db.query(Order).one().status == "broker_rejected"
        assert db.query(Alert).one().status == "rejected"


def test_alpaca_unavailable_before_submit(running: Harness) -> None:
    running.broker.account_error = BrokerUnavailable("Could not reach Alpaca PAPER")
    r = running.alert()
    assert r.status_code == 502 and r.json()["code"] == "BROKER_UNAVAILABLE"
    assert running.broker.submit_calls == []


def test_alpaca_timeout_marks_unknown_and_reconciles(running: Harness) -> None:
    running.broker.submit_error = BrokerTimeout("Alpaca PAPER did not answer in time", maybe_submitted=True)
    r = running.alert(id="to-1")
    assert r.status_code == 504 and r.json()["code"] == "BROKER_TIMEOUT"
    with _db(running) as db:
        assert db.query(Order).one().status == "unknown"
    # Later the order turns out to exist at Alpaca: the sync job adopts it, no resubmission.
    from alpha_terminal.orders import client_order_id_for_alert, sync_orders

    running.broker.orders["order-x"] = {
        "id": "order-x", "client_order_id": client_order_id_for_alert("to-1"), "status": "filled",
        "filled_qty": "1", "filled_avg_price": "100", "filled_at": datetime.now(UTC).isoformat(),
    }
    assert sync_orders(running.app.state.ctx) == 1
    with _db(running) as db:
        o = db.query(Order).one()
        assert o.status == "filled" and o.alpaca_order_id == "order-x"
    assert len(running.broker.submit_calls) == 1


def test_market_closed_order_is_queued_not_filled(running: Harness) -> None:
    running.broker.market_open = False
    r = running.alert()
    body = r.json()
    assert r.status_code == 200 and body["data"]["order_status"] == "accepted"
    assert "Market closed" in body["message"] and body["data"]["market_open"] is False
    assert body["data"]["filled_qty"] == "0"
    trades = running.c.get("/api/trades", headers=running.admin_headers()).json()["trades"]
    assert trades == []  # nothing filled, so no trade exists


def test_stale_price_still_recorded(running: Harness) -> None:
    running.broker.price_time = datetime.now(UTC) - timedelta(days=2)
    assert running.alert().status_code == 200


# ------------------------------------------------------------------ persistence / logging hygiene
def test_database_persistence_and_no_secret_stored(running: Harness) -> None:
    running.alert(id="persist-1")
    running.alert(id="persist-2", symbol="TSLA")
    running.start(broker=running.broker)
    with _db(running) as db:
        rows = {a.alert_id: a for a in db.query(Alert).all()}
        assert rows["persist-1"].status == "accepted" and rows["persist-2"].status == "rejected"
        assert WEBHOOK_SECRET not in (rows["persist-1"].payload_json or "")
        for e in db.query(ActivityEvent).all():
            for col in ("message", "rejection_reason", "error_detail"):
                assert WEBHOOK_SECRET not in (getattr(e, col) or "")


def test_rate_limit(h: Harness) -> None:
    h.start(webhook_rate_limit_per_minute=3)
    codes = [h.alert().status_code for _ in range(5)]
    assert codes[:3] == [403, 403, 403] and codes[3:] == [429, 429]


def test_payload_too_large(running: Harness) -> None:
    r = running.alert(strategy="x" * 20000)
    assert r.status_code == 413


def test_broker_not_configured(h: Harness) -> None:
    broker = FakeBroker()
    broker.configured = False
    h.start(broker=broker)
    h.engine("start")
    assert h.alert().json()["code"] == "BROKER_NOT_CONFIGURED"

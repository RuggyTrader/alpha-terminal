from __future__ import annotations

import json
from decimal import Decimal

import httpx
import pytest
from conftest import ADMIN_SECRET, ALPACA_KEY, ALPACA_SECRET, WEBHOOK_SECRET, FakeBroker, Harness

from alpha_terminal.broker import (
    AlpacaPaperBroker,
    BrokerRejected,
    BrokerTimeout,
    BrokerUnavailable,
)
from alpha_terminal.config import PAPER_TRADING_BASE_URL, ConfigError, load_settings
from alpha_terminal.ledger import build_trades
from alpha_terminal.models import Order

SECRETS = (WEBHOOK_SECRET, ADMIN_SECRET, ALPACA_KEY, ALPACA_SECRET)
CSRF = {"X-Alpha-Terminal": "1"}


def login(h: Harness) -> None:
    r = h.c.post("/auth/login", json={"password": ADMIN_SECRET}, headers=CSRF)
    assert r.status_code == 200, r.json()


# ------------------------------------------------------------------ auth protection
PRIVATE_GET = ["/api/summary", "/api/positions", "/api/trades", "/api/trades/1", "/api/alerts", "/api/alerts/1",
               "/api/activity", "/api/engine", "/api/settings", "/api/system/health", "/auth/session"]
PRIVATE_POST = ["/engine/start", "/engine/pause", "/engine/resume", "/engine/stop", "/kill", "/kill/reset",
                "/api/orders/sync", "/api/positions/SPY/close", "/api/positions/close-all", "/api/orders/cancel-open"]


def test_every_private_route_requires_auth(h: Harness) -> None:
    for path in PRIVATE_GET:
        assert h.c.get(path).status_code == 401, path
    for path in PRIVATE_POST:
        assert h.c.post(path, json={}).status_code == 401, path


def test_all_registered_routes_are_classified(h: Harness) -> None:
    public = {"/webhook", "/health", "/", "/auth/login", "/auth/logout"}
    paths = {getattr(r, "path", "") for r in h.app.routes}
    known = public | {p.replace("/1", "/{trade_id}") for p in PRIVATE_GET} | set(PRIVATE_POST)
    known |= {"/api/alerts/{record_id}", "/api/positions/{symbol}/close"}
    unknown = {p for p in paths if p and p not in known and not p.startswith(("/docs", "/openapi", "/redoc"))}
    assert unknown == set(), f"unclassified routes: {unknown}"


def test_login_session_cookie_and_csrf(h: Harness) -> None:
    assert h.c.post("/auth/login", json={"password": "wrong"}, headers=CSRF).status_code == 401
    assert h.c.post("/auth/login", json={"password": ADMIN_SECRET}).status_code == 403  # no CSRF header
    r = h.c.post("/auth/login", json={"password": ADMIN_SECRET}, headers=CSRF)
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    assert ADMIN_SECRET not in r.text
    assert h.c.get("/api/summary").status_code == 200
    # Cookie-authenticated POST without the CSRF header is refused
    assert h.c.post("/engine/start").status_code == 403
    assert h.c.post("/engine/start", headers={**CSRF, "Origin": "https://evil.example"}).status_code == 403
    r = h.c.post("/engine/start", headers={**CSRF, "Origin": "https://terminal.example.test"})
    assert r.status_code == 200
    h.c.post("/auth/logout")
    assert h.c.get("/api/summary").status_code == 401


def test_login_rate_limited(h: Harness) -> None:
    h.start(login_rate_limit_per_minute=2)
    codes = [h.c.post("/auth/login", json={"password": "x"}, headers=CSRF).status_code for _ in range(3)]
    assert codes == [401, 401, 429]


def test_login_disabled_without_admin_secret(h: Harness) -> None:
    h.start(admin_secret="")
    assert h.c.post("/auth/login", json={"password": ""}, headers=CSRF).status_code == 503
    assert h.c.get("/api/summary", headers={"Authorization": "Bearer "}).status_code == 401


# ------------------------------------------------------------------ health
def test_health_endpoint_is_safe(h: Harness) -> None:
    r = h.c.get("/health")
    body = r.json()
    assert r.status_code == 200
    for key in ("server", "engine_state", "database", "alpaca_paper", "last_webhook_at", "last_accepted_alert_at",
                "last_successful_order_at", "system_health"):
        assert key in body
    assert body["engine_state"] == "STOPPED" and body["paper_only"] is True and body["database"] == "HEALTHY"
    for s in SECRETS:
        assert s not in r.text


def test_health_reports_failures_honestly(h: Harness) -> None:
    broker = FakeBroker()
    broker.account_error = BrokerUnavailable("down")
    h.start(broker=broker, webhook_secret="")
    body = h.c.get("/health").json()
    assert body["alpaca_paper"] == "OFFLINE"
    assert body["components"]["webhook"] == "NOT CONFIGURED"
    assert body["system_health"] == "DEGRADED"


def test_settings_never_return_secrets(h: Harness) -> None:
    r = h.c.get("/api/settings", headers=h.admin_headers())
    assert r.status_code == 200
    for s in SECRETS:
        assert s not in r.text
    assert r.json()["markets"]["crypto"]["status"] == "NOT CONFIGURED"
    assert r.json()["broker"]["trading_host"] == "paper-api.alpaca.markets"


# ------------------------------------------------------------------ summary / data integrity
def test_summary_shows_na_when_broker_not_configured(h: Harness) -> None:
    broker = FakeBroker()
    broker.configured = False
    h.start(broker=broker)
    body = h.c.get("/api/summary", headers=h.admin_headers()).json()
    assert body["account"]["available"] is False
    assert body["unrealized_pnl"] is None and body["total_pnl"] is None and body["win_rate_pct"] is None
    assert body["markets"]["stocks"]["status"] == "NOT CONFIGURED"


def test_summary_and_trades_after_round_trip(running: Harness) -> None:
    running.alert(id="rt-buy", qty=2)
    running.broker.price = Decimal("110")
    running.alert(id="rt-sell", action="sell", qty=2)
    body = running.c.get("/api/summary", headers=running.admin_headers()).json()
    assert body["realized_pnl"] == "20.00"
    assert body["closed_trades"] == 1 and body["win_rate_pct"] == "100.00"
    assert body["closed_trade_return_pct"] == "10.00"
    assert body["account"]["verified_pnl"] == "0.00"  # fake account equity did not move
    trades = running.c.get("/api/trades", headers=running.admin_headers()).json()["trades"]
    assert len(trades) == 1 and trades[0]["status"] == "CLOSED" and trades[0]["badge"] == "VERIFIED PAPER"
    detail = running.c.get(f"/api/trades/{trades[0]['id']}", headers=running.admin_headers()).json()
    assert [leg["alert"]["alert_id"] for leg in detail["legs"]] == ["rt-buy", "rt-sell"]
    assert detail["legs"][0]["alert"]["risk_decisions"][0]["approved"] is True
    for s in SECRETS:
        assert s not in json.dumps(detail)


def test_positions_mark_unavailable_market_data(running: Harness) -> None:
    from alpha_terminal.broker import BrokerError

    running.broker.set_position("SPY", "1")

    def boom(symbol: str):
        raise BrokerError("no data")

    running.broker.latest_price = boom  # type: ignore[method-assign]
    pos = running.c.get("/api/positions", headers=running.admin_headers()).json()["positions"][0]
    assert pos["current"]["status"] == "UNAVAILABLE" and pos["current"]["price"] is None


def test_activity_feed_is_real_events_only(h: Harness) -> None:
    events = h.c.get("/api/activity", headers=h.admin_headers()).json()["events"]
    assert [e["category"] for e in events] == ["SYSTEM"]  # only the startup event exists


def test_close_position_requires_confirmation(running: Harness) -> None:
    running.broker.set_position("SPY", "2")
    assert running.c.post("/api/positions/SPY/close", json={}, headers=running.admin_headers()).status_code == 400
    r = running.c.post("/api/positions/SPY/close", json={"confirm": "SPY"}, headers=running.admin_headers())
    assert r.json()["ok"] is True and "SPY" not in running.broker.positions


# ------------------------------------------------------------------ ledger maths
def _order(i: int, side: str, qty: str, price: str) -> Order:
    from datetime import UTC, datetime, timedelta

    t = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=i)
    return Order(id=i, symbol="SPY", side=side, qty=Decimal(qty), filled_qty=Decimal(qty), filled_avg_price=Decimal(price),
                 filled_at=t, submitted_at=t, client_order_id=f"c{i}", alpaca_order_id=f"o{i}", source="webhook", status="filled")


def test_ledger_fifo_partial_exits_no_double_count() -> None:
    trades = build_trades([_order(1, "buy", "2", "100"), _order(2, "buy", "2", "110"), _order(3, "sell", "3", "120"),
                           _order(4, "sell", "1", "90")])
    assert len(trades) == 1
    t = trades[0]
    # FIFO: 2@100 -> +40, 1@110 -> +10, then 1@110 sold at 90 -> -20
    assert t.realized_pnl == Decimal("30.00") and t.status == "closed"
    assert t.entry_avg_price == Decimal("105.000000") and t.exit_qty == Decimal("4")
    assert t.closed_cost_basis == Decimal("420")


def test_ledger_open_trade_not_counted_as_closed() -> None:
    trades = build_trades([_order(1, "buy", "3", "100"), _order(2, "sell", "1", "110")])
    assert trades[0].status == "open" and trades[0].open_qty == Decimal("2") and trades[0].realized_pnl == Decimal("10.00")


# ------------------------------------------------------------------ real client against a mock transport
def _client(handler) -> AlpacaPaperBroker:  # type: ignore[no-untyped-def]
    return AlpacaPaperBroker("k", "s", transport=httpx.MockTransport(handler))


def test_broker_only_targets_paper_host() -> None:
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.url.host)
        assert req.headers["APCA-API-KEY-ID"] == "k"
        return httpx.Response(200, json={"id": "x", "status": "ACTIVE"})

    _client(handler).get_account()
    assert seen == ["paper-api.alpaca.markets"]
    assert PAPER_TRADING_BASE_URL == "https://paper-api.alpaca.markets"


def test_broker_timeout_is_flagged_maybe_submitted() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=req)

    with pytest.raises(BrokerTimeout) as exc:
        _client(handler).submit_order(symbol="SPY", qty=Decimal(1), side="buy", order_type="market",
                                      time_in_force="day", client_order_id="c")
    assert exc.value.maybe_submitted is True


def test_broker_unavailable_and_5xx() -> None:
    def refused(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    with pytest.raises(BrokerUnavailable) as exc:
        _client(refused).submit_order(symbol="SPY", qty=Decimal(1), side="buy", order_type="market",
                                      time_in_force="day", client_order_id="c")
    assert exc.value.maybe_submitted is False
    with pytest.raises(BrokerUnavailable) as exc2:
        _client(lambda r: httpx.Response(503)).submit_order(symbol="SPY", qty=Decimal(1), side="buy",
                                                            order_type="market", time_in_force="day", client_order_id="c")
    assert exc2.value.maybe_submitted is True


def test_broker_rejection_message() -> None:
    handler = lambda r: httpx.Response(403, json={"code": 40310000, "message": "insufficient buying power"})  # noqa: E731
    with pytest.raises(BrokerRejected) as exc:
        _client(handler).submit_order(symbol="SPY", qty=Decimal(1), side="buy", order_type="market",
                                      time_in_force="day", client_order_id="c")
    assert exc.value.message == "insufficient buying power" and exc.value.status_code == 403


def test_broker_position_404_means_none() -> None:
    assert _client(lambda r: httpx.Response(404, json={"message": "position does not exist"})).get_position("SPY") is None


def test_webhook_timeout_end_to_end_with_real_client(h: Harness) -> None:
    """Real AlpacaPaperBroker + mock transport: submit times out, lookup finds nothing -> UNKNOWN, 504."""

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/v2/account":
            return httpx.Response(200, json={"id": "a", "status": "ACTIVE", "equity": "1000", "last_equity": "1000",
                                             "buying_power": "100000"})
        if p.startswith("/v2/positions/"):
            return httpx.Response(404, json={"message": "position does not exist"})
        if p == "/v2/positions":
            return httpx.Response(200, json=[])
        if "trades/latest" in p:
            return httpx.Response(200, json={"trade": {"t": "2026-10-29T15:00:00.123456789Z", "p": 100.5}})
        if p == "/v2/clock":
            return httpx.Response(200, json={"is_open": True})
        if p == "/v2/orders" and req.method == "POST":
            raise httpx.ReadTimeout("slow", request=req)
        if p == "/v2/orders:by_client_order_id":
            return httpx.Response(404, json={"message": "order not found"})
        raise AssertionError(f"unexpected {req.method} {req.url}")

    h.start(broker=_client(handler))
    h.engine("start")
    r = h.alert(id="real-timeout")
    assert r.status_code == 504 and r.json()["code"] == "BROKER_TIMEOUT"
    assert r.json()["data"]["order_status"] == "unknown"


# ------------------------------------------------------------------ config guard
def test_config_refuses_non_paper_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APCA_API_BASE_URL", "https://example.invalid")
    with pytest.raises(ConfigError):
        load_settings()


def test_config_defaults_are_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in ("ENABLE_TRADING", "SHORT_SELLING_ENABLED", "APCA_API_BASE_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None, raising=False)
    s = load_settings()
    assert s.enable_trading is False and s.short_selling_enabled is False

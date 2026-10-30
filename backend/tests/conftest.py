"""Test fixtures. No test ever contacts Alpaca: the broker is a fake or an
httpx.MockTransport."""

from __future__ import annotations

import itertools
from collections.abc import Callable, Iterator
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from alpha_terminal.broker import BrokerError, PriceInfo
from alpha_terminal.config import Settings
from alpha_terminal.main import create_app

WEBHOOK_SECRET = "test-webhook-secret-123456"
ADMIN_SECRET = "test-admin-secret-abcdef"
ALPACA_KEY = "PKTESTKEY000000000000"
ALPACA_SECRET = "testalpacasecret0000000000000000000000000"


class FakeBroker:
    """In-memory stand-in for Alpaca PAPER."""

    configured = True

    def __init__(self) -> None:
        self.account: dict[str, Any] = {
            "id": "acct-1", "account_number": "PA0000TEST", "status": "ACTIVE", "currency": "USD",
            "equity": "100000", "last_equity": "100000", "buying_power": "200000", "cash": "100000",
            "trading_blocked": False, "account_blocked": False, "shorting_enabled": True,
        }
        self.positions: dict[str, dict[str, Any]] = {}
        self.orders: dict[str, dict[str, Any]] = {}
        self.price = Decimal("100")
        self.price_time: datetime | None = None
        self.market_open = True
        self.submit_calls: list[dict[str, Any]] = []
        self.submit_error: BrokerError | None = None
        self.account_error: BrokerError | None = None
        self._ids = itertools.count(1)

    # helpers
    def set_position(self, symbol: str, qty: str, avg: str = "100", available: str | None = None) -> None:
        q = Decimal(qty)
        self.positions[symbol] = {
            "symbol": symbol, "qty": qty, "qty_available": available if available is not None else qty,
            "avg_entry_price": avg, "side": "long" if q > 0 else "short", "asset_class": "us_equity",
            "market_value": str(q * self.price), "cost_basis": str(q * Decimal(avg)),
            "unrealized_pl": str((self.price - Decimal(avg)) * q), "unrealized_plpc": "0",
            "current_price": str(self.price),
        }

    # Broker protocol
    def get_account(self) -> dict[str, Any]:
        if self.account_error:
            raise self.account_error
        return dict(self.account)

    def get_clock(self) -> dict[str, Any]:
        return {"is_open": self.market_open, "next_open": "2026-11-02T09:30:00-05:00"}

    def get_positions(self) -> list[dict[str, Any]]:
        if self.account_error:
            raise self.account_error
        return [dict(p) for p in self.positions.values()]

    def get_position(self, symbol: str) -> dict[str, Any] | None:
        if self.account_error:
            raise self.account_error
        p = self.positions.get(symbol)
        return dict(p) if p else None

    def get_order(self, alpaca_order_id: str) -> dict[str, Any]:
        return dict(self.orders[alpaca_order_id])

    def get_order_by_client_id(self, client_order_id: str) -> dict[str, Any] | None:
        for o in self.orders.values():
            if o["client_order_id"] == client_order_id:
                return dict(o)
        return None

    def list_open_orders(self) -> list[dict[str, Any]]:
        return [o for o in self.orders.values() if o["status"] not in ("filled", "canceled")]

    def submit_order(self, *, symbol: str, qty: Decimal, side: str, order_type: str, time_in_force: str,
                     client_order_id: str) -> dict[str, Any]:
        self.submit_calls.append({"symbol": symbol, "qty": qty, "side": side, "type": order_type,
                                  "client_order_id": client_order_id})
        if self.submit_error:
            raise self.submit_error
        oid = f"order-{next(self._ids)}"
        now = datetime.now(UTC).isoformat()
        filled = self.market_open
        order = {
            "id": oid, "client_order_id": client_order_id, "symbol": symbol, "qty": str(qty), "side": side,
            "type": order_type, "status": "filled" if filled else "accepted", "created_at": now,
            "filled_qty": str(qty) if filled else "0", "filled_avg_price": str(self.price) if filled else None,
            "filled_at": now if filled else None,
        }
        self.orders[oid] = order
        if filled:
            cur = Decimal(self.positions.get(symbol, {}).get("qty", "0"))
            new = cur + (qty if side == "buy" else -qty)
            if new == 0:
                self.positions.pop(symbol, None)
            else:
                self.set_position(symbol, str(new), str(self.price))
        return dict(order)

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        return []

    def latest_price(self, symbol: str) -> PriceInfo:
        return PriceInfo(symbol=symbol, price=self.price, timestamp=self.price_time or datetime.now(UTC))


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    base = Settings(
        alpaca_key=ALPACA_KEY, alpaca_secret=ALPACA_SECRET, webhook_secret=WEBHOOK_SECRET, admin_secret=ADMIN_SECRET,
        enable_trading=True, database_url=f"sqlite:///{(tmp_path / 'test.db').as_posix()}",
        frontend_origins=("https://terminal.example.test",), public_api_base_url="https://api.example.test",
        cookie_secure=True, background_sync=False, webhook_rate_limit_per_minute=1000, login_rate_limit_per_minute=1000,
    )
    return replace(base, **overrides)


class Harness:
    def __init__(self, tmp_path: Path) -> None:
        self.tmp_path = tmp_path
        self.broker = FakeBroker()
        self.client: TestClient | None = None
        self._cm: Any = None

    def start(self, broker: Any = None, **overrides: Any) -> TestClient:
        self.stop()
        app = create_app(make_settings(self.tmp_path, **overrides), broker or self.broker)
        self.app = app
        self._cm = TestClient(app, base_url="https://api.example.test")
        self.client = self._cm.__enter__()
        return self.client

    def stop(self) -> None:
        if self._cm is not None:
            self._cm.__exit__(None, None, None)
            self._cm = None

    @property
    def c(self) -> TestClient:
        assert self.client is not None
        return self.client

    def admin_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {ADMIN_SECRET}"}

    def engine(self, action: str) -> Any:
        return self.c.post(f"/engine/{action}", headers=self.admin_headers())

    def alert(self, **fields: Any) -> Any:
        payload = {"secret": WEBHOOK_SECRET, "id": f"alert-{next(_alert_ids)}", "symbol": "SPY", "action": "buy",
                   "qty": 1, "strategy": "OTE"}
        payload.update(fields)
        payload = {k: v for k, v in payload.items() if v is not _DROP}
        return self.c.post("/webhook", json=payload)


_DROP = object()
_alert_ids = itertools.count(1)


@pytest.fixture
def drop() -> object:
    return _DROP


@pytest.fixture
def h(tmp_path: Path) -> Iterator[Harness]:
    harness = Harness(tmp_path)
    harness.start()
    yield harness
    harness.stop()


@pytest.fixture
def running(h: Harness) -> Harness:
    assert h.engine("start").status_code == 200
    return h


TransportHandler = Callable[[Any], Any]

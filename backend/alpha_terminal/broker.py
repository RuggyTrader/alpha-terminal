"""Alpaca PAPER broker client.

Only the paper trading host is used. The host is a module constant and the
client asserts it at construction, so there is no code path to any other
Alpaca trading environment. Market data comes from Alpaca's data host, which
serves prices and cannot place orders.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Protocol
from urllib.parse import quote

import httpx

from .config import MARKET_DATA_BASE_URL, PAPER_TRADING_BASE_URL


class BrokerError(Exception):
    code = "BROKER_ERROR"
    http_status = 502

    def __init__(self, message: str, *, detail: str | None = None, maybe_submitted: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail
        # True when an order request may have reached Alpaca even though we got
        # no usable answer (timeout, 5xx). Such orders are reconciled by
        # client_order_id instead of being retried.
        self.maybe_submitted = maybe_submitted


class BrokerNotConfigured(BrokerError):
    code = "BROKER_NOT_CONFIGURED"
    http_status = 503


class BrokerTimeout(BrokerError):
    code = "BROKER_TIMEOUT"
    http_status = 504


class BrokerUnavailable(BrokerError):
    code = "BROKER_UNAVAILABLE"
    http_status = 502


class BrokerRejected(BrokerError):
    code = "BROKER_REJECTED"
    http_status = 422

    def __init__(self, message: str, *, status_code: int, alpaca_code: Any = None) -> None:
        super().__init__(message, detail=f"alpaca_http={status_code} alpaca_code={alpaca_code}")
        self.status_code = status_code
        self.alpaca_code = alpaca_code


class BrokerAuthFailed(BrokerError):
    code = "BROKER_AUTH_FAILED"
    http_status = 502


@dataclass(frozen=True)
class PriceInfo:
    symbol: str
    price: Decimal
    timestamp: datetime
    source: str = "alpaca_iex_latest_trade"

    def age_seconds(self, now: datetime | None = None) -> float:
        now = now or datetime.now(UTC)
        return (now - self.timestamp).total_seconds()


class Broker(Protocol):
    """Interface used by the app; tests provide a fake implementation."""

    configured: bool

    def get_account(self) -> dict[str, Any]: ...
    def get_clock(self) -> dict[str, Any]: ...
    def get_positions(self) -> list[dict[str, Any]]: ...
    def get_position(self, symbol: str) -> dict[str, Any] | None: ...
    def get_order(self, alpaca_order_id: str) -> dict[str, Any]: ...
    def get_order_by_client_id(self, client_order_id: str) -> dict[str, Any] | None: ...
    def list_open_orders(self) -> list[dict[str, Any]]: ...
    def submit_order(
        self, *, symbol: str, qty: Decimal, side: str, order_type: str, time_in_force: str, client_order_id: str
    ) -> dict[str, Any]: ...
    def cancel_all_orders(self) -> list[dict[str, Any]]: ...
    def latest_price(self, symbol: str) -> PriceInfo: ...


def parse_ts(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    # Alpaca sends nanosecond precision; Python accepts up to microseconds.
    if "." in text:
        head, _, tail = text.partition(".")
        digits = ""
        rest = ""
        for i, ch in enumerate(tail):
            if ch.isdigit():
                digits += ch
            else:
                rest = tail[i:]
                break
        text = f"{head}.{digits[:6].ljust(6, '0')}{rest}"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


class AlpacaPaperBroker:
    def __init__(
        self,
        key: str,
        secret: str,
        *,
        timeout: float = 2.5,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.base_url = PAPER_TRADING_BASE_URL
        assert self.base_url == "https://paper-api.alpaca.markets", "PAPER ONLY"
        self.data_url = MARKET_DATA_BASE_URL
        self.configured = bool(key and secret)
        headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, "Accept": "application/json"}
        self._client = httpx.Client(timeout=timeout, headers=headers, transport=transport)

    def close(self) -> None:
        self._client.close()

    # ---- low level -------------------------------------------------------
    def _request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        allow_404: bool = False,
        is_order_submit: bool = False,
    ) -> Any:
        if not self.configured:
            raise BrokerNotConfigured("Alpaca PAPER keys are not configured on the server")
        try:
            resp = self._client.request(method, url, params=params, json=json)
        except httpx.ConnectTimeout as exc:
            raise BrokerTimeout("Timed out connecting to Alpaca PAPER", detail=type(exc).__name__) from exc
        except httpx.TimeoutException as exc:
            raise BrokerTimeout(
                "Alpaca PAPER did not answer in time", detail=type(exc).__name__, maybe_submitted=is_order_submit
            ) from exc
        except httpx.TransportError as exc:
            raise BrokerUnavailable("Could not reach Alpaca PAPER", detail=type(exc).__name__) from exc

        if allow_404 and resp.status_code == 404:
            return None
        if resp.status_code in (401,):
            raise BrokerAuthFailed("Alpaca PAPER rejected the API keys", detail="alpaca_http=401")
        if resp.status_code == 429:
            raise BrokerUnavailable("Alpaca PAPER rate limit reached", detail="alpaca_http=429")
        if resp.status_code >= 500:
            raise BrokerUnavailable(
                "Alpaca PAPER returned a server error",
                detail=f"alpaca_http={resp.status_code}",
                maybe_submitted=is_order_submit,
            )
        if resp.status_code >= 400:
            message = "Alpaca PAPER rejected the request"
            alpaca_code = None
            try:
                body = resp.json()
                if isinstance(body, dict):
                    message = str(body.get("message") or message)[:500]
                    alpaca_code = body.get("code")
            except ValueError:
                pass
            raise BrokerRejected(message, status_code=resp.status_code, alpaca_code=alpaca_code)
        if resp.status_code == 204 or not resp.content:
            return None
        try:
            return resp.json()
        except ValueError as exc:
            raise BrokerUnavailable("Alpaca PAPER returned invalid JSON", maybe_submitted=is_order_submit) from exc

    def _trading(self, method: str, path: str, **kw: Any) -> Any:
        return self._request(method, self.base_url + path, **kw)

    # ---- trading API -----------------------------------------------------
    def get_account(self) -> dict[str, Any]:
        return dict(self._trading("GET", "/v2/account"))

    def get_clock(self) -> dict[str, Any]:
        return dict(self._trading("GET", "/v2/clock"))

    def get_positions(self) -> list[dict[str, Any]]:
        return list(self._trading("GET", "/v2/positions") or [])

    def get_position(self, symbol: str) -> dict[str, Any] | None:
        result = self._trading("GET", f"/v2/positions/{quote(symbol, safe='')}", allow_404=True)
        return dict(result) if result else None

    def get_order(self, alpaca_order_id: str) -> dict[str, Any]:
        return dict(self._trading("GET", f"/v2/orders/{quote(alpaca_order_id, safe='')}"))

    def get_order_by_client_id(self, client_order_id: str) -> dict[str, Any] | None:
        result = self._trading(
            "GET", "/v2/orders:by_client_order_id", params={"client_order_id": client_order_id}, allow_404=True
        )
        return dict(result) if result else None

    def list_open_orders(self) -> list[dict[str, Any]]:
        return list(self._trading("GET", "/v2/orders", params={"status": "open", "limit": 500}) or [])

    def submit_order(
        self, *, symbol: str, qty: Decimal, side: str, order_type: str, time_in_force: str, client_order_id: str
    ) -> dict[str, Any]:
        body = {
            "symbol": symbol,
            "qty": format(qty, "f"),
            "side": side,
            "type": order_type,
            "time_in_force": time_in_force,
            "client_order_id": client_order_id,
        }
        return dict(self._trading("POST", "/v2/orders", json=body, is_order_submit=True))

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        return list(self._trading("DELETE", "/v2/orders") or [])

    # ---- market data -------------------------------------------------------
    def latest_price(self, symbol: str) -> PriceInfo:
        body = self._request(
            "GET", f"{self.data_url}/v2/stocks/{quote(symbol, safe='')}/trades/latest", params={"feed": "iex"}
        )
        trade = (body or {}).get("trade") or {}
        ts = parse_ts(trade.get("t"))
        price = trade.get("p")
        if ts is None or price is None:
            raise BrokerUnavailable("Market data response had no latest trade")
        return PriceInfo(symbol=symbol, price=Decimal(str(price)), timestamp=ts)

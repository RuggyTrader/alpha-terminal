"""Server-side configuration for ALPHA TERMINAL.

Every value comes from environment variables. Secrets are never sent to the
frontend; only "is it configured?" booleans are exposed by the API.

PAPER ONLY: the Alpaca trading host is a hard-coded constant. There is no
environment variable that can point the broker client anywhere else.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

# The only Alpaca trading host this application will ever talk to.
PAPER_TRADING_BASE_URL = "https://paper-api.alpaca.markets"
# Alpaca market-data host (quotes/trades only; it cannot place orders).
MARKET_DATA_BASE_URL = "https://data.alpaca.markets"

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent

# Environment variables some Alpaca tools use to choose a trading host. If any
# of them is set to something other than the paper host we refuse to start, so
# nobody can believe they switched this app to a different account type.
_BASE_URL_OVERRIDES = ("APCA_API_BASE_URL", "ALPACA_BASE_URL", "ALPACA_ENDPOINT")


class ConfigError(RuntimeError):
    pass


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _bool(name: str, default: bool) -> bool:
    raw = _env(name)
    if not raw:
        return default
    if raw.lower() in {"1", "true", "yes", "on"}:
        return True
    if raw.lower() in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{name} must be true or false")


def _decimal(name: str, default: str) -> Decimal:
    raw = _env(name, default)
    try:
        value = Decimal(raw)
    except InvalidOperation as exc:
        raise ConfigError(f"{name} must be a number") from exc
    if not value.is_finite() or value < 0:
        raise ConfigError(f"{name} must be a non-negative number")
    return value


def _int(name: str, default: int) -> int:
    raw = _env(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc
    if value < 0:
        raise ConfigError(f"{name} must be non-negative")
    return value


def _list(name: str, default: str) -> list[str]:
    raw = _env(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    # Credentials (server-side only)
    alpaca_key: str = ""
    alpaca_secret: str = ""
    webhook_secret: str = ""
    admin_secret: str = ""

    # Master switch for submitting PAPER orders from webhooks. Default off.
    enable_trading: bool = False

    database_url: str = ""

    # Risk
    allowed_symbols: tuple[str, ...] = ("SPY", "QQQ", "AAPL", "NVDA")
    max_order_qty: Decimal = Decimal("10")
    max_order_notional: Decimal = Decimal("5000")
    max_position_exposure: Decimal = Decimal("10000")
    max_total_exposure: Decimal = Decimal("25000")
    max_open_positions: int = 5
    short_selling_enabled: bool = False
    allow_fractional_qty: bool = False
    daily_loss_limit: Decimal = Decimal("2000")  # 0 disables the check
    paper_starting_equity: Decimal | None = None

    # Web / security
    frontend_origins: tuple[str, ...] = ("http://localhost:5173",)
    public_api_base_url: str = "http://localhost:8000"
    cookie_secure: bool = True
    session_hours: int = 12
    webhook_rate_limit_per_minute: int = 60
    login_rate_limit_per_minute: int = 5
    trust_proxy_headers: bool = False
    tradingview_ip_allowlist: tuple[str, ...] = ()
    enable_api_docs: bool = False

    # Broker timing
    broker_timeout_seconds: float = 2.5
    order_sync_interval_seconds: int = 15
    market_data_max_age_seconds: int = 900
    background_sync: bool = True


    @property
    def alpaca_configured(self) -> bool:
        return bool(self.alpaca_key and self.alpaca_secret)

    @property
    def webhook_url(self) -> str:
        return self.public_api_base_url.rstrip("/") + "/webhook"

    def secret_values(self) -> list[str]:
        return [s for s in (self.alpaca_key, self.alpaca_secret, self.webhook_secret, self.admin_secret) if s]


def _default_database_url() -> str:
    data_dir = BACKEND_DIR / "data"
    return f"sqlite:///{(data_dir / 'alpha_terminal.db').as_posix()}"


def load_settings() -> Settings:
    """Read settings from the environment (and a local .env file if present)."""
    try:
        from dotenv import load_dotenv

        load_dotenv(REPO_DIR / ".env", override=False)
    except ImportError:  # pragma: no cover - dotenv is a declared dependency
        pass

    for name in _BASE_URL_OVERRIDES:
        value = _env(name)
        if value and value.rstrip("/") != PAPER_TRADING_BASE_URL:
            raise ConfigError(
                f"{name} is set to a non-paper Alpaca host. ALPHA TERMINAL is PAPER ONLY and "
                f"always uses {PAPER_TRADING_BASE_URL}. Remove {name}."
            )

    starting = _env("PAPER_STARTING_EQUITY")
    symbols = tuple(s.upper() for s in _list("ALLOWED_SYMBOLS", "SPY,QQQ,AAPL,NVDA"))
    if not symbols:
        raise ConfigError("ALLOWED_SYMBOLS must list at least one symbol")

    return Settings(
        alpaca_key=_env("ALPACA_KEY"),
        alpaca_secret=_env("ALPACA_SECRET"),
        webhook_secret=_env("WEBHOOK_SECRET"),
        admin_secret=_env("ADMIN_SECRET"),
        enable_trading=_bool("ENABLE_TRADING", False),
        database_url=_env("DATABASE_URL") or _default_database_url(),
        allowed_symbols=symbols,
        max_order_qty=_decimal("MAX_ORDER_QTY", "10"),
        max_order_notional=_decimal("MAX_ORDER_NOTIONAL", "5000"),
        max_position_exposure=_decimal("MAX_POSITION_EXPOSURE", "10000"),
        max_total_exposure=_decimal("MAX_TOTAL_EXPOSURE", "25000"),
        max_open_positions=_int("MAX_OPEN_POSITIONS", 5),
        short_selling_enabled=_bool("SHORT_SELLING_ENABLED", False),
        allow_fractional_qty=_bool("ALLOW_FRACTIONAL_QTY", False),
        daily_loss_limit=_decimal("DAILY_LOSS_LIMIT", "2000"),
        paper_starting_equity=_decimal("PAPER_STARTING_EQUITY", starting) if starting else None,
        frontend_origins=tuple(o.rstrip("/") for o in _list("FRONTEND_ORIGINS", "http://localhost:5173")),
        public_api_base_url=_env("PUBLIC_API_BASE_URL", "http://localhost:8000"),
        cookie_secure=_bool("COOKIE_SECURE", True),
        session_hours=max(1, _int("SESSION_HOURS", 12)),
        webhook_rate_limit_per_minute=max(1, _int("WEBHOOK_RATE_LIMIT_PER_MINUTE", 60)),
        login_rate_limit_per_minute=max(1, _int("LOGIN_RATE_LIMIT_PER_MINUTE", 5)),
        trust_proxy_headers=_bool("TRUST_PROXY_HEADERS", False),
        tradingview_ip_allowlist=tuple(_list("TRADINGVIEW_IP_ALLOWLIST", "")),
        enable_api_docs=_bool("ENABLE_API_DOCS", False),
        broker_timeout_seconds=float(_decimal("BROKER_TIMEOUT_SECONDS", "2.5")) or 2.5,
        order_sync_interval_seconds=max(5, _int("ORDER_SYNC_INTERVAL_SECONDS", 15)),
        market_data_max_age_seconds=max(60, _int("MARKET_DATA_MAX_AGE_SECONDS", 900)),
        background_sync=_bool("BACKGROUND_SYNC", True),
    )

"""FastAPI application factory.

Run locally:  uvicorn alpha_terminal.main:app --reload   (from backend/)
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import engine as engine_mod
from .api import router as api_router
from .auth import router as auth_router
from .broker import AlpacaPaperBroker, Broker
from .config import Settings, load_settings
from .context import AppContext
from .database import Database
from .health import public_health
from .logging_service import ActivityLogger, configure_process_logging
from .orders import sync_orders
from .rate_limit import SlidingWindowLimiter
from .schemas import api_response
from .version import VERSION
from .webhook import router as webhook_router

log = logging.getLogger("alpha_terminal")


def build_context(settings: Settings, broker: Broker | None = None) -> AppContext:
    database = Database(settings.database_url)
    database.create_all()
    broker = broker or AlpacaPaperBroker(settings.alpaca_key, settings.alpaca_secret,
                                         timeout=settings.broker_timeout_seconds)
    return AppContext(
        settings=settings,
        database=database,
        broker=broker,
        activity=ActivityLogger(database, settings.secret_values()),
        webhook_limiter=SlidingWindowLimiter(settings.webhook_rate_limit_per_minute),
        login_limiter=SlidingWindowLimiter(settings.login_rate_limit_per_minute),
    )


def create_app(settings: Settings | None = None, broker: Broker | None = None) -> FastAPI:
    settings = settings or load_settings()
    configure_process_logging(settings.secret_values())
    ctx = build_context(settings, broker)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        with ctx.database.session() as db:
            previous = engine_mod.boot_stopped(db)
        ctx.activity.log("SYSTEM", "info", f"ALPHA TERMINAL {VERSION} started in PAPER mode — engine STOPPED"
                         + (f" (was {previous})" if previous != engine_mod.STOPPED else ""))
        task = asyncio.create_task(_sync_loop(ctx)) if settings.background_sync else None
        try:
            yield
        finally:
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    docs = settings.enable_api_docs
    app = FastAPI(title="ALPHA TERMINAL API (PAPER)", version=VERSION, lifespan=lifespan,
                  docs_url="/docs" if docs else None, redoc_url=None, openapi_url="/openapi.json" if docs else None)
    app.state.ctx = ctx

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.frontend_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-Alpha-Terminal", "Authorization"],
        max_age=600,
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next: Any) -> Any:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Paper-Only"] = "true"
        if settings.cookie_secure:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail)}
        return JSONResponse(api_response(ok=False, status="error", code=str(detail.get("code")),
                                         message=str(detail.get("message"))), exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(api_response(ok=False, status="rejected", code="INVALID_REQUEST",
                                         message="Request body or parameters are invalid"), 400)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error: %s", type(exc).__name__)
        with contextlib.suppress(Exception):
            ctx.activity.log("SYSTEM", "error", "Internal error", error_detail=type(exc).__name__)
        return JSONResponse(api_response(ok=False, status="error", code="INTERNAL_ERROR",
                                         message="Internal server error"), 500)

    @app.get("/health")
    async def health() -> JSONResponse:
        from fastapi.concurrency import run_in_threadpool

        return JSONResponse(await run_in_threadpool(public_health, ctx))

    @app.get("/")
    async def root() -> dict[str, Any]:
        return {"name": "ALPHA TERMINAL API", "mode": "PAPER", "version": VERSION}

    app.include_router(webhook_router)
    app.include_router(auth_router)
    app.include_router(api_router)
    return app


async def _sync_loop(ctx: AppContext) -> None:
    while True:
        await asyncio.sleep(ctx.settings.order_sync_interval_seconds)
        try:
            await asyncio.to_thread(sync_orders, ctx)
        except Exception as exc:  # keep the loop alive
            log.warning("order sync failed: %s", type(exc).__name__)


def __getattr__(name: str) -> Any:
    # `uvicorn alpha_terminal.main:app` builds the app lazily so tests can
    # import this module without reading the environment.
    if name == "app":
        return create_app()
    raise AttributeError(name)

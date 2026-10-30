"""Dashboard authentication.

* Login with ADMIN_SECRET (compared server-side, constant time, rate limited).
* Success sets an HttpOnly, Secure, SameSite=Strict session cookie holding a
  random token. Only its SHA-256 hash is stored in the database.
* State-changing requests that rely on the cookie must also send the header
  `X-Alpha-Terminal: 1` and, if the browser sends Origin, come from an allowed
  frontend origin (CSRF protection; the header forces a CORS preflight).
* Scripts may instead send `Authorization: Bearer <ADMIN_SECRET>`.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import delete

from .context import AppContext
from .models import AuthSession
from .schemas import api_response
from .webhook import client_ip

COOKIE_NAME = "at_session"
CSRF_HEADER = "x-alpha-terminal"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

router = APIRouter(prefix="/auth")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx  # type: ignore[no-any-return]


def _unauthorized(message: str = "Authentication required") -> HTTPException:
    return HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": message})


def _check_csrf(request: Request, ctx: AppContext) -> None:
    if request.method in SAFE_METHODS:
        return
    if request.headers.get(CSRF_HEADER) != "1":
        raise HTTPException(status_code=403, detail={"code": "CSRF_HEADER_MISSING", "message": "Missing X-Alpha-Terminal header"})
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") not in ctx.settings.frontend_origins:
        raise HTTPException(status_code=403, detail={"code": "ORIGIN_NOT_ALLOWED", "message": "Origin not allowed"})


def require_admin(request: Request, ctx: AppContext = Depends(get_ctx)) -> str:
    """Dependency for every private route. Returns the auth method used."""
    admin = ctx.settings.admin_secret
    authz = request.headers.get("authorization", "")
    if authz.lower().startswith("bearer "):
        bearer = authz[7:].strip()
        if admin and hmac.compare_digest(bearer.encode(), admin.encode()):
            return "bearer"
        raise _unauthorized("Invalid bearer token")
    token = request.cookies.get(COOKIE_NAME)
    if not token or not admin:
        raise _unauthorized()
    now = datetime.now(UTC)
    with ctx.database.session() as db:
        row = db.query(AuthSession).filter(AuthSession.token_hash == _hash(token)).one_or_none()
        if row is None or row.expires_at <= now:
            raise _unauthorized("Session expired")
        if (now - row.last_seen_at).total_seconds() > 60:
            row.last_seen_at = now
            db.commit()
    _check_csrf(request, ctx)
    return "session"


@router.post("/login")
async def login(request: Request) -> JSONResponse:
    ctx = get_ctx(request)
    ip = client_ip(request, ctx)
    if not ctx.login_limiter.allow(ip):
        ctx.activity.log("SECURITY", "error", "Login rate limit exceeded", rejection_reason=f"ip={ip}")
        return JSONResponse(api_response(ok=False, status="rejected", code="RATE_LIMITED", message="Too many attempts; wait a minute"), 429)
    if request.headers.get(CSRF_HEADER) != "1":
        return JSONResponse(api_response(ok=False, status="rejected", code="CSRF_HEADER_MISSING", message="Missing header"), 403)
    if not ctx.settings.admin_secret:
        return JSONResponse(api_response(ok=False, status="error", code="AUTH_NOT_CONFIGURED", message="ADMIN_SECRET is not configured"), 503)
    try:
        body = await request.json()
    except Exception:
        body = None
    password = body.get("password") if isinstance(body, dict) else None
    if not isinstance(password, str) or not hmac.compare_digest(password.encode(), ctx.settings.admin_secret.encode()):
        ctx.activity.log("AUTH", "error", "Dashboard login failed", rejection_reason=f"ip={ip}")
        return JSONResponse(api_response(ok=False, status="rejected", code="UNAUTHORIZED", message="Invalid credentials"), 401)

    token = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    expires = now + timedelta(hours=ctx.settings.session_hours)
    with ctx.database.session() as db:
        db.execute(delete(AuthSession).where(AuthSession.expires_at <= now))
        db.add(AuthSession(token_hash=_hash(token), created_at=now, expires_at=expires, last_seen_at=now, ip=ip))
        db.commit()
    ctx.activity.log("AUTH", "success", "Dashboard login")
    resp = JSONResponse(api_response(ok=True, status="ok", code="LOGGED_IN", message="Signed in",
                                     data={"expires_at": expires.isoformat()}))
    resp.set_cookie(COOKIE_NAME, token, max_age=ctx.settings.session_hours * 3600, httponly=True,
                    secure=ctx.settings.cookie_secure, samesite="strict", path="/")
    return resp


@router.post("/logout")
async def logout(request: Request) -> JSONResponse:
    ctx = get_ctx(request)
    token = request.cookies.get(COOKIE_NAME)
    if token:
        with ctx.database.session() as db:
            db.execute(delete(AuthSession).where(AuthSession.token_hash == _hash(token)))
            db.commit()
        ctx.activity.log("AUTH", "info", "Dashboard logout")
    resp = JSONResponse(api_response(ok=True, status="ok", code="LOGGED_OUT", message="Signed out"))
    resp.delete_cookie(COOKIE_NAME, path="/", secure=ctx.settings.cookie_secure, httponly=True, samesite="strict")
    return resp


@router.get("/session")
def session_status(request: Request, method: str = Depends(require_admin)) -> dict[str, object]:
    ctx = get_ctx(request)
    expires = None
    token = request.cookies.get(COOKIE_NAME)
    if token:
        with ctx.database.session() as db:
            row = db.query(AuthSession).filter(AuthSession.token_hash == _hash(token)).one_or_none()
            expires = row.expires_at.isoformat() if row else None
    return {"authenticated": True, "method": method, "expires_at": expires}

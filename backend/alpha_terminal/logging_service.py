"""Activity log (persisted) and process log (stdout) with secret redaction."""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime
from typing import Any

from .database import Database
from .models import ActivityEvent

LEVELS = {"success", "decision", "error", "info"}

logger = logging.getLogger("alpha_terminal")


class RedactingFilter(logging.Filter):
    """Replaces any configured secret value that appears in a log record."""

    def __init__(self, secrets: list[str]) -> None:
        super().__init__()
        self.secrets = [s for s in secrets if len(s) >= 4]

    def filter(self, record: logging.LogRecord) -> bool:
        if not self.secrets:
            return True
        msg = record.getMessage()
        changed = False
        for secret in self.secrets:
            if secret in msg:
                msg = msg.replace(secret, "[REDACTED]")
                changed = True
        if changed:
            record.msg = msg
            record.args = ()
        return True


def configure_process_logging(secrets: list[str]) -> None:
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    redactor = RedactingFilter(secrets)
    for handler in logging.getLogger().handlers:
        for f in list(handler.filters):
            if isinstance(f, RedactingFilter):
                handler.removeFilter(f)
        handler.addFilter(redactor)
    # httpx logs request URLs at INFO; keep it quiet (it never logs headers).
    logging.getLogger("httpx").setLevel(logging.WARNING)


class ActivityLogger:
    def __init__(self, database: Database, secrets: list[str]) -> None:
        self.database = database
        self.secrets = [s for s in secrets if len(s) >= 4]
        self._lock = threading.Lock()
        self.last_write_ok: bool | None = None
        self.last_write_at: datetime | None = None
        self.last_error: str | None = None

    def _scrub(self, value: Any) -> Any:
        if value is None:
            return None
        text = str(value)
        for secret in self.secrets:
            text = text.replace(secret, "[REDACTED]")
        return text[:2000]

    def log(self, category: str, level: str, message: str, **fields: Any) -> None:
        """Write one event in its own transaction so failures elsewhere never lose it."""
        if level not in LEVELS:
            level = "info"
        clean = {k: self._scrub(v) for k, v in fields.items()}
        event = ActivityEvent(
            ts=datetime.now(UTC), category=category.upper()[:16], level=level, message=self._scrub(message), **clean
        )
        logger.info("%s %s %s", category.upper(), message, {k: v for k, v in clean.items() if v is not None})
        try:
            with self._lock, self.database.session() as db:
                db.add(event)
                db.commit()
            self.last_write_ok = True
            self.last_write_at = datetime.now(UTC)
            self.last_error = None
        except Exception as exc:  # pragma: no cover - exercised via health when DB is down
            self.last_write_ok = False
            self.last_error = type(exc).__name__
            logger.error("activity log write failed: %s", type(exc).__name__)

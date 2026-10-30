"""Application context shared by routes (settings, database, broker, loggers)."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from .broker import Broker
from .config import Settings
from .database import Database
from .logging_service import ActivityLogger
from .models import AppMeta
from .rate_limit import SlidingWindowLimiter


@dataclass
class AppContext:
    settings: Settings
    database: Database
    broker: Broker
    activity: ActivityLogger
    webhook_limiter: SlidingWindowLimiter
    login_limiter: SlidingWindowLimiter
    # Serialises risk check + order submission so concurrent alerts cannot both
    # pass an exposure limit that only one of them fits in.
    execution_lock: threading.Lock = field(default_factory=threading.Lock)
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    cache: dict[str, tuple[float, Any]] = field(default_factory=dict)

    # ---- meta helpers ---------------------------------------------------
    def meta_get(self, key: str) -> str | None:
        with self.database.session() as db:
            row = db.get(AppMeta, key)
            return row.value if row else None

    def meta_set(self, key: str, value: str) -> None:
        with self.database.session() as db:
            row = db.get(AppMeta, key)
            if row is None:
                db.add(AppMeta(key=key, value=value))
            else:
                row.value = value
            db.commit()

    def meta_incr(self, key: str) -> None:
        with self.database.session() as db:
            row = db.get(AppMeta, key)
            if row is None:
                db.add(AppMeta(key=key, value="1"))
            else:
                row.value = str(int(row.value) + 1)
            db.commit()

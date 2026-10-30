"""In-process sliding-window rate limiter (single backend instance)."""

from __future__ import annotations

import threading
import time
from collections import deque


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float = 60.0) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()
        self.blocked_total = 0

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and now - q[0] >= self.window:
                q.popleft()
            if len(q) >= self.limit:
                self.blocked_total += 1
                return False
            q.append(now)
            if len(self._hits) > 10_000:  # bound memory under abuse
                for k in [k for k, v in self._hits.items() if not v][:5_000]:
                    del self._hits[k]
            return True

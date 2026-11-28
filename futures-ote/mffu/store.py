"""Crash-safe persistence for simulated account and compliance state (restart recovery). Local files only."""
from __future__ import annotations

import json
import os
from typing import Any


def save(path: str, obj: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, default=str, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)   # atomic: a crash leaves either the old or the new file, never a partial one


def load(path: str) -> Any:
    with open(path) as f:
        return json.load(f)

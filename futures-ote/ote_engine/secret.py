"""Databento API key access. The key is NEVER printed, logged, written to disk or passed on a command line.

Lookup order: the process environment variable DATABENTO_API_KEY, then the Windows *user* environment in the registry
(HKCU\\Environment), so a key set with SetEnvironmentVariable(..., "User") works without restarting the app.
"""
from __future__ import annotations

import os
import re

ENV = "DATABENTO_API_KEY"


def get_key() -> str:
    k = os.environ.get(ENV)
    if not k and os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as h:
                k, _ = winreg.QueryValueEx(h, ENV)
        except OSError:
            k = None
    if not k:
        raise RuntimeError(f"{ENV} is not set (see futures-ote/DATABENTO-SETUP.md)")
    k = k.strip()
    if not re.fullmatch(r"db-[A-Za-z0-9]{20,64}", k):
        raise RuntimeError(f"{ENV} does not look like a Databento key (expected 'db-' + letters/digits); value not shown")
    return k


def redact(text: str, key: str | None) -> str:
    """Remove the key (and anything key-shaped) from a message before it is shown or logged."""
    s = str(text)
    if key:
        s = s.replace(key, "db-***REDACTED***")
    return re.sub(r"db-[A-Za-z0-9]{20,64}", "db-***REDACTED***", s)


def key_present() -> bool:
    try:
        get_key()
        return True
    except RuntimeError:
        return False

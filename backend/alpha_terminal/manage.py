"""Maintenance commands.

    python -m alpha_terminal.manage init-db     create tables (idempotent)
    python -m alpha_terminal.manage check-db    schema + integrity + duplicate-guard check
    python -m alpha_terminal.manage check-config  validate environment (prints no secrets)
"""

from __future__ import annotations

import json
import sys

from .config import PAPER_TRADING_BASE_URL, load_settings
from .database import Database


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "check-db"
    settings = load_settings()
    if cmd == "check-config":
        report = {
            "trading_host": PAPER_TRADING_BASE_URL,
            "alpaca_configured": settings.alpaca_configured,
            "webhook_secret_configured": bool(settings.webhook_secret),
            "admin_secret_configured": bool(settings.admin_secret),
            "admin_secret_length_ok": len(settings.admin_secret) >= 16,
            "webhook_secret_length_ok": len(settings.webhook_secret) >= 16,
            "enable_trading": settings.enable_trading,
            "allowed_symbols": list(settings.allowed_symbols),
            "frontend_origins": list(settings.frontend_origins),
            "cookie_secure": settings.cookie_secure,
        }
        print(json.dumps(report, indent=2))
        return 0
    db = Database(settings.database_url)
    if cmd == "init-db":
        db.create_all()
        print("database initialised")
        return 0
    if cmd == "check-db":
        db.create_all()
        report = db.integrity_report()
        print(json.dumps(report, indent=2))
        return 0 if report["ok"] else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

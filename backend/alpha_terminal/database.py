"""Database engine, sessions and schema management."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

SCHEMA_VERSION = "1"


class Base(DeclarativeBase):
    pass


class Database:
    def __init__(self, url: str) -> None:
        self.url = url
        connect_args: dict[str, object] = {}
        if url.startswith("sqlite"):
            connect_args["check_same_thread"] = False
            connect_args["timeout"] = 15
            path = url.split("sqlite:///", 1)[-1]
            if path and path != ":memory:":
                Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.engine: Engine = create_engine(url, connect_args=connect_args, pool_pre_ping=True, future=True)
        if url.startswith("sqlite"):
            event.listen(self.engine, "connect", _sqlite_pragmas)
        self.sessionmaker = sessionmaker(bind=self.engine, expire_on_commit=False, future=True)

    def create_all(self) -> None:
        from . import models  # noqa: F401  (register tables)

        Base.metadata.create_all(self.engine)
        with self.session() as db:
            from .models import AppMeta

            row = db.get(AppMeta, "schema_version")
            if row is None:
                db.add(AppMeta(key="schema_version", value=SCHEMA_VERSION))
            db.commit()

    @contextmanager
    def session(self) -> Iterator[Session]:
        db = self.sessionmaker()
        try:
            yield db
        finally:
            db.close()

    def ping(self) -> bool:
        try:
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return True
        except Exception:
            return False

    def integrity_report(self) -> dict[str, object]:
        """Checks used by `python -m alpha_terminal.manage check-db` and health."""
        from . import models  # noqa: F401

        expected = set(Base.metadata.tables)
        insp = inspect(self.engine)
        present = set(insp.get_table_names())
        missing = sorted(expected - present)
        unique_alert_id = False
        if "alerts" in present:
            for uc in insp.get_unique_constraints("alerts"):
                if uc.get("column_names") == ["alert_id"]:
                    unique_alert_id = True
            for ix in insp.get_indexes("alerts"):
                if ix.get("unique") and ix.get("column_names") == ["alert_id"]:
                    unique_alert_id = True
        integrity = "not_applicable"
        if self.url.startswith("sqlite"):
            with self.engine.connect() as conn:
                integrity = str(conn.execute(text("PRAGMA integrity_check")).scalar())
        return {
            "missing_tables": missing,
            "duplicate_guard_unique_index": unique_alert_id,
            "sqlite_integrity_check": integrity,
            "ok": not missing and unique_alert_id and integrity in ("ok", "not_applicable"),
        }


def _sqlite_pragmas(dbapi_conn, _record) -> None:  # type: ignore[no-untyped-def]
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()

"""Execution engine state machine (PAPER execution only).

States: STOPPED, RUNNING, PAUSED. The kill switch is a separate latch: while
it is set the engine is STOPPED and cannot be started until the kill switch is
explicitly reset. The server always boots into STOPPED.

    STOPPED --start--> RUNNING --pause--> PAUSED --resume--> RUNNING
    any     --stop---> STOPPED
    any     --kill---> STOPPED + kill_switch
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from .models import EngineStateRow

STOPPED, RUNNING, PAUSED = "STOPPED", "RUNNING", "PAUSED"


class EngineTransitionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class EngineSnapshot:
    state: str
    kill_switch: bool
    killed_at: datetime | None
    updated_at: datetime
    updated_by: str | None
    reason: str | None

    def as_dict(self) -> dict[str, object]:
        return {
            "state": self.state,
            "kill_switch": self.kill_switch,
            "killed_at": self.killed_at.isoformat() if self.killed_at else None,
            "updated_at": self.updated_at.isoformat(),
            "updated_by": self.updated_by,
            "reason": self.reason,
        }


def _row(db: Session) -> EngineStateRow:
    row = db.get(EngineStateRow, 1)
    if row is None:
        row = EngineStateRow(id=1, state=STOPPED, kill_switch=False, updated_at=datetime.now(UTC), updated_by="init")
        db.add(row)
        db.flush()
    return row


def snapshot(db: Session) -> EngineSnapshot:
    row = _row(db)
    return EngineSnapshot(row.state, row.kill_switch, row.killed_at, row.updated_at, row.updated_by, row.reason)


def boot_stopped(db: Session) -> str:
    """Called on server start. Returns the state that was persisted before."""
    row = _row(db)
    previous = row.state
    row.state = STOPPED
    row.updated_at = datetime.now(UTC)
    row.updated_by = "server_start"
    row.reason = "Server started; engine always boots STOPPED"
    db.commit()
    return previous


def transition(db: Session, action: str, *, enable_trading: bool, actor: str = "admin") -> EngineSnapshot:
    row = _row(db)
    current = row.state
    if action == "start":
        if row.kill_switch:
            raise EngineTransitionError("KILL_SWITCH_ACTIVE", "Kill switch is active. Reset it before starting.")
        if not enable_trading:
            raise EngineTransitionError(
                "EXECUTION_DISABLED", "ENABLE_TRADING is false on the server. PAPER execution cannot start."
            )
        if current != STOPPED:
            raise EngineTransitionError("INVALID_TRANSITION", f"Cannot start from {current}")
        new = RUNNING
    elif action == "pause":
        if current != RUNNING:
            raise EngineTransitionError("INVALID_TRANSITION", f"Cannot pause from {current}")
        new = PAUSED
    elif action == "resume":
        if row.kill_switch:
            raise EngineTransitionError("KILL_SWITCH_ACTIVE", "Kill switch is active.")
        if current != PAUSED:
            raise EngineTransitionError("INVALID_TRANSITION", f"Cannot resume from {current}")
        new = RUNNING
    elif action == "stop":
        new = STOPPED
    else:
        raise EngineTransitionError("INVALID_ACTION", f"Unknown engine action {action}")
    row.state = new
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor
    row.reason = f"{action} by {actor}"
    db.commit()
    return snapshot(db)


def kill(db: Session, *, actor: str = "admin") -> EngineSnapshot:
    row = _row(db)
    row.state = STOPPED
    row.kill_switch = True
    row.killed_at = datetime.now(UTC)
    row.updated_at = row.killed_at
    row.updated_by = actor
    row.reason = "Emergency kill switch: new PAPER orders blocked"
    db.commit()
    return snapshot(db)


def reset_kill(db: Session, *, actor: str = "admin") -> EngineSnapshot:
    row = _row(db)
    row.kill_switch = False
    row.state = STOPPED
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor
    row.reason = "Kill switch reset; engine remains STOPPED until started"
    db.commit()
    return snapshot(db)

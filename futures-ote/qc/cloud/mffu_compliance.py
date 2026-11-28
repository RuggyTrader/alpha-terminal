"""Deterministic pre-trade compliance gate for SIMULATED MFFU accounts.

Every simulated order goes through ComplianceEngine.check(). All checks run in a fixed order and every failing reason is
reported. There is no override argument, no bypass flag and no way to disable the audit log; an order source of
"AI_SUGGESTION" is checked exactly like any other order. An accepted Decision is bound to the order's digest and can be
consumed once by a local adapter (execution.py).

These are simulation protections. They are not a guarantee against losses: gaps, slippage beyond the scenario and
rule interpretations MFFU has not confirmed can all produce outcomes the gate did not foresee.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple

from mffu_calendar import is_open, mffu_permitted, NewsCalendar
from mffu_instruments import INSTRUMENTS, CostScenario, validate_qty

EXTERNAL_EXECUTION = "DISABLED"
SOURCES_OK = ("STRATEGY", "AI_SUGGESTION", "MANUAL_SIM")


@dataclass(frozen=True)
class OrderIntent:
    client_id: str
    account_id: str
    symbol: str                 # root, e.g. MNQ
    side: int                   # +1 buy, -1 sell
    qty: Any
    order_type: str             # "LIMIT" | "MARKET" | "STOP"
    price: Optional[float]      # limit / stop price; None for market
    stop_loss: Optional[float]  # protective stop (required for entries)
    take_profit: Optional[float] = None
    reduce_only: bool = False
    source: str = "STRATEGY"
    route: str = "local"        # only "local" is accepted while external execution is DISABLED
    created_at: str = ""

    def digest(self) -> str:
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True, default=str).encode()).hexdigest()


@dataclass(frozen=True)
class MarketState:
    now: dt.datetime
    last_bar_time: Optional[dt.datetime]
    last_price: Optional[float]
    live_from: Optional[dt.datetime] = None     # when the order would first be able to fill
    price_limit_band: Optional[Tuple[float, float]] = None   # (lower, upper) CME limit levels, if known


@dataclass(frozen=True)
class Position:
    symbol: str
    side: int
    qty: int
    entry: float
    stop: Optional[float]


@dataclass(frozen=True)
class Decision:
    accepted: bool
    reasons: Tuple[str, ...]
    warnings: Tuple[str, ...]
    decision_id: str
    intent_digest: str
    rules_hash: str
    at: str
    worst_case_loss: Optional[float] = None
    remaining_drawdown: Optional[float] = None
    remaining_daily: Optional[float] = None


class ComplianceEngine:
    def __init__(self, scenario: CostScenario, news: Optional[NewsCalendar] = None, stale_after=dt.timedelta(minutes=3), audit_path: Optional[str] = None):
        self.scenario = scenario
        self.news = news if news is not None else NewsCalendar(None)
        self.stale_after = stale_after
        self.audit_path = audit_path
        self.emergency: Optional[Dict[str, str]] = None
        self.seen_ids: set = set()
        self.issued: Dict[str, str] = {}
        self.consumed: set = set()
        self.counts: Dict[str, int] = {}
        self.audit_tail: List[Dict[str, Any]] = []
        self.n = 0

    # -------------------------------------------------------------- owner controls (simulation)
    def emergency_pause(self, reason: str, at: str = ""):
        self.emergency = {"reason": reason, "at": at}
        self._audit({"kind": "EMERGENCY_PAUSE", "reason": reason, "at": at})

    def resume(self, by: str, at: str = ""):
        if by != "owner":
            raise PermissionError("only the owner can lift an emergency pause")
        self._audit({"kind": "EMERGENCY_RESUME", "by": by, "at": at})
        self.emergency = None

    # -------------------------------------------------------------- the gate
    def check(self, intent: OrderIntent, account, market: MarketState, position: Optional[Position] = None) -> Decision:
        R: List[str] = []
        W: List[str] = []
        cfg = account.cfg if account is not None else {}
        spec = INSTRUMENTS.get(intent.symbol)
        if intent.route != "local":
            R.append("EXTERNAL_EXECUTION_DISABLED")
        if intent.source not in SOURCES_OK:
            R.append("UNKNOWN_ORDER_SOURCE")
        if self.emergency:
            R.append("EMERGENCY_PAUSE")
        if account is None:
            R.append("NO_ACTIVE_ACCOUNT")
        elif not account.accepting():
            R.append(f"ACCOUNT_{account.status}")
        if intent.client_id in self.seen_ids:
            R.append("DUPLICATE_ORDER_ID")
        if spec is None:
            R.append("UNSUPPORTED_INSTRUMENT")
        try:
            q = validate_qty(intent.qty)
        except ValueError:
            q = 0
            R.append("INVALID_QUANTITY")
        if market.last_bar_time is None or market.last_price is None or (isinstance(market.last_price, float) and math.isnan(market.last_price)):
            R.append("MISSING_MARKET_DATA")
        elif market.now - market.last_bar_time > self.stale_after:
            R.append("STALE_MARKET_DATA")
        live_from = market.live_from or market.now
        if not is_open(live_from):
            R.append("MARKET_CLOSED")
        elif cfg.get("flat_by_session_end") and not mffu_permitted(live_from):
            R.append("OUTSIDE_MFFU_TRADING_HOURS")      # S17: 4:10 PM to 6:00 PM ET
        opening = not intent.reduce_only
        if opening and intent.stop_loss is None:
            R.append("NO_PROTECTIVE_STOP")
        if position is not None and opening and position.side != intent.side and spec is not None and INSTRUMENTS.get(position.symbol, spec).underlying == spec.underlying:
            R.append("HEDGING_PROHIBITED")
        rem_dd = rem_daily = worst = None
        if account is not None and spec is not None and q:
            micros = cfg.get("max_micros")
            if micros is None:
                R.append("CONTRACT_LIMIT_UNRESOLVED")
            else:
                held = position.qty if (position is not None and position.side == intent.side) else 0
                if opening and held + q > int(micros):
                    R.append("CONTRACT_LIMIT")
            # news (S7): no positions or orders 2 minutes either side of a T1 release where the stage prohibits it
            t1_ok = cfg.get("t1_news_allowed")
            if t1_ok is None:
                R.append("NEWS_RULE_UNRESOLVED")
            elif t1_ok is False and opening:
                if not self.news.covers(live_from, live_from):
                    R.append("NEWS_CALENDAR_UNAVAILABLE")
                elif self.news.in_window(live_from, live_from + dt.timedelta(minutes=1)):
                    R.append("NEWS_WINDOW")
            if str(cfg.get("price_limit_2pct") or "").startswith("prohibited"):
                if market.price_limit_band is None:
                    W.append("PRICE_LIMIT_2PCT_UNVERIFIED")
                else:
                    lo, hi = market.price_limit_band
                    px = market.last_price or 0.0
                    if px >= hi * 0.98 or px <= lo * 1.02:
                        R.append("WITHIN_2PCT_OF_PRICE_LIMIT")
            # risk: open position to its stop + this order to its stop + costs must fit inside both allowances
            if opening and intent.stop_loss is not None:
                ref = intent.price if intent.price is not None else market.last_price
                if ref is not None:
                    comm = 2 * self.scenario.commission_per_side * q
                    slip = self.scenario.stop_slip_ticks * spec.tick * spec.multiplier * q
                    worst = abs(ref - intent.stop_loss) * spec.multiplier * q + comm + slip
                    if position is not None and position.stop is not None and market.last_price is not None:
                        open_to_stop = position.side * (position.stop - market.last_price) * spec.multiplier * position.qty
                        worst += max(0.0, -open_to_stop)
                    eq = account.balance + (0.0 if position is None or market.last_price is None else position.side * (market.last_price - position.entry) * spec.multiplier * position.qty)
                    rem_dd = account.remaining_drawdown(eq)
                    if worst >= rem_dd:
                        R.append("WOULD_RISK_ACCOUNT_BREACH")
                    rem_daily = account.remaining_daily(eq)
                    if rem_daily is not None and worst >= rem_daily:
                        R.append("WOULD_RISK_DAILY_LOSS_LIMIT")
        self.n += 1
        did = f"D{self.n:08d}"
        dg = intent.digest()
        d = Decision(accepted=not R, reasons=tuple(R), warnings=tuple(W), decision_id=did, intent_digest=dg,
                     rules_hash=cfg.get("_rules_hash", ""), at=str(market.now), worst_case_loss=worst, remaining_drawdown=rem_dd, remaining_daily=rem_daily)
        self.seen_ids.add(intent.client_id)
        if d.accepted:
            self.issued[did] = dg
        for r in R or ("ACCEPTED",):
            self.counts[r] = self.counts.get(r, 0) + 1
        self._audit({"kind": "DECISION", "id": did, "client_id": intent.client_id, "accepted": d.accepted, "reasons": list(R), "warnings": list(W),
                     "source": intent.source, "at": str(market.now)})
        return d

    def verify(self, decision: Decision, intent: OrderIntent) -> bool:
        """True once for an accepted decision issued by this engine for exactly this intent."""
        ok = decision.accepted and self.issued.get(decision.decision_id) == intent.digest() and decision.decision_id not in self.consumed
        if ok:
            self.consumed.add(decision.decision_id)
        return ok

    # -------------------------------------------------------------- audit + persistence
    def _audit(self, rec: Dict[str, Any]):
        self.audit_tail.append(rec)
        if len(self.audit_tail) > 2000:
            del self.audit_tail[:1000]
        if self.audit_path:
            with open(self.audit_path, "a") as f:
                f.write(json.dumps(rec, default=str) + "\n")

    def to_state(self) -> Dict[str, Any]:
        return {"emergency": self.emergency, "seen_ids": sorted(self.seen_ids), "issued": self.issued, "consumed": sorted(self.consumed),
                "counts": self.counts, "n": self.n}

    def load_state(self, s: Dict[str, Any]):
        self.emergency, self.seen_ids, self.issued = s["emergency"], set(s["seen_ids"]), dict(s["issued"])
        self.consumed, self.counts, self.n = set(s["consumed"]), dict(s["counts"]), int(s["n"])

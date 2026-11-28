"""Broker-independent execution contract. LOCAL ONLY.

  OrderIntent (compliance.py)  ->  OrderRouter.submit()  ->  ComplianceEngine.check()  ->  adapter.submit(intent, decision)

Only two adapters exist: MockAdapter (records orders, fills nothing unless told) and PaperSimAdapter (fills against bars
supplied by the caller). Both refuse any order whose Decision the compliance engine did not issue for exactly that intent.

External execution is DISABLED. NinjaTrader and Tradovate are named only so a future integration has a place to land:
constructing either raises ExternalExecutionDisabled. No credentials are requested, no network library is imported, and
no route to a real account exists. Enabling one needs (1) MFFU's written confirmation of the supported technical route
for unattended automated execution and (2) the owner's separate authorization; neither has been given.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol

from .compliance import ComplianceEngine, Decision, MarketState, OrderIntent, Position, EXTERNAL_EXECUTION

LOCAL_KINDS = ("mock", "paper")
INTEGRATION_STATUS = {
    "external_execution": EXTERNAL_EXECUTION,
    "mffu_automation_approval": "NOT CONFIRMED: S5 allows automated strategies that do not exploit simulated fills; no approval of ALPHA TERMINAL exists",
    "supported_api_route": "UNCONFIRMED: S6 lists NinjaTrader, Tradovate, TradingView, Quantower and others with no API or automation statement",
    "owner_authorization": "NOT GIVEN",
    "candidates": ["NinjaTrader", "Tradovate"],
    "selected": None,
}


class ExternalExecutionDisabled(RuntimeError):
    pass


@dataclass
class Ack:
    accepted: bool
    order_id: Optional[str]
    reasons: tuple
    adapter: str


class ExecutionAdapter(Protocol):
    name: str
    kind: str

    def submit(self, intent: OrderIntent, decision: Decision) -> Ack: ...
    def cancel(self, order_id: str) -> bool: ...
    def positions(self) -> List[Position]: ...


class _LocalBase:
    kind = "mock"

    def __init__(self, compliance: ComplianceEngine, name: str):
        self.compliance, self.name = compliance, name
        self.orders: Dict[str, Dict[str, Any]] = {}
        self._pos: Dict[str, Position] = {}

    def submit(self, intent: OrderIntent, decision: Decision) -> Ack:
        if not self.compliance.verify(decision, intent):
            return Ack(False, None, ("DECISION_NOT_VALID_FOR_INTENT",), self.name)
        oid = f"{self.name}-{len(self.orders) + 1:06d}"
        self.orders[oid] = {"intent": intent, "status": "WORKING", "decision": decision.decision_id}
        return Ack(True, oid, (), self.name)

    def cancel(self, order_id: str) -> bool:
        o = self.orders.get(order_id)
        if not o or o["status"] != "WORKING":
            return False
        o["status"] = "CANCELLED"
        return True

    def positions(self) -> List[Position]:
        return list(self._pos.values())


class MockAdapter(_LocalBase):
    kind = "mock"

    def __init__(self, compliance: ComplianceEngine):
        super().__init__(compliance, "MOCK")


class PaperSimAdapter(_LocalBase):
    """Fills working orders against one bar at a time (limit touched -> filled at the limit; market -> bar open)."""
    kind = "paper"

    def __init__(self, compliance: ComplianceEngine):
        super().__init__(compliance, "PAPER")
        self.fills: List[Dict[str, Any]] = []

    def on_bar(self, symbol: str, t, o: float, h: float, l: float, c: float):
        for oid, od in self.orders.items():
            it: OrderIntent = od["intent"]
            if od["status"] != "WORKING" or it.symbol != symbol:
                continue
            px = None
            if it.order_type == "MARKET":
                px = o
            elif it.order_type == "LIMIT" and it.price is not None and ((it.side > 0 and l <= it.price) or (it.side < 0 and h >= it.price)):
                px = min(o, it.price) if it.side > 0 else max(o, it.price)
            if px is None:
                continue
            od["status"] = "FILLED"
            self.fills.append({"order_id": oid, "t": str(t), "px": px, "qty": int(it.qty), "side": it.side})
            cur = self._pos.get(symbol)
            q = int(it.qty) * it.side + ((cur.qty * cur.side) if cur else 0)
            self._pos.pop(symbol, None)
            if q:
                self._pos[symbol] = Position(symbol, 1 if q > 0 else -1, abs(q), px if not cur else cur.entry, it.stop_loss)


class _ExternalStub:
    platform = "external"

    def __init__(self, *a, **k):
        raise ExternalExecutionDisabled(
            f"{self.platform} execution is DISABLED: MFFU has not confirmed a supported route for unattended automated execution "
            "and the owner has not authorized an integration. Only local mock and paper adapters exist.")


class NinjaTraderAdapter(_ExternalStub):
    platform = "NinjaTrader"
    kind = "external"


class TradovateAdapter(_ExternalStub):
    platform = "Tradovate"
    kind = "external"


class OrderRouter:
    def __init__(self, compliance: ComplianceEngine, adapter):
        if getattr(adapter, "kind", None) not in LOCAL_KINDS:
            raise ExternalExecutionDisabled("only local mock / paper adapters may be routed to")
        self.compliance, self.adapter = compliance, adapter
        self.log: List[Dict[str, Any]] = []

    def submit(self, intent: OrderIntent, account, market: MarketState, position: Optional[Position] = None) -> Ack:
        d = self.compliance.check(intent, account, market, position)
        if not d.accepted:
            ack = Ack(False, None, d.reasons, self.adapter.name)
        else:
            ack = self.adapter.submit(intent, d)
        self.log.append({"client_id": intent.client_id, "accepted": ack.accepted, "reasons": list(ack.reasons), "decision": d.decision_id})
        return ack

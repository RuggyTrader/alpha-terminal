"""CME micro equity-index futures specifications (sources C1, C2) and futures-specific cost scenarios.

Nothing here reuses crypto assumptions: quantities are whole contracts, P&L is points x multiplier, and costs are per
contract per side. Commission and fee figures are SCENARIOS (no broker chosen and CME fee pages not read).
"""
from __future__ import annotations

import calendar
import datetime as dt
from dataclasses import dataclass
from typing import Tuple
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
MONTH_CODES = "FGHJKMNQUVXZ"


@dataclass(frozen=True)
class FuturesSpec:
    root: str
    name: str
    underlying: str          # contracts on the same underlying count together for hedging and limits
    multiplier: float        # USD per index point
    tick: float              # index points
    tick_value: float        # USD
    mini_equivalent: float   # 1 micro = 0.1 mini (MFFU caps are 'minis or the equivalent in micros', S13/S15)
    listed_months: str
    termination: str
    source: str

    def pnl(self, side: int, entry: float, exit: float, qty: int) -> float:
        return side * (exit - entry) * self.multiplier * qty

    def is_on_tick(self, px: float) -> bool:
        q = px / self.tick
        return abs(q - round(q)) < 1e-6


MNQ = FuturesSpec("MNQ", "Micro E-mini Nasdaq-100", "NQ", 2.0, 0.25, 0.50, 0.1, "HMUZ",
                  "Trading terminates at 9:30 a.m. ET on the 3rd Friday of the contract month", "C1")
MES = FuturesSpec("MES", "Micro E-mini S&P 500", "ES", 5.0, 0.25, 1.25, 0.1, "HMUZ",
                  "Trading terminates at 9:30 a.m. ET on the 3rd Friday of the contract month", "C2")
INSTRUMENTS = {"MNQ": MNQ, "MES": MES}


def validate_qty(qty) -> int:
    """Futures trade in whole contracts. Fractions, zero, negatives and non-numbers are rejected (never rounded)."""
    if isinstance(qty, bool) or not isinstance(qty, (int, float)):
        raise ValueError("quantity must be a number")
    if qty != int(qty) or int(qty) <= 0:
        raise ValueError(f"quantity must be a positive whole number of contracts, got {qty!r}")
    return int(qty)


def third_friday(year: int, month: int) -> dt.date:
    fridays = [d for d in calendar.Calendar().itermonthdates(year, month) if d.month == month and d.weekday() == 4]
    return fridays[2]


def last_trade_time(year: int, month: int) -> dt.datetime:
    """C1/C2: 9:30 a.m. ET on the 3rd Friday of the contract month."""
    d = third_friday(year, month)
    return dt.datetime(d.year, d.month, d.day, 9, 30, tzinfo=ET)


def contract_code(root: str, year: int, month: int) -> str:
    return f"{root}{MONTH_CODES[month - 1]}{year % 10}"


def quarterly_contracts(root: str, year: int) -> list:
    return [(contract_code(root, year, m), last_trade_time(year, m)) for m in (3, 6, 9, 12)]


@dataclass(frozen=True)
class CostScenario:
    """Per contract per side. Labelled ASSUMPTION: no broker is selected and CME fees were not verified."""
    name: str
    commission_per_side: float
    stop_slip_ticks: float
    limit_through_ticks: float
    path: str
    label: str


COST_SCENARIOS = {
    "C1_optimistic": CostScenario("C1_optimistic", 0.50, 0, 0, "tv", "ASSUMPTION: $0.50/side all-in, no slippage, TradingView intrabar path"),
    "C2_base": CostScenario("C2_base", 0.74, 1, 0, "tv", "ASSUMPTION: $0.74/side all-in, 1 tick on stops and forced exits"),
    "C3_conservative": CostScenario("C3_conservative", 1.50, 2, 1, "conservative", "ASSUMPTION: $1.50/side, 2 ticks, limits need a 1-tick trade-through, adverse-first path"),
    "C4_stress": CostScenario("C4_stress", 2.00, 4, 1, "conservative", "STRESS: $2.00/side, 4 ticks, 1-tick trade-through, adverse-first path"),
}


def round_trip_cost(spec: FuturesSpec, sc: CostScenario, qty: int) -> Tuple[float, float]:
    """(commission, worst-case slippage on one stop exit) in USD for `qty` contracts."""
    return 2 * sc.commission_per_side * qty, sc.stop_slip_ticks * spec.tick_value * qty

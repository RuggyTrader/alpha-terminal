"""Roll-safe historical replay of the locked strategy over individual futures contracts (shared by every data source).

The same functions are used by the local reference (whole period in memory) and by the QuantConnect streaming adapter
(qc/at_stream.py, one finished roll segment at a time); tests check that both give identical results.

Cost scenarios (labelled ASSUMPTIONS; no broker selected):
  S0 none:          no commission, no slippage, TradingView path             (diagnostic)
  S1 optimistic:    $0.50 / contract / side, no slippage, TradingView path
  S2 base:          $0.74 / side, stop / market slippage 1 tick, TradingView path
  S3 conservative:  $1.50 / side, 2 ticks, limits need a 1-tick trade-through, adverse-first intrabar path
Sizing: fractional ($10 risk, NON-EXECUTABLE diagnostic), whole (floor; skip if < 1 contract), fixed1 (always 1 contract).
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple

import pandas as pd

from .strategy import Execution, run
from .report import metrics

SCEN = {"S0_none": dict(path="tv", commission_per_side=0.0, stop_slip_ticks=0),
        "S1_optimistic": dict(path="tv", commission_per_side=0.50, stop_slip_ticks=0),
        "S2_base": dict(path="tv", commission_per_side=0.74, stop_slip_ticks=1),
        "S3_conservative": dict(path="conservative", commission_per_side=1.50, stop_slip_ticks=2, limit_through_ticks=1)}
SIZING = ["fractional", "whole", "fixed1"]
WARMUP = pd.Timedelta(days=10)
SUMMARY_KEYS = ["trades", "trades_per_week", "net_profit", "profit_factor", "win_rate_pct", "avg_trade", "max_drawdown_realized", "max_drawdown_intraday",
                "weekly_avg", "weekly_median", "weeks_positive", "weeks", "months_positive", "months", "best_week", "worst_week", "best_day", "worst_day",
                "max_consecutive_losses", "long_net", "short_net", "exit_reasons", "commissions", "slippage_usd", "risk_per_trade_usd", "chronological",
                "ambiguous_trades", "roll_exits", "same_bar_trades"]


def full_execution(scenario: str, sizing: str, tick: float = 0.25, point_value: float = 2.0) -> Execution:
    return Execution(name=f"{scenario}__{sizing}", sizing=sizing, tick=tick, point_value=point_value, **SCEN[scenario])


def window(seg: Dict[str, Any], lo, hi) -> Optional[Tuple[Any, Any]]:
    """The part of a roll segment inside the period [lo, hi); None if they do not overlap."""
    a, b = max(seg["start"], lo), min(seg["end"], hi)
    return (a, b) if a < b else None


class PeriodAccumulator:
    """Joins per-segment runs exactly as one continuous run_period would (trades, intraday drawdown, span, diagnostics)."""

    def __init__(self):
        self.trades: List[Any] = []
        self.diag: Dict[str, int] = {}
        self.offset = 0.0
        self.peak = self.ddi = 0.0
        self.first = self.last = None
        self.settings = self.execution = None

    def add(self, r: Dict[str, Any], t: List[Any], a, b, contract: str):
        for x in r["trades"]:
            x.contract = contract
        self.trades += r["trades"]
        for tt, c, lo in zip(t, r["eq_close"], r["eq_low"]):
            if a <= tt < b:   # same order and arithmetic as report.metrics over the joined equity series
                self.ddi = max(self.ddi, self.peak - (self.offset + lo))
                self.peak = max(self.peak, self.offset + c)
                if self.first is None:
                    self.first = tt
                self.last = tt
        self.offset += sum(x.net for x in r["trades"])
        for k, v in r["diag"].items():
            self.diag[k] = self.diag.get(k, 0) + v
        self.settings, self.execution = r["settings"], r["execution"]

    def result(self) -> Tuple[Dict[str, Any], List[Any]]:
        if self.first is None:
            raise SystemExit("no front-contract bars in the period: the data does not cover it")
        res = {"trades": self.trades, "eq_close": [], "eq_low": [], "max_drawdown_intraday": self.ddi, "diag": self.diag,
               "settings": self.settings, "execution": self.execution}
        return res, [self.first, self.last]


def run_segment(bars: Dict[str, List[Any]], seg: Dict[str, Any], lo, hi, st, ex, overlay=None, acc: Optional[PeriodAccumulator] = None):
    """Run one roll segment. bars: that contract's own bars from (window start - WARMUP) up to the window end."""
    w = window(seg, lo, hi)
    if w is None:
        return None
    r = run(bars, st, ex, window=w, overlay=overlay)
    if acc is not None:
        acc.add(r, bars["t"], w[0], w[1], seg["symbol"])
    return r


def segment_bars(df: pd.DataFrame, seg: Dict[str, Any], lo, hi) -> Optional[Dict[str, List[Any]]]:
    w = window(seg, lo, hi)
    if w is None:
        return None
    a, b = w
    sub = df[(df["symbol"] == seg["symbol"]) & (df["time"] >= a - WARMUP) & (df["time"] < b)]
    return {"t": list(sub["time"]), "o": sub["open"].tolist(), "h": sub["high"].tolist(), "l": sub["low"].tolist(), "c": sub["close"].tolist()}


def run_period(df: pd.DataFrame, segs: List[Dict[str, Any]], lo, hi, st, ex, overlay=None):
    """Local reference: every segment of the period, from a DataFrame of all contracts' bars."""
    acc = PeriodAccumulator()
    for s in segs:
        bars = segment_bars(df, s, lo, hi)
        if bars is not None:
            run_segment(bars, s, lo, hi, st, ex, overlay, acc)
    return acc.result()


def ambiguous(trades, bar_at: Callable[[str, Any], Optional[Tuple[float, float]]]):
    """Trades whose outcome depends on the unknown order of prices inside one minute. bar_at(contract, t) -> (low, high)."""
    out = []
    for x in trades:
        if x.same_bar:
            out.append((x.contract, str(x.exit_time), "entry and exit in the same minute")); continue
        lh = bar_at(x.contract, x.exit_time)
        if lh is None:
            continue
        s, tp = getattr(x, "exit_stop", None), getattr(x, "exit_tp", None)
        if s is not None and tp is not None and lh[0] <= min(s, tp) and lh[1] >= max(s, tp):
            out.append((x.contract, str(x.exit_time), "stop and TP2 both inside the exit minute"))
    return out


def df_bar_at(df: pd.DataFrame):
    idx = df.set_index(["symbol", "time"])

    def f(contract, t):
        try:
            bar = idx.loc[(contract, t)]
        except KeyError:
            return None
        return float(bar["low"]), float(bar["high"])
    return f


def summarize(res: Dict[str, Any], times: List[Any], n_ambiguous: int) -> Dict[str, Any]:
    m = metrics(res, times)
    m["ambiguous_trades"] = n_ambiguous
    m["roll_exits"] = sum(1 for x in res["trades"] if x.reason == "ROLL")
    m["trades_per_week"] = round(m["trades"] / max(1, m.get("weeks", 1)), 2)
    return {k: m.get(k) for k in SUMMARY_KEYS} | {"rejected_setups": m["diag"].get("rejected_setups", 0)}
